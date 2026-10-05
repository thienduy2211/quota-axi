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

  type ParsedAccount = {
    accountKey: string;
    email?: string;
    plan?: string;
    lastUsageAt?: number;
    primaryUsed: number;
    primaryResetsAt?: number;
    secondaryUsed: number;
    secondaryResetsAt?: number;
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

    const primary = acc.last_usage?.primary;
    const primaryUsed =
      typeof primary?.used_percent === "number" &&
      Number.isFinite(primary.used_percent)
        ? primary.used_percent
        : 0;
    const primaryResetsAt =
      typeof primary?.resets_at === "number" &&
      Number.isFinite(primary.resets_at)
        ? primary.resets_at
        : undefined;

    const secondary = acc.last_usage?.secondary;
    const secondaryUsed =
      typeof secondary?.used_percent === "number" &&
      Number.isFinite(secondary.used_percent)
        ? secondary.used_percent
        : 0;
    const secondaryResetsAt =
      typeof secondary?.resets_at === "number" &&
      Number.isFinite(secondary.resets_at)
        ? secondary.resets_at
        : undefined;

    parsedAccounts.push({
      accountKey,
      email,
      plan,
      lastUsageAt,
      primaryUsed,
      primaryResetsAt,
      secondaryUsed,
      secondaryResetsAt,
    });
  }

  if (parsedAccounts.length === 0) {
    return {
      kind: "malformed",
      error: "no_valid_accounts",
      failure: poolMalformedFailure("no_valid_accounts"),
    };
  }

  const n = parsedAccounts.length;

  // Primary (5h) window aggregation
  const sumPrimaryRemaining = parsedAccounts.reduce((sum, acc) => {
    return sum + clampPercent(100 - acc.primaryUsed);
  }, 0);
  const primaryRemaining = clampPercent(sumPrimaryRemaining / n);
  const primaryUsed = clampPercent(100 - primaryRemaining);

  const futurePrimaryResets = parsedAccounts
    .map((a) => a.primaryResetsAt)
    .filter((r): r is number => r !== undefined && r > nowS);
  const pastPrimaryResets = parsedAccounts
    .map((a) => a.primaryResetsAt)
    .filter((r): r is number => r !== undefined);
  const primaryResetsAt =
    futurePrimaryResets.length > 0
      ? Math.min(...futurePrimaryResets)
      : pastPrimaryResets.length > 0
        ? Math.max(...pastPrimaryResets)
        : undefined;

  // Secondary (weekly) window aggregation
  const sumSecondaryRemaining = parsedAccounts.reduce((sum, acc) => {
    return sum + clampPercent(100 - acc.secondaryUsed);
  }, 0);
  const secondaryRemaining = clampPercent(sumSecondaryRemaining / n);
  const secondaryUsed = clampPercent(100 - secondaryRemaining);

  const futureSecondaryResets = parsedAccounts
    .map((a) => a.secondaryResetsAt)
    .filter((r): r is number => r !== undefined && r > nowS);
  const pastSecondaryResets = parsedAccounts
    .map((a) => a.secondaryResetsAt)
    .filter((r): r is number => r !== undefined);
  const secondaryResetsAt =
    futureSecondaryResets.length > 0
      ? Math.min(...futureSecondaryResets)
      : pastSecondaryResets.length > 0
        ? Math.max(...pastSecondaryResets)
        : undefined;

  const headlineWindows: QuotaWindow[] = [
    {
      id: "five_hour",
      label: "session",
      kind: "session",
      percentUsed: primaryUsed,
      percentRemaining: primaryRemaining,
      windowSeconds: FIVE_HOURS_SECONDS,
      resetsAt: parseEpochOrIso(primaryResetsAt),
    },
    {
      id: "weekly",
      label: "week",
      kind: "weekly",
      percentUsed: secondaryUsed,
      percentRemaining: secondaryRemaining,
      windowSeconds: WEEK_SECONDS,
      resetsAt: parseEpochOrIso(secondaryResetsAt),
    },
  ];

  // Freshness & staleness calculation
  const latestUsageTimes = parsedAccounts
    .map((a) => a.lastUsageAt)
    .filter((t): t is number => t !== undefined);
  const maxUsageS =
    latestUsageTimes.length > 0 ? Math.max(...latestUsageTimes) : undefined;
  const isResetExpired =
    (primaryResetsAt !== undefined && primaryResetsAt <= nowS) ||
    (secondaryResetsAt !== undefined && secondaryResetsAt <= nowS);
  const isUsageOld =
    maxUsageS !== undefined ? nowS - maxUsageS > STALE_MS / 1000 : false;
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
      accounts: parsedAccounts.map((a) => ({
        email: a.email,
        accountKey: a.accountKey,
        plan: a.plan,
        status: "available",
        windows: [
          {
            id: "five_hour",
            label: "session",
            kind: "session",
            percentUsed: a.primaryUsed,
            percentRemaining: clampPercent(100 - a.primaryUsed),
            windowSeconds: FIVE_HOURS_SECONDS,
            resetsAt: parseEpochOrIso(a.primaryResetsAt),
          },
          {
            id: "weekly",
            label: "week",
            kind: "weekly",
            percentUsed: a.secondaryUsed,
            percentRemaining: clampPercent(100 - a.secondaryUsed),
            windowSeconds: WEEK_SECONDS,
            resetsAt: parseEpochOrIso(a.secondaryResetsAt),
          },
        ],
      })),
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
