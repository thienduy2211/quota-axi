import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import { clampPercent, nowIso } from "../lib/time.js";
import type { ProviderQuota, QuotaWindow, SourceAttempt } from "../types.js";
import { failedProvider, sourceNames } from "./common.js";

const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const STALE_MS = 60 * 60 * 1_000; // 1 hour

export function resolveAgyMultiStatePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = environment.AGY_MULTI_STATE_PATH?.trim();
  if (explicit) return explicit;
  const xdgData = environment.XDG_DATA_HOME?.trim();
  if (xdgData) return join(xdgData, "agy-multi", "state.json");
  return join(homedir(), ".local", "share", "agy-multi", "state.json");
}

export type AgyPoolResult =
  | { kind: "missing" }
  | { kind: "malformed"; error: string; failure: ProviderQuota }
  | { kind: "success"; quota: ProviderQuota };

type RawQuotaWindowData = {
  fraction?: unknown;
  resetMs?: unknown;
};

type RawAccountCache = {
  fetchedMs?: unknown;
  groups?: {
    gemini?: {
      "5h"?: RawQuotaWindowData;
      weekly?: RawQuotaWindowData;
    };
    "3p"?: {
      "5h"?: RawQuotaWindowData;
      weekly?: RawQuotaWindowData;
    };
  };
};

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function readAgyMultiPool(
  options: {
    statePath?: string;
    environment?: NodeJS.ProcessEnv;
    nowMs?: number;
  } = {},
): AgyPoolResult {
  const environment = options.environment ?? process.env;
  const path = options.statePath ?? resolveAgyMultiStatePath(environment);
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
      error: "invalid_state_shape",
      failure: poolMalformedFailure("invalid_state_shape"),
    };
  }

  const root = raw as Record<string, unknown>;
  const rawCache =
    root.quotaCache && typeof root.quotaCache === "object"
      ? (root.quotaCache as Record<string, RawAccountCache>)
      : undefined;

  if (!rawCache || Object.keys(rawCache).length === 0) {
    return {
      kind: "malformed",
      error: "missing_quota_cache",
      failure: poolMalformedFailure("missing_quota_cache"),
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  const emails = Object.keys(rawCache);

  const rawCooldowns =
    root.cooldowns && typeof root.cooldowns === "object"
      ? (root.cooldowns as Record<string, Record<string, unknown>>)
      : {};

  function isAccountCooldown(email: string, group: "gemini" | "3p"): boolean {
    const cd = rawCooldowns[email]?.[group];
    return typeof cd === "number" && Number.isFinite(cd) && cd > nowMs;
  }

  function getCooldownUntil(
    email: string,
    group: "gemini" | "3p",
  ): number | undefined {
    const cd = rawCooldowns[email]?.[group];
    return typeof cd === "number" && Number.isFinite(cd) && cd > nowMs
      ? cd
      : undefined;
  }

  type ParsedAccountWindow = {
    remainingPercent: number;
    usedPercent: number;
    resetMs?: number;
  };

  type ParsedAccount = {
    email: string;
    fetchedMs?: number;
    geminiCooldown: boolean;
    geminiCooldownUntil?: number;
    threePCooldown: boolean;
    threePCooldownUntil?: number;
    gemini5h?: ParsedAccountWindow;
    geminiWeekly?: ParsedAccountWindow;
    claudeGpt5h?: ParsedAccountWindow;
    claudeGptWeekly?: ParsedAccountWindow;
  };

  const parsedAccounts: ParsedAccount[] = [];

  for (const email of emails) {
    const cache = rawCache[email];
    if (!cache || typeof cache !== "object") continue;

    const fetchedMs =
      typeof cache.fetchedMs === "number" && Number.isFinite(cache.fetchedMs)
        ? cache.fetchedMs
        : undefined;

    const parseWindow = (
      data: RawQuotaWindowData | undefined,
    ): ParsedAccountWindow | undefined => {
      if (!data || typeof data !== "object") return undefined;
      const fraction =
        typeof data.fraction === "number" && Number.isFinite(data.fraction)
          ? clampFraction(data.fraction)
          : undefined;
      if (fraction === undefined) return undefined;
      const remainingPercent = clampPercent(fraction * 100);
      const usedPercent = clampPercent((1 - fraction) * 100);
      const resetMs =
        typeof data.resetMs === "number" && Number.isFinite(data.resetMs)
          ? data.resetMs
          : undefined;
      return { remainingPercent, usedPercent, resetMs };
    };

    const groups = cache.groups;
    const gemini = groups?.gemini;
    const threeP = groups?.["3p"];

    parsedAccounts.push({
      email,
      fetchedMs,
      geminiCooldown: isAccountCooldown(email, "gemini"),
      geminiCooldownUntil: getCooldownUntil(email, "gemini"),
      threePCooldown: isAccountCooldown(email, "3p"),
      threePCooldownUntil: getCooldownUntil(email, "3p"),
      gemini5h: parseWindow(gemini?.["5h"]),
      geminiWeekly: parseWindow(gemini?.weekly),
      claudeGpt5h: parseWindow(threeP?.["5h"]),
      claudeGptWeekly: parseWindow(threeP?.weekly),
    });
  }

  if (parsedAccounts.length === 0) {
    return {
      kind: "malformed",
      error: "no_valid_accounts",
      failure: poolMalformedFailure("no_valid_accounts"),
    };
  }

  // Aggregate helper for a window type across all accounts that report it
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
      .map((item) => item.resetMs)
      .filter((r): r is number => r !== undefined && r > nowMs);
    const pastResets = items
      .map((item) => item.resetMs)
      .filter((r): r is number => r !== undefined);

    const chosenResetMs =
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
      resetsAt: chosenResetMs
        ? new Date(chosenResetMs).toISOString()
        : undefined,
    };
  }

  const headlineWindows: QuotaWindow[] = [
    aggregateWindow(
      (a) => a.gemini5h,
      "gemini_5h",
      "Gemini 5-hour",
      "session",
      FIVE_HOURS_SECONDS,
    ),
    aggregateWindow(
      (a) => a.geminiWeekly,
      "gemini_weekly",
      "Gemini weekly",
      "weekly",
      WEEK_SECONDS,
    ),
    aggregateWindow(
      (a) => a.claudeGpt5h,
      "claude_gpt_5h",
      "Claude/GPT 5-hour",
      "session",
      FIVE_HOURS_SECONDS,
    ),
    aggregateWindow(
      (a) => a.claudeGptWeekly,
      "claude_gpt_weekly",
      "Claude/GPT weekly",
      "weekly",
      WEEK_SECONDS,
    ),
  ].filter((w): w is QuotaWindow => Boolean(w));

  // Freshness & staleness calculation
  const fetchedTimes = parsedAccounts
    .map((a) => a.fetchedMs)
    .filter((t): t is number => t !== undefined);
  const maxFetchedMs =
    fetchedTimes.length > 0 ? Math.max(...fetchedTimes) : undefined;

  const isResetExpired = headlineWindows.some((w) => {
    if (!w.resetsAt) return false;
    const ms = Date.parse(w.resetsAt);
    return Number.isFinite(ms) && ms <= nowMs;
  });

  const isUsageOld =
    maxFetchedMs !== undefined ? nowMs - maxFetchedMs > STALE_MS : true;
  const isStale = isResetExpired || isUsageOld;

  const refreshedAt =
    maxFetchedMs !== undefined
      ? new Date(maxFetchedMs).toISOString()
      : nowIso();

  // Cooldown status across the pool
  const allInCooldown = parsedAccounts.every(
    (a) => a.geminiCooldown && a.threePCooldown,
  );

  const activeEmail =
    typeof root.active === "string" ? root.active : parsedAccounts[0]?.email;

  const attempts: SourceAttempt[] = parsedAccounts.map((a) => {
    const isBothCooldown = a.geminiCooldown && a.threePCooldown;
    if (isBothCooldown) {
      return {
        source: `pool:${a.email}`,
        status: "skipped",
        error: "in_cooldown",
      };
    }
    const anyCooldown = a.geminiCooldown || a.threePCooldown;
    return {
      source: `pool:${a.email}`,
      status: "success",
      ...(anyCooldown
        ? {
            error: a.geminiCooldown ? "cooldown:gemini" : "cooldown:claude_gpt",
          }
        : {}),
    };
  });

  const status: ProviderQuota["state"]["status"] = allInCooldown
    ? "unavailable"
    : isStale
      ? "stale"
      : "fresh";

  const quota: ProviderQuota = {
    provider: "agy",
    label: "Antigravity",
    source: "cli-rpc",
    plan: "pool",
    account: {
      email: activeEmail,
    },
    windows: headlineWindows,
    accountKeys: ["default", ...parsedAccounts.map((a) => a.email)],
    attempts,
    pool: {
      source: "agy-multi",
      activeAccount: activeEmail,
      accounts: parsedAccounts.map((a) => {
        const isUnavailable = a.geminiCooldown && a.threePCooldown;
        const cooldownsRecord: Record<string, number> = {};
        if (a.geminiCooldownUntil)
          cooldownsRecord.gemini = a.geminiCooldownUntil;
        if (a.threePCooldownUntil)
          cooldownsRecord["3p"] = a.threePCooldownUntil;

        const accWindows: QuotaWindow[] = [];
        if (a.gemini5h) {
          accWindows.push({
            id: "gemini_5h",
            label: "Gemini 5-hour",
            kind: "session",
            percentUsed: a.gemini5h.usedPercent,
            percentRemaining: a.gemini5h.remainingPercent,
            windowSeconds: FIVE_HOURS_SECONDS,
            resetsAt: a.gemini5h.resetMs
              ? new Date(a.gemini5h.resetMs).toISOString()
              : undefined,
          });
        }
        if (a.geminiWeekly) {
          accWindows.push({
            id: "gemini_weekly",
            label: "Gemini weekly",
            kind: "weekly",
            percentUsed: a.geminiWeekly.usedPercent,
            percentRemaining: a.geminiWeekly.remainingPercent,
            windowSeconds: WEEK_SECONDS,
            resetsAt: a.geminiWeekly.resetMs
              ? new Date(a.geminiWeekly.resetMs).toISOString()
              : undefined,
          });
        }
        if (a.claudeGpt5h) {
          accWindows.push({
            id: "claude_gpt_5h",
            label: "Claude/GPT 5-hour",
            kind: "session",
            percentUsed: a.claudeGpt5h.usedPercent,
            percentRemaining: a.claudeGpt5h.remainingPercent,
            windowSeconds: FIVE_HOURS_SECONDS,
            resetsAt: a.claudeGpt5h.resetMs
              ? new Date(a.claudeGpt5h.resetMs).toISOString()
              : undefined,
          });
        }
        if (a.claudeGptWeekly) {
          accWindows.push({
            id: "claude_gpt_weekly",
            label: "Claude/GPT weekly",
            kind: "weekly",
            percentUsed: a.claudeGptWeekly.usedPercent,
            percentRemaining: a.claudeGptWeekly.remainingPercent,
            windowSeconds: WEEK_SECONDS,
            resetsAt: a.claudeGptWeekly.resetMs
              ? new Date(a.claudeGptWeekly.resetMs).toISOString()
              : undefined,
          });
        }

        return {
          email: a.email,
          status: isUnavailable ? "unavailable" : "available",
          cooldowns:
            Object.keys(cooldownsRecord).length > 0
              ? cooldownsRecord
              : undefined,
          fetchedAt: a.fetchedMs
            ? new Date(a.fetchedMs).toISOString()
            : undefined,
          windows: accWindows,
        };
      }),
    },
    state: {
      status,
      stale: isStale,
      refreshedAt,
      error: allInCooldown ? "All pool accounts in cooldown" : undefined,
      sourcesTried: sourceNames(attempts),
    },
  };

  return { kind: "success", quota };
}

function poolMalformedFailure(error: string): ProviderQuota {
  return {
    ...failedProvider({
      provider: "agy",
      label: "Antigravity",
      status: "error",
      error: `Antigravity pool state malformed: ${error}`,
      sourcesTried: ["pool"],
      attempts: [{ source: "pool", status: "failed", error }],
    }),
    accountKeys: ["default"],
  };
}
