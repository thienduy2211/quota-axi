import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readCodexPool,
  resolveCodexRegistryPath,
  resolveCpaStateDir,
} from "../../src/providers/codex-pool.js";
import {
  createCodexAdapter,
  fetchQuota,
  inspectAuth,
} from "../../src/providers/codex.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { quotaJsonReport } from "../../src/render.js";
import type { ProviderOptions, QuotaAxiResponse } from "../../src/types.js";

const OPTIONS: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};

describe("Codex CPA pool aggregation", () => {
  let tempDir: string;
  let registryFile: string;
  const initialCodexRegistryPath = process.env.CODEX_REGISTRY_PATH;
  const initialCpaDir = process.env.CPA_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-codex-pool-test-"));
    registryFile = join(tempDir, "registry.json");
    process.env.CODEX_REGISTRY_PATH = registryFile;
    process.env.CPA_DIR = join(tempDir, "empty-cpa");
  });

  afterEach(() => {
    if (initialCodexRegistryPath !== undefined) {
      process.env.CODEX_REGISTRY_PATH = initialCodexRegistryPath;
    } else {
      delete process.env.CODEX_REGISTRY_PATH;
    }
    if (initialCpaDir !== undefined) {
      process.env.CPA_DIR = initialCpaDir;
    } else {
      delete process.env.CPA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves registry path from CODEX_REGISTRY_PATH and CODEX_HOME", () => {
    expect(
      resolveCodexRegistryPath({
        CODEX_REGISTRY_PATH: "/custom/registry.json",
      }),
    ).toBe("/custom/registry.json");
    expect(resolveCodexRegistryPath({ CODEX_HOME: "/custom/codex" })).toBe(
      join("/custom/codex", "accounts", "registry.json"),
    );
  });

  it("returns missing when registry file does not exist", () => {
    const result = readCodexPool({
      registryPath: join(tempDir, "nonexistent.json"),
    });
    expect(result.kind).toBe("missing");
  });

  it("returns malformed when registry JSON is invalid syntax", () => {
    writeFileSync(registryFile, "not-valid-json", "utf8");
    const result = readCodexPool({ registryPath: registryFile });
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.failure.provider).toBe("codex");
      expect(result.failure.accountKey).toBe("codex-home");
      expect(result.failure.state.status).toBe("error");
    }
  });

  it("returns malformed when registry accounts array is empty", () => {
    writeFileSync(registryFile, JSON.stringify({ accounts: [] }), "utf8");
    const result = readCodexPool({ registryPath: registryFile });
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.error).toBe("no_accounts_in_registry");
    }
  });

  it("returns malformed when no account reports valid quota usage", () => {
    const fixture = {
      accounts: [
        {
          account_key: "acc-1",
          email: "user1@example.com",
        },
        {
          account_key: "acc-2",
          email: "user2@example.com",
          last_usage: {},
        },
      ],
    };
    writeFileSync(registryFile, JSON.stringify(fixture), "utf8");
    const result = readCodexPool({ registryPath: registryFile });
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.error).toBe("missing_quota_usage");
    }
  });

  it("aggregates only over accounts reporting each window and omits missing windows from pool accounts", () => {
    const nowS = 1_700_000_000;
    const nowMs = nowS * 1000;

    const fixture = {
      accounts: [
        {
          account_key: "acc-1",
          email: "user1@example.com",
          last_used_at: nowS - 60,
          last_usage: {
            primary: { used_percent: 20, resets_at: nowS + 3600 },
          },
        },
        {
          account_key: "acc-2",
          email: "user2@example.com",
          last_used_at: nowS - 120,
          last_usage: {
            secondary: { used_percent: 40, resets_at: nowS + 7200 },
          },
        },
        {
          account_key: "acc-3",
          email: "user3@example.com",
          last_used_at: nowS - 180,
        },
      ],
    };

    writeFileSync(registryFile, JSON.stringify(fixture), "utf8");

    const result = readCodexPool({ registryPath: registryFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const primary = result.quota.windows.find((w) => w.id === "five_hour");
    expect(primary).toBeDefined();
    expect(primary?.percentRemaining).toBe(80);
    expect(primary?.percentUsed).toBe(20);

    const secondary = result.quota.windows.find((w) => w.id === "weekly");
    expect(secondary).toBeDefined();
    expect(secondary?.percentRemaining).toBe(60);
    expect(secondary?.percentUsed).toBe(40);

    const acc1 = result.quota.pool?.accounts.find(
      (a) => a.accountKey === "acc-1",
    );
    expect(acc1?.windows).toHaveLength(1);
    expect(acc1?.windows[0].id).toBe("five_hour");

    const acc2 = result.quota.pool?.accounts.find(
      (a) => a.accountKey === "acc-2",
    );
    expect(acc2?.windows).toHaveLength(1);
    expect(acc2?.windows[0].id).toBe("weekly");

    const acc3 = result.quota.pool?.accounts.find(
      (a) => a.accountKey === "acc-3",
    );
    expect(acc3?.windows).toHaveLength(0);
  });

  it("aggregates all-healthy pool of 4 accounts accurately", () => {
    const nowS = 1_700_000_000;
    const nowMs = nowS * 1000;

    const fixture = {
      active_account_key: "acc-1",
      auto_switch: { enabled: true },
      accounts: [
        {
          account_key: "acc-1",
          email: "user1@example.com",
          plan: "team",
          last_used_at: nowS - 60,
          last_usage: {
            primary: { used_percent: 10, resets_at: nowS + 3600 },
            secondary: { used_percent: 20, resets_at: nowS + 86400 },
          },
        },
        {
          account_key: "acc-2",
          email: "user2@example.com",
          plan: "team",
          last_used_at: nowS - 120,
          last_usage: {
            primary: { used_percent: 20, resets_at: nowS + 7200 },
            secondary: { used_percent: 30, resets_at: nowS + 172800 },
          },
        },
        {
          account_key: "acc-3",
          email: "user3@example.com",
          plan: "team",
          last_used_at: nowS - 180,
          last_usage: {
            primary: { used_percent: 30, resets_at: nowS + 1800 },
            secondary: { used_percent: 40, resets_at: nowS + 43200 },
          },
        },
        {
          account_key: "acc-4",
          email: "user4@example.com",
          plan: "plus",
          last_used_at: nowS - 240,
          last_usage: {
            primary: { used_percent: 40, resets_at: nowS + 5400 },
            secondary: { used_percent: 50, resets_at: nowS + 259200 },
          },
        },
      ],
    };

    writeFileSync(registryFile, JSON.stringify(fixture), "utf8");

    const result = readCodexPool({ registryPath: registryFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const quota = result.quota;
    expect(quota.provider).toBe("codex");
    expect(quota.accountKey).toBe("codex-home");
    expect(quota.accountKeys).toEqual([
      "codex-home",
      "default",
      "acc-1",
      "acc-2",
      "acc-3",
      "acc-4",
    ]);

    // Primary: remaining = (90 + 80 + 70 + 60) / 4 = 75% -> used = 25%
    const primaryWindow = quota.windows.find((w) => w.id === "five_hour");
    expect(primaryWindow).toBeDefined();
    expect(primaryWindow?.percentRemaining).toBe(75);
    expect(primaryWindow?.percentUsed).toBe(25);
    // Earliest future primary reset is nowS + 1800
    expect(primaryWindow?.resetsAt).toBe(
      new Date((nowS + 1800) * 1000).toISOString(),
    );

    // Secondary: remaining = (80 + 70 + 60 + 50) / 4 = 65% -> used = 35%
    const secondaryWindow = quota.windows.find((w) => w.id === "weekly");
    expect(secondaryWindow).toBeDefined();
    expect(secondaryWindow?.percentRemaining).toBe(65);
    expect(secondaryWindow?.percentUsed).toBe(35);
    // Earliest future secondary reset is nowS + 43200
    expect(secondaryWindow?.resetsAt).toBe(
      new Date((nowS + 43200) * 1000).toISOString(),
    );

    // State & freshness
    expect(quota.state.status).toBe("fresh");
    expect(quota.state.stale).toBe(false);

    // Attempts and pool detail
    expect(quota.attempts).toHaveLength(4);
    expect(quota.attempts?.map((a) => a.source)).toEqual([
      "pool:user1@example.com",
      "pool:user2@example.com",
      "pool:user3@example.com",
      "pool:user4@example.com",
    ]);

    expect(quota.pool).toBeDefined();
    expect(quota.pool?.source).toBe("cpa");
    expect(quota.pool?.activeAccount).toBe("user1@example.com");
    expect(quota.pool?.accounts).toHaveLength(4);
    expect(quota.pool?.accounts[0].status).toBe("available");
  });

  it("preserves pool headline runway when one account is near-empty (vtdtdah001 ~1.4% case)", () => {
    const nowS = 1_700_000_000;
    const nowMs = nowS * 1000;

    const fixture = {
      active_account_key: "acc-1",
      accounts: [
        {
          account_key: "acc-1",
          email: "vtdtdah001@example.com",
          plan: "team",
          last_used_at: nowS - 30,
          last_usage: {
            primary: { used_percent: 50, resets_at: nowS + 3600 },
            secondary: { used_percent: 98.6, resets_at: nowS + 86400 }, // ~1.4% remaining
          },
        },
        {
          account_key: "acc-2",
          email: "healthy1@example.com",
          plan: "team",
          last_used_at: nowS - 60,
          last_usage: {
            primary: { used_percent: 20, resets_at: nowS + 3600 },
            secondary: { used_percent: 20, resets_at: nowS + 86400 }, // 80% remaining
          },
        },
        {
          account_key: "acc-3",
          email: "healthy2@example.com",
          plan: "team",
          last_used_at: nowS - 90,
          last_usage: {
            primary: { used_percent: 10, resets_at: nowS + 3600 },
            secondary: { used_percent: 10, resets_at: nowS + 86400 }, // 90% remaining
          },
        },
        {
          account_key: "acc-4",
          email: "healthy3@example.com",
          plan: "team",
          last_used_at: nowS - 120,
          last_usage: {
            primary: { used_percent: 30, resets_at: nowS + 3600 },
            secondary: { used_percent: 30, resets_at: nowS + 86400 }, // 70% remaining
          },
        },
      ],
    };

    writeFileSync(registryFile, JSON.stringify(fixture), "utf8");

    const result = readCodexPool({ registryPath: registryFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const weekly = result.quota.windows.find((w) => w.id === "weekly");
    expect(weekly).toBeDefined();
    // Sum remaining: 1.4 + 80 + 90 + 70 = 241.4 -> / 4 = 60.35% (clamp 60%)
    expect(weekly?.percentRemaining).toBe(60);
    // Headline does NOT collapse to 1% or 1.4%
    expect(weekly?.percentRemaining).toBeGreaterThan(50);
  });

  it("marks pool cache stale when usage is older than one hour", () => {
    const nowS = 1_700_000_000;
    const nowMs = nowS * 1000;
    const staleUsageS = nowS - 4000; // > 3600s ago

    const fixture = {
      accounts: [
        {
          account_key: "acc-1",
          email: "user@example.com",
          last_used_at: staleUsageS,
          last_usage: {
            primary: { used_percent: 10, resets_at: nowS + 3600 },
            secondary: { used_percent: 20, resets_at: nowS + 86400 },
          },
        },
      ],
    };

    writeFileSync(registryFile, JSON.stringify(fixture), "utf8");

    const result = readCodexPool({ registryPath: registryFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.quota.state.stale).toBe(true);
    expect(result.quota.state.status).toBe("stale");
  });

  it("marks pool cache stale when lastUsageAt is absent across accounts", () => {
    const nowS = 1_700_000_000;
    const nowMs = nowS * 1000;

    const fixture = {
      accounts: [
        {
          account_key: "acc-1",
          email: "user@example.com",
          last_usage: {
            primary: { used_percent: 10, resets_at: nowS + 3600 },
            secondary: { used_percent: 20, resets_at: nowS + 86400 },
          },
        },
      ],
    };

    writeFileSync(registryFile, JSON.stringify(fixture), "utf8");

    const result = readCodexPool({ registryPath: registryFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.quota.state.stale).toBe(true);
    expect(result.quota.state.status).toBe("stale");
  });

  it("never parses, retains, logs, or renders credential fields", () => {
    const fixture = {
      accounts: [
        {
          account_key: "acc-1",
          email: "safe@example.com",
          token: "POISON_TOKEN_SECRET_DO_NOT_LEAK",
          id_token: "POISON_ID_TOKEN_SECRET_DO_NOT_LEAK",
          refresh_token: "POISON_REFRESH_TOKEN_DO_NOT_LEAK",
          password: "POISON_PASSWORD_DO_NOT_LEAK",
          last_used_at: 1_700_000_000,
          last_usage: {
            primary: { used_percent: 10 },
            secondary: { used_percent: 20 },
          },
        },
      ],
    };

    writeFileSync(registryFile, JSON.stringify(fixture), "utf8");

    const result = readCodexPool({ registryPath: registryFile });
    expect(result.kind).toBe("success");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("POISON");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("TOKEN");
  });

  it("integrates with codexAdapter, fetchQuota, discoverCodexAccounts, and inspectAuth", async () => {
    const fixture = {
      active_account_key: "acc-1",
      accounts: [
        {
          account_key: "acc-1",
          email: "pool-user@example.com",
          plan: "team",
          last_used_at: Math.floor(Date.now() / 1000),
          last_usage: {
            primary: { used_percent: 15 },
            secondary: { used_percent: 25 },
          },
        },
      ],
    };

    writeFileSync(registryFile, JSON.stringify(fixture), "utf8");

    const adapter = createCodexAdapter();
    // When pool registry exists, discoverAccounts must return undefined
    const accounts = await adapter.discoverAccounts?.();
    expect(accounts).toBeUndefined();

    // fetchQuota returns pool quota
    const quota = await fetchQuota(OPTIONS);
    expect(quota.provider).toBe("codex");
    expect(quota.accountKey).toBe("codex-home");
    expect(
      quota.windows.find((w) => w.id === "five_hour")?.percentRemaining,
    ).toBe(85);

    // inspectAuth includes pool-registry source
    const authReport = await inspectAuth(OPTIONS);
    expect(authReport.provider).toBe("codex");
    const poolSource = authReport.sources.find(
      (s) => s.source === "pool-registry",
    );
    expect(poolSource).toBeDefined();
    expect(poolSource?.status).toBe("available");
    expect(poolSource?.path).toBe(registryFile);
  });

  it("preserves consumer compatibility with schema 5 and schema 6 in quotaJsonReport", () => {
    const fixture = {
      active_account_key: "acc-1",
      accounts: [
        {
          account_key: "acc-1",
          email: "user@example.com",
          plan: "team",
          last_used_at: Math.floor(Date.now() / 1000),
          last_usage: {
            primary: { used_percent: 20 },
            secondary: { used_percent: 30 },
          },
        },
      ],
    };
    writeFileSync(registryFile, JSON.stringify(fixture), "utf8");

    const poolResult = readCodexPool({ registryPath: registryFile });
    expect(poolResult.kind).toBe("success");
    if (poolResult.kind !== "success") return;

    const interpreted = withQuotaSemantics(
      poolResult.quota,
      new Date().toISOString(),
    );

    // Schema 5: unique provider
    const response5: QuotaAxiResponse = {
      generatedAt: new Date().toISOString(),
      schemaVersion: 5,
      providers: [interpreted],
    };

    const minimalJson5 = quotaJsonReport(response5, false);
    expect(minimalJson5.schemaVersion).toBe(5);
    expect(minimalJson5.providers[0].provider).toBe("codex");
    expect(minimalJson5.providers[0].accountKey).toBe("codex-home");
    // pool detail is demoted in minimal default --json
    expect(minimalJson5.providers[0].pool).toBeUndefined();

    const fullJson5 = quotaJsonReport(response5, true);
    // pool detail is preserved in --full --json
    expect(fullJson5.providers[0].pool).toBeDefined();
    expect(fullJson5.providers[0].pool?.source).toBe("cpa");

    // Schema 6: unique [provider, accountKey]
    const response6: QuotaAxiResponse = {
      generatedAt: new Date().toISOString(),
      schemaVersion: 6,
      providers: [interpreted],
    };
    const minimalJson6 = quotaJsonReport(response6, false);
    expect(minimalJson6.schemaVersion).toBe(6);
    expect(minimalJson6.providers[0].accountKey).toBe("codex-home");
  });

  it("resolves CPA state directory from CPA_DIR, CLI_PROXY_API_DIR, or default ~/.cli-proxy-api", () => {
    expect(resolveCpaStateDir({ CPA_DIR: "/custom/cpa" })).toBe("/custom/cpa");
    expect(resolveCpaStateDir({ CLI_PROXY_API_DIR: "/custom/cli-proxy" })).toBe(
      "/custom/cli-proxy",
    );
  });

  it("fixture .cds dir with one cooling + one active credential yields earliest recovery = the cooling credential's time", () => {
    const cpaDir = join(tempDir, "cpa-cooling-active");
    mkdirSync(cpaDir, { recursive: true });

    const coolingTime = "2026-10-10T14:17:55.000Z";
    const coolingFixture = {
      version: 1,
      auth_id: "codex-cooling@example.com-team.json",
      provider: "codex",
      records: [
        {
          provider: "codex",
          auth_id: "codex-cooling@example.com-team.json",
          status: "cooling",
          next_retry_after: coolingTime,
          quota: {
            exceeded: true,
            next_recover_at: coolingTime,
          },
        },
      ],
    };

    const activeFixture = {
      version: 1,
      auth_id: "codex-active@example.com-team.json",
      provider: "codex",
      status: "active",
      records: [
        {
          provider: "codex",
          auth_id: "codex-active@example.com-team.json",
          status: "active",
        },
      ],
    };

    writeFileSync(
      join(cpaDir, "codex-cooling.cds"),
      JSON.stringify(coolingFixture),
      "utf8",
    );
    writeFileSync(
      join(cpaDir, "codex-active.cds"),
      JSON.stringify(activeFixture),
      "utf8",
    );

    const result = readCodexPool({ cpaDir });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.source).toBe("cpa");
    expect(result.path).toBe(cpaDir);

    // Headline window reports earliest recovery = cooling credential's time
    const headline = result.quota.windows[0];
    expect(headline).toBeDefined();
    expect(headline.id).toBe("pool");
    expect(headline.resetsAt).toBe(coolingTime);
    expect(headline.percentUsed).toBeUndefined();
    expect(headline.percentRemaining).toBeUndefined();

    // Pool detail surfaces per-credential state
    expect(result.quota.pool?.source).toBe("cpa");
    expect(result.quota.pool?.accounts).toHaveLength(2);

    const coolingAccount = result.quota.pool?.accounts.find(
      (a) => a.accountKey === "codex-cooling@example.com-team.json",
    );
    expect(coolingAccount).toBeDefined();
    expect(coolingAccount?.status).toBe("cooling");
    expect(coolingAccount?.nextRecoverAt).toBe(coolingTime);
    expect(coolingAccount?.nextRetryAfter).toBe(coolingTime);
    expect(coolingAccount?.windows[0]?.resetsAt).toBe(coolingTime);
    expect(coolingAccount?.windows[0]?.percentRemaining).toBeUndefined();

    const activeAccount = result.quota.pool?.accounts.find(
      (a) => a.accountKey === "codex-active@example.com-team.json",
    );
    expect(activeAccount).toBeDefined();
    expect(activeAccount?.status).toBe("active");
    expect(activeAccount?.windows[0]?.resetText).toBe("pool serving");
    expect(activeAccount?.windows[0]?.percentRemaining).toBeUndefined();

    // State is fresh because at least one credential is active/serving
    expect(result.quota.state.status).toBe("fresh");
    expect(result.quota.state.stale).toBe(false);

    // Attempts reflects cooling skipped vs active success
    const coolingAttempt = result.quota.attempts?.find((a) =>
      a.source.includes("codex-cooling"),
    );
    expect(coolingAttempt?.status).toBe("skipped");
    expect(coolingAttempt?.error).toBe("cooling");

    const activeAttempt = result.quota.attempts?.find((a) =>
      a.source.includes("codex-active"),
    );
    expect(activeAttempt?.status).toBe("success");
  });

  it("all-active yields healthy", () => {
    const cpaDir = join(tempDir, "cpa-all-active");
    mkdirSync(cpaDir, { recursive: true });

    writeFileSync(
      join(cpaDir, "codex-active1.cds"),
      JSON.stringify({
        version: 1,
        auth_id: "codex-1@example.com.json",
        provider: "codex",
        status: "active",
      }),
      "utf8",
    );
    writeFileSync(
      join(cpaDir, "codex-active2.cds"),
      JSON.stringify({
        version: 1,
        auth_id: "codex-2@example.com.json",
        provider: "codex",
        status: "active",
      }),
      "utf8",
    );

    const result = readCodexPool({ cpaDir });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.source).toBe("cpa");
    expect(result.quota.state.status).toBe("fresh");
    expect(result.quota.state.stale).toBe(false);

    // Headline reports serving when nothing is cooling
    const headline = result.quota.windows[0];
    expect(headline).toBeDefined();
    expect(headline.resetsAt).toBeUndefined();
    expect(headline.resetText).toBe("pool serving");
    expect(headline.percentUsed).toBeUndefined();
    expect(headline.percentRemaining).toBeUndefined();

    expect(result.quota.pool?.accounts).toHaveLength(2);
    expect(
      result.quota.pool?.accounts.every((a) => a.status === "active"),
    ).toBe(true);
  });

  it("no .cds dir yields the registry fallback", () => {
    const nonexistentCpaDir = join(tempDir, "nonexistent-cpa");
    const fallbackRegistry = join(tempDir, "fallback-registry.json");
    writeFileSync(
      fallbackRegistry,
      JSON.stringify({
        accounts: [
          {
            account_key: "fallback-acc",
            email: "fallback@example.com",
            last_used_at: 1_700_000_000,
            last_usage: {
              primary: { used_percent: 15, resets_at: 1_700_003_600 },
            },
          },
        ],
      }),
      "utf8",
    );

    const result = readCodexPool({
      cpaDir: nonexistentCpaDir,
      registryPath: fallbackRegistry,
      nowMs: 1_700_000_000 * 1000,
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.source).toBe("registry");
    expect(result.path).toBe(fallbackRegistry);
    expect(result.quota.accountKeys).toContain("fallback-acc");
    expect(result.quota.windows.some((w) => w.id === "five_hour")).toBe(true);
  });

  it("malformed .cds degrades to a marked unavailable state, never crashes or fabricates", () => {
    const cpaDir = join(tempDir, "cpa-malformed");
    mkdirSync(cpaDir, { recursive: true });

    writeFileSync(
      join(cpaDir, "codex-corrupt.cds"),
      "INVALID_NON_JSON_CORRUPTED_CONTENT",
      "utf8",
    );

    const result = readCodexPool({ cpaDir });
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.failure.provider).toBe("codex");
      expect(result.failure.state.status).toBe("unavailable");
      expect(result.failure.state.error).toContain("malformed");
    }

    // Beside a valid credential, malformed credential marks unavailable without crashing
    writeFileSync(
      join(cpaDir, "codex-healthy.cds"),
      JSON.stringify({
        version: 1,
        auth_id: "codex-healthy@example.com.json",
        provider: "codex",
        status: "active",
      }),
      "utf8",
    );

    const mixedResult = readCodexPool({ cpaDir });
    expect(mixedResult.kind).toBe("success");
    if (mixedResult.kind !== "success") return;

    const corruptAccount = mixedResult.quota.pool?.accounts.find(
      (a) => a.accountKey === "codex-corrupt",
    );
    expect(corruptAccount?.status).toBe("unavailable");

    const healthyAccount = mixedResult.quota.pool?.accounts.find(
      (a) => a.accountKey === "codex-healthy@example.com.json",
    );
    expect(healthyAccount?.status).toBe("active");
  });

  it("all-cooling CPA pool marks state unavailable with earliest recovery headline", () => {
    const cpaDir = join(tempDir, "cpa-all-cooling");
    mkdirSync(cpaDir, { recursive: true });

    const tEarlier = "2026-10-06T14:27:34.000Z";
    const tLater = "2026-10-10T14:17:55.000Z";

    writeFileSync(
      join(cpaDir, "codex-1.cds"),
      JSON.stringify({
        auth_id: "codex-1.json",
        provider: "codex",
        records: [
          {
            status: "cooling",
            next_retry_after: tLater,
            quota: { exceeded: true, next_recover_at: tLater },
          },
        ],
      }),
      "utf8",
    );

    writeFileSync(
      join(cpaDir, "codex-2.cds"),
      JSON.stringify({
        auth_id: "codex-2.json",
        provider: "codex",
        records: [
          {
            status: "cooling",
            next_retry_after: tEarlier,
            quota: { exceeded: true, next_recover_at: tEarlier },
          },
        ],
      }),
      "utf8",
    );

    const result = readCodexPool({ cpaDir });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.quota.state.status).toBe("unavailable");
    expect(result.quota.windows[0].resetsAt).toBe(tEarlier);
    expect(result.quota.pool?.accounts).toHaveLength(2);
    expect(
      result.quota.pool?.accounts.every((a) => a.status === "cooling"),
    ).toBe(true);
  });

  it("never parses, retains, logs, or renders credential fields from CPA .cds files", () => {
    const cpaDir = join(tempDir, "cpa-poison");
    mkdirSync(cpaDir, { recursive: true });

    writeFileSync(
      join(cpaDir, "codex-poison.cds"),
      JSON.stringify({
        auth_id: "codex-safe-id.json",
        provider: "codex",
        token: "POISON_TOKEN_SECRET_DO_NOT_LEAK",
        access_token: "POISON_ACCESS_TOKEN_SECRET_DO_NOT_LEAK",
        refresh_token: "POISON_REFRESH_TOKEN_SECRET_DO_NOT_LEAK",
        password: "POISON_PASSWORD_SECRET_DO_NOT_LEAK",
        api_key: "POISON_API_KEY_SECRET_DO_NOT_LEAK",
        status: "active",
      }),
      "utf8",
    );

    const result = readCodexPool({ cpaDir });
    expect(result.kind).toBe("success");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("POISON");
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("TOKEN");
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("access_token");
  });

  it("ignores non-codex .cds files in CPA directory and falls back when no codex files exist", () => {
    const cpaDir = join(tempDir, "cpa-claude-only");
    mkdirSync(cpaDir, { recursive: true });

    writeFileSync(
      join(cpaDir, "claude-session.cds"),
      JSON.stringify({
        auth_id: "claude-1.json",
        provider: "claude",
        status: "active",
      }),
      "utf8",
    );

    const fallbackRegistry = join(tempDir, "claude-fallback-registry.json");
    writeFileSync(
      fallbackRegistry,
      JSON.stringify({
        accounts: [
          {
            account_key: "acc-fallback",
            email: "user@example.com",
            last_used_at: 1_700_000_000,
            last_usage: {
              primary: { used_percent: 20 },
            },
          },
        ],
      }),
      "utf8",
    );

    const result = readCodexPool({
      cpaDir,
      registryPath: fallbackRegistry,
      nowMs: 1_700_000_000 * 1000,
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.source).toBe("registry");
  });

  it("integrates CPA pool with codexAdapter, fetchQuota, discoverCodexAccounts, and inspectAuth", async () => {
    const cpaDir = join(tempDir, "cpa-integration");
    mkdirSync(cpaDir, { recursive: true });
    process.env.CPA_DIR = cpaDir;

    writeFileSync(
      join(cpaDir, "codex-cpa.cds"),
      JSON.stringify({
        auth_id: "codex-integration@example.com.json",
        provider: "codex",
        status: "active",
      }),
      "utf8",
    );

    const adapter = createCodexAdapter();
    const accounts = await adapter.discoverAccounts?.();
    expect(accounts).toBeUndefined();

    const quota = await fetchQuota(OPTIONS);
    expect(quota.provider).toBe("codex");
    expect(quota.accountKey).toBe("codex-home");
    expect(quota.windows[0].resetText).toBe("pool serving");
    expect(quota.pool?.source).toBe("cpa");

    const authReport = await inspectAuth(OPTIONS);
    expect(authReport.provider).toBe("codex");
    const poolSource = authReport.sources.find((s) => s.source === "cpa");
    expect(poolSource).toBeDefined();
    expect(poolSource?.status).toBe("available");
    expect(poolSource?.path).toBe(cpaDir);
  });
});
