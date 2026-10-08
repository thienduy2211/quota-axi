import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import { clampPercent, nowIso, parseEpochOrIso } from "../lib/time.js";
import type {
  PoolAccountDetail,
  PoolCooldownReason,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames } from "./common.js";
import {
  probeCodexCredential,
  type CodexPoolProbe,
  type CodexPoolProbeContext,
  type CodexProbeResult,
} from "./codex-probe.js";

export type { CodexPoolProbe, CodexPoolProbeContext, CodexProbeResult };

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

export type ReadCodexPoolOptions = {
  registryPath?: string;
  cpaDir?: string;
  environment?: NodeJS.ProcessEnv;
  nowMs?: number;
  probe?: CodexPoolProbe;
  skipProbe?: boolean;
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

function parseTimestampMs(value: unknown): number | undefined {
  const iso = parseEpochOrIso(value);
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  // Cooldown timestamps at or before the epoch are unset sentinels (for
  // example Go's zero time "0001-01-01T00:00:00Z"), never real deadlines.
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

const TRANSIENT_COOLDOWN_TOKENS = new Set([
  "server_is_overloaded",
  "service_unavailable_error",
  "service_unavailable",
  "temporarily_unavailable",
  "overloaded",
  "overloaded_error",
  "engine_overloaded",
  "internal_error",
  "internal_server_error",
  "server_error",
  "bad_gateway",
  "gateway_timeout",
  "timeout",
  "deadline_exceeded",
  "unavailable",
  "rate_limit",
  "rate_limit_error",
  "rate_limit_exceeded",
  "too_many_requests",
]);

const QUOTA_COOLDOWN_TOKENS = new Set([
  "credential_quota",
  "insufficient_quota",
  "quota_exceeded",
  "exceeded_current_quota",
  "quota",
  "billing_hard_limit_reached",
  "billing",
  "access_terminated",
  "account_deactivated",
  "invalid_api_key",
  "authentication_error",
  "unauthorized",
  "permission_denied",
  "permission_error",
  "forbidden",
  "token_expired",
]);

function collectCooldownTokens(source: unknown, tokens: string[]): void {
  if (!source || typeof source !== "object") return;
  const record = source as Record<string, unknown>;
  const err =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
  for (const candidate of [err?.type, err?.code, record.type, record.code]) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      tokens.push(candidate.trim().toLowerCase());
    }
  }
}

function cooldownReasonTokens(rec: Record<string, unknown>): string[] {
  const tokens: string[] = [];
  const collect = (value: unknown): void => {
    if (value && typeof value === "object") {
      collectCooldownTokens(value, tokens);
      return;
    }
    if (typeof value !== "string") return;
    const text = value.trim();
    if (text === "") return;
    if (!text.startsWith("{")) {
      tokens.push(text.toLowerCase());
      return;
    }
    try {
      collectCooldownTokens(JSON.parse(text), tokens);
    } catch {
      tokens.push(text.toLowerCase());
    }
  };
  collect(rec.reason);
  const lastError =
    rec.last_error && typeof rec.last_error === "object"
      ? (rec.last_error as Record<string, unknown>)
      : undefined;
  collect(lastError?.message);
  return tokens;
}

function classifyCooldownRecord(
  rec: Record<string, unknown>,
): PoolCooldownReason {
  const quota =
    rec.quota && typeof rec.quota === "object"
      ? (rec.quota as Record<string, unknown>)
      : undefined;
  if (quota?.exceeded === true) return "quota";
  const tokens = cooldownReasonTokens(rec);
  if (tokens.some((token) => QUOTA_COOLDOWN_TOKENS.has(token))) return "quota";
  if (tokens.some((token) => TRANSIENT_COOLDOWN_TOKENS.has(token))) {
    return "transient";
  }
  const lastError =
    rec.last_error && typeof rec.last_error === "object"
      ? (rec.last_error as Record<string, unknown>)
      : undefined;
  const httpStatus =
    typeof lastError?.http_status === "number" &&
    Number.isFinite(lastError.http_status)
      ? lastError.http_status
      : undefined;
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus < 600) {
    return "transient";
  }
  return "unknown";
}

function cooldownReasonRank(reason: PoolCooldownReason): number {
  return reason === "quota" ? 3 : reason === "unknown" ? 2 : 1;
}

function evaluateCooldownRecord(
  rec: Record<string, unknown>,
  nowMs: number,
): {
  isCooling: boolean;
  hasTimestamps: boolean;
  futureTimes: number[];
  retryAfter?: string;
  recoverAt?: string;
} {
  const status =
    typeof rec.status === "string"
      ? rec.status.trim().toLowerCase()
      : undefined;

  const quota =
    rec.quota && typeof rec.quota === "object"
      ? (rec.quota as Record<string, unknown>)
      : undefined;

  const retryAfterMs = parseTimestampMs(rec.next_retry_after);
  const recoverAtMs = quota
    ? parseTimestampMs(quota.next_recover_at)
    : undefined;

  const validMsList: number[] = [];
  if (retryAfterMs !== undefined) validMsList.push(retryAfterMs);
  if (recoverAtMs !== undefined) validMsList.push(recoverAtMs);
  const hasTimestamps = validMsList.length > 0;

  if (status === "active") {
    return { isCooling: false, hasTimestamps, futureTimes: [] };
  }

  const quotaExceeded = quota?.exceeded === true;
  const isQuotaCleared = quota?.exceeded === false && status !== "cooling";

  if (isQuotaCleared) {
    return { isCooling: false, hasTimestamps, futureTimes: [] };
  }

  const marksCooling = status === "cooling" || quotaExceeded;
  if (!marksCooling) {
    return { isCooling: false, hasTimestamps, futureTimes: [] };
  }

  if (hasTimestamps) {
    const futureMsList = validMsList.filter((ms) => ms > nowMs);
    if (futureMsList.length === 0) {
      return { isCooling: false, hasTimestamps: true, futureTimes: [] };
    }
    const futureRetryAfter =
      retryAfterMs !== undefined && retryAfterMs > nowMs
        ? new Date(retryAfterMs).toISOString()
        : undefined;
    const futureRecoverAt =
      recoverAtMs !== undefined && recoverAtMs > nowMs
        ? new Date(recoverAtMs).toISOString()
        : undefined;
    return {
      isCooling: true,
      hasTimestamps: true,
      futureTimes: futureMsList,
      retryAfter: futureRetryAfter,
      recoverAt: futureRecoverAt,
    };
  }

  return { isCooling: true, hasTimestamps: false, futureTimes: [] };
}

type ParsedCpaAccount = {
  authId: string;
  accountKey: string;
  email?: string;
  plan?: string;
  cooling: boolean;
  cooldownReason?: PoolCooldownReason;
  nextRetryAfter?: string;
  nextRecoverAt?: string;
  recoveryTime?: string;
  updatedAt?: string;
  malformed?: boolean;
  error?: string;
  recovered?: boolean;
  stale?: boolean;
  unverified?: boolean;
  cooldownUnverified?: boolean;
  note?: string;
  probeError?: string;
  windows?: QuotaWindow[];
  probed?: boolean;
};

function parseCpaFiles(
  cpaDir: string,
  nowMs: number,
): { hasCodexFiles: boolean; parsedCpaAccounts: ParsedCpaAccount[] } {
  let entries: string[];
  try {
    entries = readdirSync(cpaDir);
  } catch {
    entries = [];
  }

  const cdsFiles = entries.filter((e) => e.endsWith(".cds")).sort();
  if (cdsFiles.length === 0) {
    return { hasCodexFiles: false, parsedCpaAccounts: [] };
  }

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
      records.some((r) => r && typeof r === "object" && r.provider === "codex");
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

    const rootEval = evaluateCooldownRecord(cds, nowMs);
    const validRecords = records.filter((r): r is Record<string, unknown> =>
      Boolean(r && typeof r === "object"),
    );

    let isCooling = false;
    let cooldownReason: PoolCooldownReason | undefined;
    const retryCandidates: string[] = [];
    const recoverCandidates: string[] = [];

    const escalateReason = (reason: PoolCooldownReason): void => {
      if (
        cooldownReason === undefined ||
        cooldownReasonRank(reason) > cooldownReasonRank(cooldownReason)
      ) {
        cooldownReason = reason;
      }
    };

    if (validRecords.length > 0) {
      let anyRecordCooling = false;
      let recordHasTimestamps = false;
      for (const rec of validRecords) {
        const recEval = evaluateCooldownRecord(rec, nowMs);
        if (recEval.hasTimestamps) {
          recordHasTimestamps = true;
        }
        if (recEval.isCooling) {
          anyRecordCooling = true;
          escalateReason(classifyCooldownRecord(rec));
          if (recEval.retryAfter) retryCandidates.push(recEval.retryAfter);
          if (recEval.recoverAt) recoverCandidates.push(recEval.recoverAt);
        }
      }
      if (rootEval.retryAfter) retryCandidates.push(rootEval.retryAfter);
      if (rootEval.recoverAt) recoverCandidates.push(rootEval.recoverAt);

      if (anyRecordCooling) {
        isCooling = true;
      } else if (rootEval.isCooling && !recordHasTimestamps) {
        isCooling = true;
        escalateReason(classifyCooldownRecord(cds));
      }
    } else {
      isCooling = rootEval.isCooling;
      if (rootEval.retryAfter) retryCandidates.push(rootEval.retryAfter);
      if (rootEval.recoverAt) recoverCandidates.push(rootEval.recoverAt);
      if (isCooling) escalateReason(classifyCooldownRecord(cds));
    }

    const earliestOf = (times: string[]): string | undefined => {
      const valid = times
        .map((t) => Date.parse(t))
        .filter((ms) => Number.isFinite(ms));
      return valid.length > 0
        ? new Date(Math.min(...valid)).toISOString()
        : undefined;
    };

    const earliestRetry = earliestOf(retryCandidates);
    const earliestRecover = earliestOf(recoverCandidates);

    const recoveryTime = isCooling
      ? earliestOf([...retryCandidates, ...recoverCandidates])
      : undefined;

    const nextRetryAfter = isCooling
      ? (earliestRetry ?? earliestRecover)
      : undefined;
    const nextRecoverAt = isCooling
      ? (earliestRecover ?? earliestRetry)
      : undefined;

    const updatedAt =
      typeof cds.updated_at === "string" ? cds.updated_at : undefined;

    parsedCpaAccounts.push({
      authId,
      accountKey,
      email,
      plan,
      cooling: isCooling,
      cooldownReason,
      nextRetryAfter,
      nextRecoverAt,
      recoveryTime,
      updatedAt,
    });
  }

  return { hasCodexFiles, parsedCpaAccounts };
}

function buildCpaPoolResult(
  parsedCpaAccounts: ParsedCpaAccount[],
  cpaDir: string,
): CodexPoolResult {
  const validAccounts = parsedCpaAccounts.filter((a) => !a.malformed);
  const allCooling =
    validAccounts.length > 0 && validAccounts.every((a) => a.cooling);
  const anyUnverified = validAccounts.some((a) => a.unverified);

  const coolingTimes = validAccounts
    .map((a) =>
      a.cooling && a.recoveryTime ? Date.parse(a.recoveryTime) : undefined,
    )
    .filter(
      (ms): ms is number => typeof ms === "number" && Number.isFinite(ms),
    );

  const earliestRecovery =
    coolingTimes.length > 0
      ? new Date(Math.min(...coolingTimes)).toISOString()
      : undefined;

  const activeAccount =
    validAccounts.find((a) => !a.cooling) ?? validAccounts[0];

  const headlineWindows: QuotaWindow[] =
    activeAccount?.windows &&
    activeAccount.windows.length > 0 &&
    activeAccount.windows.some((w) => w.id !== "pool")
      ? activeAccount.windows
      : [
          {
            id: "pool",
            label: "pool",
            kind: "session",
            ...(earliestRecovery ? { resetsAt: earliestRecovery } : {}),
            resetText: allCooling
              ? earliestRecovery
                ? `cooling until ${earliestRecovery}`
                : "cooling"
              : "pool serving",
          },
        ];

  const attempts: SourceAttempt[] = [];
  for (const a of parsedCpaAccounts) {
    if (a.malformed) {
      attempts.push({
        source: `pool:${a.accountKey}`,
        status: "failed",
        error: a.error ?? "malformed_cds",
      });
      continue;
    }
    if (a.recovered) {
      attempts.push({
        source: `pool:${a.accountKey}`,
        status: "success",
      });
      attempts.push({
        source: `cli-rpc:${a.accountKey}`,
        status: "success",
      });
      continue;
    }
    if (a.cooling) {
      attempts.push({
        source: `pool:${a.accountKey}`,
        status: "skipped",
        error: "cooling",
      });
      if (a.probeError) {
        attempts.push({
          source: `cli-rpc:${a.accountKey}`,
          status: "failed",
          error: a.probeError,
        });
      } else if (!a.unverified && a.windows) {
        attempts.push({
          source: `cli-rpc:${a.accountKey}`,
          status: "success",
        });
      } else {
        attempts.push({
          source: `cli-rpc:${a.accountKey}`,
          status: "skipped",
          error: "unverified",
        });
      }
      continue;
    }
    attempts.push({
      source: `pool:${a.accountKey}`,
      status: "success",
    });
  }

  const poolAccounts: PoolAccountDetail[] = parsedCpaAccounts.map((a) => {
    if (a.malformed) {
      return {
        email: a.email,
        accountKey: a.accountKey,
        status: "unavailable",
        note: a.error,
        windows: [],
      };
    }
    const accWindows: QuotaWindow[] = [];
    if (a.windows && a.windows.length > 0) {
      accWindows.push(...a.windows);
    } else if (a.cooling) {
      accWindows.push({
        id: "pool",
        label: "pool",
        kind: "session",
        ...(a.recoveryTime
          ? {
              resetsAt: a.recoveryTime,
              resetText: `cooling until ${a.recoveryTime}`,
            }
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
      cooldownReason: a.cooling ? a.cooldownReason : undefined,
      nextRetryAfter: a.cooling ? a.nextRetryAfter : undefined,
      nextRecoverAt: a.cooling ? a.nextRecoverAt : undefined,
      windows: accWindows,
      stale: a.stale,
      recovered: a.recovered,
      unverified: a.unverified,
      cooldownUnverified: a.cooldownUnverified,
      note: a.note,
    };
  });

  const updatedTimes = validAccounts
    .map((a) => (a.updatedAt ? Date.parse(a.updatedAt) : undefined))
    .filter(
      (ms): ms is number => typeof ms === "number" && Number.isFinite(ms),
    );
  const maxUpdatedMs =
    updatedTimes.length > 0 ? Math.max(...updatedTimes) : undefined;
  const anyProbed = validAccounts.some((a) => a.probed);
  const refreshedAt =
    anyProbed || maxUpdatedMs === undefined
      ? nowIso()
      : new Date(maxUpdatedMs).toISOString();

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
      error: allCooling
        ? earliestRecovery
          ? `cooling until ${earliestRecovery}`
          : "All pool accounts in cooldown"
        : undefined,
      retryAfter: allCooling ? earliestRecovery : undefined,
      ...(allCooling && anyUnverified
        ? { cooldownUnverified: true, unverified: true }
        : {}),
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

function isWindowExhausted(window: QuotaWindow): boolean {
  if (window.percentRemaining !== undefined && window.percentRemaining <= 0) {
    return true;
  }
  if (window.percentUsed !== undefined && window.percentUsed >= 100) {
    return true;
  }
  return false;
}

function applyProbeSuccess(
  a: ParsedCpaAccount,
  res: {
    plan?: string;
    account?: ProviderQuota["account"];
    windows?: QuotaWindow[];
  },
): void {
  const windows =
    res.windows && res.windows.length > 0 ? res.windows : undefined;
  const isExhausted = windows?.some(isWindowExhausted) ?? false;
  if (!isExhausted) {
    a.cooling = false;
    a.cooldownReason = undefined;
    a.recovered = true;
    a.stale = undefined;
    a.unverified = undefined;
    a.cooldownUnverified = undefined;
    a.note = undefined;
    a.probeError = undefined;
    a.nextRetryAfter = undefined;
    a.nextRecoverAt = undefined;
    a.recoveryTime = undefined;
  } else {
    a.cooling = true;
    a.cooldownReason = "quota";
    a.recovered = undefined;
    a.stale = undefined;
    a.unverified = undefined;
    a.cooldownUnverified = undefined;
    a.note = undefined;
    a.probeError = undefined;
    const exhaustedWindows = (windows ?? []).filter(isWindowExhausted);
    const resetTimes = exhaustedWindows
      .map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : undefined))
      .filter(
        (ms): ms is number =>
          typeof ms === "number" && Number.isFinite(ms) && ms > 0,
      );
    if (resetTimes.length > 0) {
      const recoveryTimestamp = new Date(Math.max(...resetTimes)).toISOString();
      a.recoveryTime = recoveryTimestamp;
      a.nextRetryAfter = recoveryTimestamp;
      a.nextRecoverAt = recoveryTimestamp;
    }
  }
  a.windows = windows;
  if (res.plan) a.plan = res.plan;
  if (res.account?.email) a.email = res.account.email;
}

function applyProbeFailure(a: ParsedCpaAccount, error?: string): void {
  a.unverified = true;
  a.note = "cooldown unverified";
  a.cooldownUnverified = true;
  a.probeError = error;
  a.stale = true;
}

export async function readCodexPool(
  options: ReadCodexPoolOptions = {},
): Promise<CodexPoolResult> {
  const environment = options.environment ?? process.env;
  const nowMs = options.nowMs ?? Date.now();

  const testRegistryExplicit =
    options.registryPath !== undefined && options.cpaDir === undefined;

  if (!testRegistryExplicit) {
    const cpaDir = options.cpaDir ?? resolveCpaStateDir(environment);
    const { hasCodexFiles, parsedCpaAccounts } = parseCpaFiles(cpaDir, nowMs);

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

      const coolingAccounts = parsedCpaAccounts.filter(
        (a) => !a.malformed && a.cooling,
      );

      if (coolingAccounts.length > 0 && !options.skipProbe) {
        for (const a of coolingAccounts) {
          a.probed = true;
          if (options.probe) {
            try {
              const res = await options.probe({
                authId: a.authId,
                accountKey: a.accountKey,
                email: a.email,
                cpaDir,
              });
              if (res?.status === "success") {
                applyProbeSuccess(a, res);
              } else if (res?.status === "failed") {
                applyProbeFailure(a, res.error);
              } else {
                applyProbeFailure(a);
              }
            } catch (err) {
              applyProbeFailure(
                a,
                err instanceof Error ? err.message : String(err),
              );
            }
          } else {
            try {
              const res = await probeCodexCredential({
                cpaDir,
                authId: a.authId,
                accountKey: a.accountKey,
                environment,
              });
              if (res.status === "success") {
                applyProbeSuccess(a, res);
              } else if (res.status === "failed") {
                applyProbeFailure(a, res.error);
              } else {
                applyProbeFailure(a);
              }
            } catch (err) {
              applyProbeFailure(
                a,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
      } else {
        for (const a of coolingAccounts) {
          applyProbeFailure(a);
        }
      }

      return buildCpaPoolResult(parsedCpaAccounts, cpaDir);
    }
  }

  return readRegistryFallback(options);
}

function readRegistryFallback(options: ReadCodexPoolOptions): CodexPoolResult {
  const environment = options.environment ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
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
