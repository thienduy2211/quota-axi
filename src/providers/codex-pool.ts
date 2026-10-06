import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import { clampPercent, nowIso, parseEpochOrIso } from "../lib/time.js";
import type {
  PoolAccountDetail,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames } from "./common.js";

const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const STALE_MS = 60 * 60 * 1_000; // 1 hour

export function resolveCodexRegistryPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = environment.CODEX_REGISTRY_PATH?.trim();
  if (explicit) return explicit;
  const codexHome = environment.CODEX_HOME?.trim();
  if (codexHome) return join(codexHome, "accounts", "registry.json");
  return join(homedir(), ".codex", "accounts", "registry.json");
}

export function resolveCpaStateDir(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = environment.CPA_DIR?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".cli-proxy-api");
}

export type CodexPoolResult =
  | { kind: "missing" }
  | {
      kind: "malformed";
      error: string;
      failure: ProviderQuota;
      source?: "cpa" | "registry";
      path?: string;
    }
  | {
      kind: "success";
      quota: ProviderQuota;
      source?: "cpa" | "registry";
      path?: string;
    };

type RawCodexAccount = {
  account_key?: unknown;
  email?: unknown;
  plan?: unknown;
  auth_mode?: unknown;
  last_used_at?: unknown;
  last_usage_at?: unknown;
  last_usage?: {
    primary?: {
      used_percent?: unknown;
      window_minutes?: unknown;
      resets_at?: unknown;
    };
    secondary?: {
      used_percent?: unknown;
      window_minutes?: unknown;
      resets_at?: unknown;
    };
    credits?: {
      has_credits?: unknown;
      unlimited?: unknown;
      balance?: unknown;
    };
    plan_type?: unknown;
  };
};

export function readCodexPool(
  options: {
    registryPath?: string;
    cpaDir?: string;
    environment?: NodeJS.ProcessEnv;
    nowMs?: number;
  } = {},
): CodexPoolResult {
  const environment = options.environment ?? process.env;
  const nowMs = options.nowMs ?? Date.now();

  const testRegistryExplicit =
    options.registryPath !== undefined && options.cpaDir === undefined;

  if (!testRegistryExplicit) {
    const cpaDir = options.cpaDir ?? resolveCpaStateDir(environment);
    let entries: string[];
    try {
      entries = readdirSync(cpaDir);
    } catch {
      entries = [];
    }

    const cdsFiles = entries.filter((e) => e.endsWith(".cds")).sort();
    if (cdsFiles.length > 0) {
      type ParsedCpaAccount = {
        authId: string;
        accountKey: string;
        email?: string;
        plan?: string;
        cooling: boolean;
        nextRetryAfter?: string;
        nextRecoverAt?: string;
        recoveryTime?: string;
        updatedAt?: string;
        malformed?: boolean;
        error?: string;
      };

      const parsedCpaAccounts: ParsedCpaAccount[] = [];
      let hasCodexFiles = false;

      for (const file of cdsFiles) {
        const filePath = join(cpaDir, file);
        const result = readJsonFileResult(filePath);
        if (result.status === "invalid") {
          hasCodexFiles = true;
          parsedCpaAccounts.push({
            authId: file.replace(/\.cds$/, ""),
            accountKey: file.replace(/\.cds$/, ""),
            cooling: false,
            malformed: true,
            error: result.error,
          });
          continue;
        }
        if (result.status !== "success") continue;
        const raw = result.value;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          hasCodexFiles = true;
          parsedCpaAccounts.push({
            authId: file.replace(/\.cds$/, ""),
            accountKey: file.replace(/\.cds$/, ""),
            cooling: false,
            malformed: true,
            error: "invalid_cds_shape",
          });
          continue;
        }

        const cds = raw as Record<string, unknown>;
        const records = Array.isArray(cds.records)
          ? (cds.records as Array<Record<string, unknown>>)
          : [];

        const isCodex =
          cds.provider === "codex" ||
          records.some(
            (r) => r && typeof r === "object" && r.provider === "codex",
          );
        if (!isCodex) {
          continue;
        }

        hasCodexFiles = true;

        const authId =
          typeof cds.auth_id === "string" && cds.auth_id.trim() !== ""
            ? cds.auth_id
            : file.replace(/\.cds$/, "");
        const accountKey = authId;
        const email = typeof cds.email === "string" ? cds.email : undefined;
        const plan = typeof cds.plan === "string" ? cds.plan : undefined;

        const topStatus =
          typeof cds.status === "string" ? cds.status : undefined;
        const topQuotaExceeded =
          cds.quota && typeof cds.quota === "object"
            ? (cds.quota as Record<string, unknown>).exceeded === true
            : false;
        const topIsCooling = topStatus === "cooling" || topQuotaExceeded;

        let rootRetryAfter: string | undefined;
        let rootRecoverAt: string | undefined;
        if (topIsCooling) {
          rootRetryAfter = parseEpochOrIso(cds.next_retry_after);
          if (cds.quota && typeof cds.quota === "object") {
            rootRecoverAt = parseEpochOrIso(
              (cds.quota as Record<string, unknown>).next_recover_at,
            );
          }
        }

        let isCooling = topIsCooling;
        const candidateRecoveryTimes: string[] = [];
        if (rootRetryAfter) candidateRecoveryTimes.push(rootRetryAfter);
        if (rootRecoverAt) candidateRecoveryTimes.push(rootRecoverAt);

        let recordRetryAfter: string | undefined;
        let recordRecoverAt: string | undefined;

        for (const rec of records) {
          if (!rec || typeof rec !== "object") continue;
          const recStatus =
            typeof rec.status === "string" ? rec.status : undefined;
          const recExceeded =
            rec.quota && typeof rec.quota === "object"
              ? (rec.quota as Record<string, unknown>).exceeded === true
              : false;
          const recIsCooling = recStatus === "cooling" || recExceeded;
          if (recIsCooling) {
            isCooling = true;
            const recNextRetryAfter = parseEpochOrIso(rec.next_retry_after);
            if (recNextRetryAfter) {
              candidateRecoveryTimes.push(recNextRetryAfter);
              if (!recordRetryAfter) recordRetryAfter = recNextRetryAfter;
            }
            if (rec.quota && typeof rec.quota === "object") {
              const recQuotaRecoverAt = parseEpochOrIso(
                (rec.quota as Record<string, unknown>).next_recover_at,
              );
              if (recQuotaRecoverAt) {
                candidateRecoveryTimes.push(recQuotaRecoverAt);
                if (!recordRecoverAt) recordRecoverAt = recQuotaRecoverAt;
              }
            }
          }
        }

        const validTimes = candidateRecoveryTimes
          .map((t) => Date.parse(t))
          .filter((ms) => Number.isFinite(ms));

        const recoveryTime =
          isCooling && validTimes.length > 0
            ? new Date(Math.min(...validTimes)).toISOString()
            : undefined;

        const nextRetryAfter = isCooling
          ? (rootRetryAfter ?? recordRetryAfter ?? recoveryTime)
          : undefined;
        const nextRecoverAt = isCooling
          ? (rootRecoverAt ?? recordRecoverAt ?? recoveryTime)
          : undefined;

        const updatedAt =
          typeof cds.updated_at === "string" ? cds.updated_at : undefined;

        parsedCpaAccounts.push({
          authId,
          accountKey,
          email,
          plan,
          cooling: isCooling,
          nextRetryAfter,
          nextRecoverAt,
          recoveryTime,
          updatedAt,
        });
      }

      if (hasCodexFiles) {
        if (
          parsedCpaAccounts.length === 0 ||
          parsedCpaAccounts.every((a) => a.malformed)
        ) {
          return {
            kind: "malformed",
            error: "malformed_cds",
            failure: poolMalformedFailure("malformed_cds", "unavailable"),
            source: "cpa",
            path: cpaDir,
          };
        }

        const validAccounts = parsedCpaAccounts.filter((a) => !a.malformed);
        const allCooling =
          validAccounts.length > 0 && validAccounts.every((a) => a.cooling);
        const anyCooling = validAccounts.some((a) => a.cooling);

        const coolingTimes = validAccounts
          .map((a) =>
            a.cooling && a.recoveryTime
              ? Date.parse(a.recoveryTime)
              : undefined,
          )
          .filter(
            (ms): ms is number => typeof ms === "number" && Number.isFinite(ms),
          );

        const earliestRecovery =
          coolingTimes.length > 0
            ? new Date(Math.min(...coolingTimes)).toISOString()
            : undefined;

        const headlineWindows: QuotaWindow[] = [
          {
            id: "pool",
            label: "pool",
            kind: "session",
            ...(earliestRecovery
              ? { resetsAt: earliestRecovery }
              : anyCooling
                ? { resetText: "cooling" }
                : { resetText: "pool serving" }),
          },
        ];

        const activeAccount =
          validAccounts.find((a) => !a.cooling) ?? validAccounts[0];

        const attempts: SourceAttempt[] = parsedCpaAccounts.map((a) => {
          if (a.malformed) {
            return {
              source: `pool:${a.accountKey}`,
              status: "failed",
              error: a.error ?? "malformed_cds",
            };
          }
          if (a.cooling) {
            return {
              source: `pool:${a.accountKey}`,
              status: "skipped",
              error: "cooling",
            };
          }
          return {
            source: `pool:${a.accountKey}`,
            status: "success",
          };
        });

        const poolAccounts: PoolAccountDetail[] = parsedCpaAccounts.map((a) => {
          if (a.malformed) {
            return {
              email: a.email,
              accountKey: a.accountKey,
              status: "unavailable",
              windows: [],
            };
          }
          const accWindows: QuotaWindow[] = [];
          if (a.cooling) {
            accWindows.push({
              id: "pool",
              label: "pool",
              kind: "session",
              ...(a.recoveryTime
                ? { resetsAt: a.recoveryTime }
                : { resetText: "cooling" }),
            });
          } else {
            accWindows.push({
              id: "pool",
              label: "pool",
              kind: "session",
              resetText: "pool serving",
            });
          }
          return {
            email: a.email,
            accountKey: a.accountKey,
            plan: a.plan,
            status: a.cooling ? "cooling" : "active",
            nextRetryAfter: a.nextRetryAfter,
            nextRecoverAt: a.nextRecoverAt,
            windows: accWindows,
          };
        });

        const updatedTimes = validAccounts
          .map((a) => (a.updatedAt ? Date.parse(a.updatedAt) : undefined))
          .filter(
            (ms): ms is number => typeof ms === "number" && Number.isFinite(ms),
          );
        const maxUpdatedMs =
          updatedTimes.length > 0 ? Math.max(...updatedTimes) : undefined;
        const refreshedAt =
          maxUpdatedMs !== undefined
            ? new Date(maxUpdatedMs).toISOString()
            : nowIso();

        const quota: ProviderQuota = {
          provider: "codex",
          label: "Codex",
          source: "cli-rpc",
          plan: activeAccount?.plan,
          account: {
            email: activeAccount?.email,
            accountId: activeAccount?.accountKey,
            identityStatus: "verified",
          },
          windows: headlineWindows,
          accountKey: "codex-home",
          accountKeys: [
            "codex-home",
            "default",
            ...parsedCpaAccounts.map((a) => a.accountKey),
          ],
          attempts,
          pool: {
            source: "cpa",
            activeAccount: activeAccount?.email ?? activeAccount?.accountKey,
            accounts: poolAccounts,
          },
          state: {
            status: allCooling ? "unavailable" : "fresh",
            stale: false,
            refreshedAt,
            sourcesTried: sourceNames(attempts),
          },
        };

        return {
          kind: "success",
          quota,
          source: "cpa",
          path: cpaDir,
        };
      }
    }
  }

  // Existing Registry Fallback
  const path = options.registryPath ?? resolveCodexRegistryPath(environment);
  const result = readJsonFileResult(path);
  if (result.status === "missing") return { kind: "missing" };
  if (result.status === "invalid") {
    return {
      kind: "malformed",
      error: result.error,
      failure: poolMalformedFailure(result.error),
      source: "registry",
      path,
    };
  }

  const raw = result.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "malformed",
      error: "invalid_registry_shape",
      failure: poolMalformedFailure("invalid_registry_shape"),
      source: "registry",
      path,
    };
  }

  const root = raw as Record<string, unknown>;
  const rawAccounts = Array.isArray(root.accounts)
    ? (root.accounts as RawCodexAccount[])
    : [];
  if (rawAccounts.length === 0) {
    return {
      kind: "malformed",
      error: "no_accounts_in_registry",
      failure: poolMalformedFailure("no_accounts_in_registry"),
      source: "registry",
      path,
    };
  }

  const nowS = Math.floor(nowMs / 1000);

  const activeAccountKey =
    typeof root.active_account_key === "string"
      ? root.active_account_key
      : undefined;

  type ParsedAccountWindow = {
    usedPercent: number;
    remainingPercent: number;
    resetsAt?: number;
  };

  type ParsedAccount = {
    accountKey: string;
    email?: string;
    plan?: string;
    lastUsageAt?: number;
    primary?: ParsedAccountWindow;
    secondary?: ParsedAccountWindow;
  };

  const parsedAccounts: ParsedAccount[] = [];
  for (const acc of rawAccounts) {
    if (!acc || typeof acc !== "object") continue;
    const accountKey =
      typeof acc.account_key === "string" ? acc.account_key : "";
    if (!accountKey) continue;

    const email = typeof acc.email === "string" ? acc.email : undefined;
    const plan = typeof acc.plan === "string" ? acc.plan : undefined;
    const lastUsageAt =
      typeof acc.last_usage_at === "number" &&
      Number.isFinite(acc.last_usage_at)
        ? acc.last_usage_at
        : typeof acc.last_used_at === "number" &&
            Number.isFinite(acc.last_used_at)
          ? acc.last_used_at
          : undefined;

    const parseWindow = (
      data:
        | {
            used_percent?: unknown;
            resets_at?: unknown;
          }
        | undefined,
    ): ParsedAccountWindow | undefined => {
      if (!data || typeof data !== "object") return undefined;
      const rawUsed = data.used_percent;
      if (typeof rawUsed !== "number" || !Number.isFinite(rawUsed)) {
        return undefined;
      }
      const usedPercent = clampPercent(rawUsed);
      const remainingPercent = clampPercent(100 - rawUsed);
      const resetsAt =
        typeof data.resets_at === "number" && Number.isFinite(data.resets_at)
          ? data.resets_at
          : undefined;
      return { usedPercent, remainingPercent, resetsAt };
    };

    parsedAccounts.push({
      accountKey,
      email,
      plan,
      lastUsageAt,
      primary: parseWindow(acc.last_usage?.primary),
      secondary: parseWindow(acc.last_usage?.secondary),
    });
  }

  if (parsedAccounts.length === 0) {
    return {
      kind: "malformed",
      error: "no_valid_accounts",
      failure: poolMalformedFailure("no_valid_accounts"),
      source: "registry",
      path,
    };
  }

  function aggregateWindow(
    extractor: (a: ParsedAccount) => ParsedAccountWindow | undefined,
    id: string,
    label: string,
    kind: QuotaWindow["kind"],
    windowSeconds: number,
  ): QuotaWindow | undefined {
    const items = parsedAccounts
      .map(extractor)
      .filter((w): w is ParsedAccountWindow => Boolean(w));
    if (items.length === 0) return undefined;

    const sumRemaining = items.reduce(
      (sum, item) => sum + item.remainingPercent,
      0,
    );
    const percentRemaining = clampPercent(sumRemaining / items.length);
    const percentUsed = clampPercent(100 - percentRemaining);

    const futureResets = items
      .map((item) => item.resetsAt)
      .filter((r): r is number => r !== undefined && r > nowS);
    const pastResets = items
      .map((item) => item.resetsAt)
      .filter((r): r is number => r !== undefined);

    const chosenResetS =
      futureResets.length > 0
        ? Math.min(...futureResets)
        : pastResets.length > 0
          ? Math.max(...pastResets)
          : undefined;

    return {
      id,
      label,
      kind,
      percentUsed,
      percentRemaining,
      windowSeconds,
      resetsAt: parseEpochOrIso(chosenResetS),
    };
  }

  const headlineWindows: QuotaWindow[] = [
    aggregateWindow(
      (a) => a.primary,
      "five_hour",
      "session",
      "session",
      FIVE_HOURS_SECONDS,
    ),
    aggregateWindow(
      (a) => a.secondary,
      "weekly",
      "week",
      "weekly",
      WEEK_SECONDS,
    ),
  ].filter((w): w is QuotaWindow => Boolean(w));

  if (headlineWindows.length === 0) {
    return {
      kind: "malformed",
      error: "missing_quota_usage",
      failure: poolMalformedFailure("missing_quota_usage"),
      source: "registry",
      path,
    };
  }

  // Freshness & staleness calculation
  const latestUsageTimes = parsedAccounts
    .map((a) => a.lastUsageAt)
    .filter((t): t is number => t !== undefined);
  const maxUsageS =
    latestUsageTimes.length > 0 ? Math.max(...latestUsageTimes) : undefined;
  const isResetExpired = headlineWindows.some((w) => {
    if (!w.resetsAt) return false;
    const ms = Date.parse(w.resetsAt);
    return Number.isFinite(ms) && ms <= nowMs;
  });
  const isUsageOld =
    maxUsageS !== undefined ? nowS - maxUsageS > STALE_MS / 1000 : true;
  const isStale = isResetExpired || isUsageOld;

  const refreshedAt =
    maxUsageS !== undefined
      ? (parseEpochOrIso(maxUsageS) ?? nowIso())
      : nowIso();

  const activeAccount =
    parsedAccounts.find((a) => a.accountKey === activeAccountKey) ??
    parsedAccounts[0];

  const attempts: SourceAttempt[] = parsedAccounts.map((a) => ({
    source: `pool:${a.email ?? a.accountKey}`,
    status: "success",
  }));

  const autoSwitch =
    root.auto_switch && typeof root.auto_switch === "object"
      ? (root.auto_switch as Record<string, unknown>)
      : undefined;

  const quota: ProviderQuota = {
    provider: "codex",
    label: "Codex",
    source: "cli-rpc",
    plan: activeAccount?.plan ?? "team",
    account: {
      email: activeAccount?.email,
      accountId: activeAccount?.accountKey,
      identityStatus: "verified",
    },
    windows: headlineWindows,
    accountKey: "codex-home",
    accountKeys: [
      "codex-home",
      "default",
      ...parsedAccounts.map((a) => a.accountKey),
    ],
    attempts,
    pool: {
      source: "cpa",
      activeAccount: activeAccount?.email ?? activeAccountKey,
      autoSwitch,
      accounts: parsedAccounts.map((a) => {
        const accWindows: QuotaWindow[] = [];
        if (a.primary) {
          accWindows.push({
            id: "five_hour",
            label: "session",
            kind: "session",
            percentUsed: a.primary.usedPercent,
            percentRemaining: a.primary.remainingPercent,
            windowSeconds: FIVE_HOURS_SECONDS,
            resetsAt: parseEpochOrIso(a.primary.resetsAt),
          });
        }
        if (a.secondary) {
          accWindows.push({
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentUsed: a.secondary.usedPercent,
            percentRemaining: a.secondary.remainingPercent,
            windowSeconds: WEEK_SECONDS,
            resetsAt: parseEpochOrIso(a.secondary.resetsAt),
          });
        }

        return {
          email: a.email,
          accountKey: a.accountKey,
          plan: a.plan,
          status: "available",
          windows: accWindows,
        };
      }),
    },
    state: {
      status: isStale ? "stale" : "fresh",
      stale: isStale,
      refreshedAt,
      sourcesTried: sourceNames(attempts),
    },
  };

  return {
    kind: "success",
    quota,
    source: "registry",
    path,
  };
}

function poolMalformedFailure(
  error: string,
  status: ProviderStatus = "error",
): ProviderQuota {
  return {
    ...failedProvider({
      provider: "codex",
      label: "Codex",
      status,
      error: `Codex pool malformed: ${error}`,
      sourcesTried: ["pool"],
      attempts: [{ source: "pool", status: "failed", error }],
    }),
    accountKey: "codex-home",
    accountKeys: ["codex-home", "default"],
  };
}
