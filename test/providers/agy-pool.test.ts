import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readAgyMultiPool,
  resolveAgyMultiStatePath,
} from "../../src/providers/agy-pool.js";
import { fetchQuota, inspectAuth } from "../../src/providers/agy.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { quotaJsonReport } from "../../src/render.js";
import type { ProviderOptions, QuotaAxiResponse } from "../../src/types.js";

const OPTIONS: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};

describe("Antigravity agy-multi pool aggregation", () => {
  let tempDir: string;
  let stateFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-agy-pool-test-"));
    stateFile = join(tempDir, "state.json");
    process.env.AGY_MULTI_STATE_PATH = stateFile;
  });

  afterEach(() => {
    delete process.env.AGY_MULTI_STATE_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves state path from AGY_MULTI_STATE_PATH and XDG_DATA_HOME", () => {
    expect(
      resolveAgyMultiStatePath({ AGY_MULTI_STATE_PATH: "/custom/state.json" }),
    ).toBe("/custom/state.json");
    expect(resolveAgyMultiStatePath({ XDG_DATA_HOME: "/custom/share" })).toBe(
      join("/custom/share", "agy-multi", "state.json"),
    );
  });

  it("returns missing when state file does not exist", () => {
    const result = readAgyMultiPool({
      statePath: join(tempDir, "nonexistent.json"),
    });
    expect(result.kind).toBe("missing");
  });

  it("returns malformed when state JSON is invalid syntax", () => {
    writeFileSync(stateFile, "not-valid-json", "utf8");
    const result = readAgyMultiPool({ statePath: stateFile });
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.failure.provider).toBe("agy");
      expect(result.failure.state.status).toBe("error");
      expect(result.failure.accountKeys).toEqual(["default"]);
    }
  });

  it("returns malformed when state quotaCache is missing or empty", () => {
    writeFileSync(stateFile, JSON.stringify({ active: "a@b.com" }), "utf8");
    const result = readAgyMultiPool({ statePath: stateFile });
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.error).toBe("missing_quota_cache");
    }
  });

  it("aggregates all-healthy pool of 5 accounts across all 4 headline windows", () => {
    const nowMs = 1_700_000_000_000;

    const fixture = {
      active: "user1@example.com",
      quotaCache: {
        "user1@example.com": {
          fetchedMs: nowMs - 60_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.8, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.7, resetMs: nowMs + 86400_000 },
            },
            "3p": {
              "5h": { fraction: 0.9, resetMs: nowMs + 7200_000 },
              weekly: { fraction: 0.85, resetMs: nowMs + 172800_000 },
            },
          },
        },
        "user2@example.com": {
          fetchedMs: nowMs - 120_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.6, resetMs: nowMs + 1800_000 },
              weekly: { fraction: 0.5, resetMs: nowMs + 43200_000 },
            },
            "3p": {
              "5h": { fraction: 0.7, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.65, resetMs: nowMs + 86400_000 },
            },
          },
        },
        "user3@example.com": {
          fetchedMs: nowMs - 180_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.9, resetMs: nowMs + 5400_000 },
              weekly: { fraction: 0.8, resetMs: nowMs + 129600_000 },
            },
            "3p": {
              "5h": { fraction: 0.95, resetMs: nowMs + 9000_000 },
              weekly: { fraction: 0.9, resetMs: nowMs + 216000_000 },
            },
          },
        },
        "user4@example.com": {
          fetchedMs: nowMs - 240_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.7, resetMs: nowMs + 4500_000 },
              weekly: { fraction: 0.6, resetMs: nowMs + 64800_000 },
            },
            "3p": {
              "5h": { fraction: 0.8, resetMs: nowMs + 8100_000 },
              weekly: { fraction: 0.75, resetMs: nowMs + 151200_000 },
            },
          },
        },
        "user5@example.com": {
          fetchedMs: nowMs - 300_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.5, resetMs: nowMs + 2700_000 },
              weekly: { fraction: 0.4, resetMs: nowMs + 54000_000 },
            },
            "3p": {
              "5h": { fraction: 0.65, resetMs: nowMs + 4500_000 },
              weekly: { fraction: 0.6, resetMs: nowMs + 108000_000 },
            },
          },
        },
      },
    };

    writeFileSync(stateFile, JSON.stringify(fixture), "utf8");

    const result = readAgyMultiPool({ statePath: stateFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const quota = result.quota;
    expect(quota.provider).toBe("agy");
    expect(quota.accountKeys).toEqual([
      "default",
      "user1@example.com",
      "user2@example.com",
      "user3@example.com",
      "user4@example.com",
      "user5@example.com",
    ]);

    // gemini_5h: fractions [0.8, 0.6, 0.9, 0.7, 0.5] -> remaining [80, 60, 90, 70, 50] -> avg = 70%
    const g5h = quota.windows.find((w) => w.id === "gemini_5h");
    expect(g5h).toBeDefined();
    expect(g5h?.percentRemaining).toBe(70);
    expect(g5h?.percentUsed).toBe(30);
    // Earliest reset: min(3600, 1800, 5400, 4500, 2700) = 1800
    expect(g5h?.resetsAt).toBe(new Date(nowMs + 1800_000).toISOString());

    // gemini_weekly: fractions [0.7, 0.5, 0.8, 0.6, 0.4] -> remaining [70, 50, 80, 60, 40] -> avg = 60%
    const gw = quota.windows.find((w) => w.id === "gemini_weekly");
    expect(gw).toBeDefined();
    expect(gw?.percentRemaining).toBe(60);
    expect(gw?.percentUsed).toBe(40);
    // Earliest reset: min(86400, 43200, 129600, 64800, 54000) = 43200
    expect(gw?.resetsAt).toBe(new Date(nowMs + 43200_000).toISOString());

    // claude_gpt_5h: fractions [0.9, 0.7, 0.95, 0.8, 0.65] -> remaining [90, 70, 95, 80, 65] -> avg = 80%
    const c5h = quota.windows.find((w) => w.id === "claude_gpt_5h");
    expect(c5h).toBeDefined();
    expect(c5h?.percentRemaining).toBe(80);
    expect(c5h?.percentUsed).toBe(20);

    // claude_gpt_weekly: fractions [0.85, 0.65, 0.9, 0.75, 0.6] -> remaining [85, 65, 90, 75, 60] -> avg = 75%
    const cw = quota.windows.find((w) => w.id === "claude_gpt_weekly");
    expect(cw).toBeDefined();
    expect(cw?.percentRemaining).toBe(75);
    expect(cw?.percentUsed).toBe(25);

    expect(quota.state.status).toBe("fresh");
    expect(quota.state.stale).toBe(false);

    // Attempts and pool detail
    expect(quota.attempts).toHaveLength(5);
    expect(quota.attempts?.every((a) => a.status === "success")).toBe(true);

    expect(quota.pool).toBeDefined();
    expect(quota.pool?.source).toBe("agy-multi");
    expect(quota.pool?.activeAccount).toBe("user1@example.com");
    expect(quota.pool?.accounts).toHaveLength(5);
  });

  it("preserves pool headline runway when one account is near-empty (vtdtdah001 ~1.4% case)", () => {
    const nowMs = 1_700_000_000_000;

    const fixture = {
      active: "vtdtdah001@example.com",
      quotaCache: {
        "vtdtdah001@example.com": {
          fetchedMs: nowMs - 60_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.5, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.014, resetMs: nowMs + 86400_000 }, // ~1.4% remaining
            },
          },
        },
        "user2@example.com": {
          fetchedMs: nowMs - 60_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.8, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.9, resetMs: nowMs + 86400_000 }, // 90%
            },
          },
        },
        "user3@example.com": {
          fetchedMs: nowMs - 60_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.8, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.85, resetMs: nowMs + 86400_000 }, // 85%
            },
          },
        },
        "user4@example.com": {
          fetchedMs: nowMs - 60_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.8, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.8, resetMs: nowMs + 86400_000 }, // 80%
            },
          },
        },
        "user5@example.com": {
          fetchedMs: nowMs - 60_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.8, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.75, resetMs: nowMs + 86400_000 }, // 75%
            },
          },
        },
      },
    };

    writeFileSync(stateFile, JSON.stringify(fixture), "utf8");

    const result = readAgyMultiPool({ statePath: stateFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    const gw = result.quota.windows.find((w) => w.id === "gemini_weekly");
    expect(gw).toBeDefined();
    // Sum: 1.4 + 90 + 85 + 80 + 75 = 331.4 / 5 = 66.28 -> clamp 66%
    expect(gw?.percentRemaining).toBe(66);
    expect(gw?.percentRemaining).toBeGreaterThan(50);
  });

  it("handles in-cooldown accounts by contributing usage while marking unavailable", () => {
    const nowMs = 1_700_000_000_000;

    const fixture = {
      active: "user1@example.com",
      cooldowns: {
        "user1@example.com": {
          gemini: nowMs + 3600_000, // in cooldown for gemini
        },
        "user2@example.com": {
          gemini: nowMs + 3600_000,
          "3p": nowMs + 3600_000, // in cooldown for both
        },
      },
      quotaCache: {
        "user1@example.com": {
          fetchedMs: nowMs - 30_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.5, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.5, resetMs: nowMs + 86400_000 },
            },
          },
        },
        "user2@example.com": {
          fetchedMs: nowMs - 30_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.3, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.3, resetMs: nowMs + 86400_000 },
            },
          },
        },
        "user3@example.com": {
          fetchedMs: nowMs - 30_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.9, resetMs: nowMs + 3600_000 },
              weekly: { fraction: 0.9, resetMs: nowMs + 86400_000 },
            },
          },
        },
      },
    };

    writeFileSync(stateFile, JSON.stringify(fixture), "utf8");

    const result = readAgyMultiPool({ statePath: stateFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    // Usage from user1 and user2 still contributes to pool sum
    const g5h = result.quota.windows.find((w) => w.id === "gemini_5h");
    // (50 + 30 + 90) / 3 = 170 / 3 = 56.66 -> clamp 57%
    expect(g5h?.percentRemaining).toBe(57);

    // user2 is in cooldown for both groups: attempt is skipped with error "in_cooldown"
    const user2Attempt = result.quota.attempts?.find(
      (a) => a.source === "pool:user2@example.com",
    );
    expect(user2Attempt?.status).toBe("skipped");
    expect(user2Attempt?.error).toBe("in_cooldown");

    // user1 is in cooldown for gemini only: attempt has status "success" with error "cooldown:gemini"
    const user1Attempt = result.quota.attempts?.find(
      (a) => a.source === "pool:user1@example.com",
    );
    expect(user1Attempt?.status).toBe("success");
    expect(user1Attempt?.error).toBe("cooldown:gemini");

    // Pool detail marks user2 unavailable
    const user2Detail = result.quota.pool?.accounts.find(
      (a) => a.email === "user2@example.com",
    );
    expect(user2Detail?.status).toBe("unavailable");
    expect(user2Detail?.cooldowns).toBeDefined();

    // Pool detail marks user1 available (has other capacity)
    const user1Detail = result.quota.pool?.accounts.find(
      (a) => a.email === "user1@example.com",
    );
    expect(user1Detail?.status).toBe("available");
  });

  it("marks pool unavailable when all accounts are in full cooldown", () => {
    const nowMs = 1_700_000_000_000;

    const fixture = {
      active: "user1@example.com",
      cooldowns: {
        "user1@example.com": {
          gemini: nowMs + 3600_000,
          "3p": nowMs + 3600_000,
        },
      },
      quotaCache: {
        "user1@example.com": {
          fetchedMs: nowMs - 30_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.5, resetMs: nowMs + 3600_000 },
            },
          },
        },
      },
    };

    writeFileSync(stateFile, JSON.stringify(fixture), "utf8");

    const result = readAgyMultiPool({ statePath: stateFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.quota.state.status).toBe("unavailable");
    expect(result.quota.state.error).toContain("cooldown");
  });

  it("marks pool cache stale when fetchedMs is older than one hour", () => {
    const nowMs = 1_700_000_000_000;
    const oldFetchedMs = nowMs - 4000 * 1000; // > 3600s ago

    const fixture = {
      active: "user1@example.com",
      quotaCache: {
        "user1@example.com": {
          fetchedMs: oldFetchedMs,
          groups: {
            gemini: {
              "5h": { fraction: 0.8, resetMs: nowMs + 3600_000 },
            },
          },
        },
      },
    };

    writeFileSync(stateFile, JSON.stringify(fixture), "utf8");

    const result = readAgyMultiPool({ statePath: stateFile, nowMs });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;

    expect(result.quota.state.stale).toBe(true);
    expect(result.quota.state.status).toBe("stale");
  });

  it("never touches per-account credential files or parses token fields", () => {
    const accountsDir = join(tempDir, "accounts");
    mkdirSync(accountsDir, { recursive: true });
    // Write toxic account credential files
    writeFileSync(
      join(accountsDir, "user1.json"),
      JSON.stringify({
        token: "SECRET_TOKEN_DO_NOT_READ",
        id_token: "SECRET_ID_TOKEN_DO_NOT_READ",
      }),
      "utf8",
    );

    const fixture = {
      active: "user1@example.com",
      token: "ROOT_SECRET_DO_NOT_READ",
      quotaCache: {
        "user1@example.com": {
          token: "CACHE_SECRET_TOKEN",
          fetchedMs: 1_700_000_000_000,
          groups: {
            gemini: {
              "5h": { fraction: 0.8 },
            },
          },
        },
      },
    };

    writeFileSync(stateFile, JSON.stringify(fixture), "utf8");

    const result = readAgyMultiPool({ statePath: stateFile });
    expect(result.kind).toBe("success");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("SECRET_ID_TOKEN");
    expect(serialized).not.toContain("ROOT_SECRET");
    expect(serialized).not.toContain("CACHE_SECRET");
  });

  it("integrates with fetchQuota and inspectAuth", async () => {
    const fixture = {
      active: "user1@example.com",
      quotaCache: {
        "user1@example.com": {
          fetchedMs: Date.now(),
          groups: {
            gemini: {
              "5h": { fraction: 0.85 },
            },
          },
        },
      },
    };

    writeFileSync(stateFile, JSON.stringify(fixture), "utf8");

    const quota = await fetchQuota(OPTIONS);
    expect(quota.provider).toBe("agy");
    expect(quota.accountKeys).toContain("default");
    expect(quota.accountKeys).toContain("user1@example.com");
    expect(
      quota.windows.find((w) => w.id === "gemini_5h")?.percentRemaining,
    ).toBe(85);

    const authReport = await inspectAuth(OPTIONS);
    expect(authReport.provider).toBe("agy");
    expect(authReport.sources[0].source).toBe("pool-state");
    expect(authReport.sources[0].status).toBe("available");
    expect(authReport.sources[0].path).toBe(stateFile);
  });

  it("preserves consumer compatibility with schema 5 and schema 6 in quotaJsonReport", () => {
    const fixture = {
      active: "user1@example.com",
      quotaCache: {
        "user1@example.com": {
          fetchedMs: Date.now(),
          groups: {
            gemini: {
              "5h": { fraction: 0.75, resetMs: Date.now() + 3600_000 },
              weekly: { fraction: 0.65, resetMs: Date.now() + 86400_000 },
            },
            "3p": {
              "5h": { fraction: 0.85, resetMs: Date.now() + 3600_000 },
              weekly: { fraction: 0.75, resetMs: Date.now() + 86400_000 },
            },
          },
        },
      },
    };
    writeFileSync(stateFile, JSON.stringify(fixture), "utf8");

    const poolResult = readAgyMultiPool({ statePath: stateFile });
    expect(poolResult.kind).toBe("success");
    if (poolResult.kind !== "success") return;

    const interpreted = withQuotaSemantics(
      poolResult.quota,
      new Date().toISOString(),
    );

    // Schema 5
    const response5: QuotaAxiResponse = {
      generatedAt: new Date().toISOString(),
      schemaVersion: 5,
      providers: [interpreted],
    };
    const minimalJson5 = quotaJsonReport(response5, false);
    expect(minimalJson5.schemaVersion).toBe(5);
    expect(minimalJson5.providers[0].provider).toBe("agy");
    expect(minimalJson5.providers[0].pool).toBeUndefined();

    const fullJson5 = quotaJsonReport(response5, true);
    expect(fullJson5.providers[0].pool).toBeDefined();
    expect(fullJson5.providers[0].pool?.source).toBe("agy-multi");

    // Schema 6
    const response6: QuotaAxiResponse = {
      generatedAt: new Date().toISOString(),
      schemaVersion: 6,
      providers: [interpreted],
    };
    const minimalJson6 = quotaJsonReport(response6, false);
    expect(minimalJson6.schemaVersion).toBe(6);
    expect(minimalJson6.providers[0].accountKeys).toContain("default");

    // Semantics status
    expect(interpreted.quotaSemantics?.status).toBe("known");
    const geminiAvail = interpreted.quotaSemantics?.effectiveAvailability.find(
      (a) => a.scope === "gemini",
    );
    expect(geminiAvail?.effectivePercentRemaining).toBe(65); // min(75, 65)
  });
});
