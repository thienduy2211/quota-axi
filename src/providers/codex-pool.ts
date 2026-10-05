import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import { clampPercent, nowIso, parseEpochOrIso } from "../lib/time.js";
import type { ProviderQuota, QuotaWindow, SourceAttempt } from "../types.js";
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

export type CodexPoolResult =
  | { kind: "missing" }
  | { kind: "malformed"; error: string; failure: ProviderQuota }
  | { kind: "success"; quota: ProviderQuota };

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
    environment?: NodeJS.ProcessEnv;
    nowMs?: number;
  } = {},
): CodexPoolResult {
  const environment = options.environment ?? process.env;
  const path = options.registryPath ?? resolveCodexRegistryPath(environment);
  const result = readJsonFileResult(path);
  if (result.status === "missing") return { kind: "missing" };
  if (result.status === "invalid") {
    return {
      kind: "malformed",
      error: result.error,
      failure: poolMalformedFailure(result.error),
    };
  }

  const raw = result.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "malformed",
      error: "invalid_registry_shape",
      failure: poolMalformedFailure("invalid_registry_shape"),
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
    };
  }

  const nowMs = options.nowMs ?? Date.now();
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

  return { kind: "success", quota };
}

function poolMalformedFailure(error: string): ProviderQuota {
  return {
    ...failedProvider({
      provider: "codex",
      label: "Codex",
      status: "error",
      error: `Codex pool registry malformed: ${error}`,
      sourcesTried: ["pool"],
      attempts: [{ source: "pool", status: "failed", error }],
    }),
    accountKey: "codex-home",
    accountKeys: ["codex-home", "default"],
  };
}
