import { clampPercent, nowIso, parseEpochOrIso } from "../lib/time.js";
import type { ProviderQuota, QuotaWindow } from "../types.js";
import { withRemaining } from "./common.js";

export type RawWindow = {
  used_percent?: unknown;
  usedPercent?: unknown;
  reset_at?: unknown;
  resetsAt?: unknown;
  reset_after_seconds?: unknown;
  limit_window_seconds?: unknown;
  windowDurationMins?: unknown;
};

export type WindowIdentity = Pick<QuotaWindow, "id" | "label" | "kind">;

export type WindowIdentitySet = {
  session: WindowIdentity;
  weekly: WindowIdentity;
  unfamiliar(windowSeconds: number): WindowIdentity;
};

export function normalizeCodexUsage(raw: unknown):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      credits?: ProviderQuota["credits"];
      refreshedAt: string;
    }
  | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const rateLimit = resolveRateLimitContainer(data);

  const windows = deduplicateWindowIds([
    ...windowPairFromContainer(
      rateLimit,
      "five_hour",
      "session",
      "session",
      "weekly",
      "week",
      "weekly",
    ),
    ...windowPairFromContainer(
      objectValue(data.code_review_rate_limit),
      "code_review_five_hour",
      "code review session",
      "session",
      "code_review_weekly",
      "code review week",
      "weekly",
    ),
    ...collectNamedRateLimitWindows(data),
  ]);

  if (windows.length === 0) return undefined;

  return {
    plan: stringValue(data.plan_type) ?? stringValue(data.planType),
    account: {
      email: stringValue(data.email),
      accountId: stringValue(data.account_id) ?? stringValue(data.accountId),
    },
    windows,
    credits: normalizeCredits(data.credits ?? rateLimit?.credits),
    refreshedAt: nowIso(),
  };
}

export function resolveRateLimitContainer(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    objectValue(data.rate_limit) ??
    objectValue(data.rateLimits) ??
    objectValue(data.rate_limits) ??
    data
  );
}

export function windowPairFromContainer(
  container: Record<string, unknown> | undefined,
  primaryId: string,
  primaryLabel: string,
  primaryKind: QuotaWindow["kind"],
  secondaryId: string,
  secondaryLabel: string,
  secondaryKind: QuotaWindow["kind"],
): QuotaWindow[] {
  if (!container) return [];
  const identities: WindowIdentitySet = {
    session: { id: primaryId, label: primaryLabel, kind: primaryKind },
    weekly: { id: secondaryId, label: secondaryLabel, kind: secondaryKind },
    unfamiliar(windowSeconds) {
      const duration = readableWindowDuration(windowSeconds);
      const prefix =
        primaryId === "five_hour" ? "window" : "code_review_window";
      return {
        id: `${prefix}:${duration}`,
        label: `${duration} window`,
        kind: "unknown",
      };
    },
  };
  return [
    normalizeWindow(
      container.primary_window ?? container.primary,
      identities.session,
      identities,
    ),
    normalizeWindow(
      container.secondary_window ?? container.secondary,
      identities.weekly,
      identities,
    ),
  ].filter((window): window is QuotaWindow => Boolean(window));
}

export function collectNamedRateLimitWindows(
  data: Record<string, unknown>,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];

  const additional = Array.isArray(data.additional_rate_limits)
    ? data.additional_rate_limits
    : [];
  for (const entry of additional) {
    const item = objectValue(entry);
    if (!item) continue;
    const id =
      stringValue(item.metered_feature) ?? stringValue(item.limit_name);
    const label = stringValue(item.limit_name) ?? id;
    const container = objectValue(item.rate_limit);
    if (!id || !label || !container) continue;
    windows.push(...namedLimitWindows(id, label, container));
  }

  const byLimitId = objectValue(data.rateLimitsByLimitId);
  if (byLimitId) {
    for (const [limitId, value] of Object.entries(byLimitId)) {
      const item = objectValue(value);
      if (!item) continue;
      const label = stringValue(item.limitName) ?? stringValue(item.limit_name);
      if (!label) continue;
      windows.push(...namedLimitWindows(limitId, label, item));
    }
  }

  return windows;
}

export function namedLimitWindows(
  id: string,
  label: string,
  container: Record<string, unknown>,
): QuotaWindow[] {
  const identities: WindowIdentitySet = {
    session: {
      id: `model:${id}:5h`,
      label: `${label} session`,
      kind: "model",
    },
    weekly: {
      id: `model:${id}:7d`,
      label: `${label} week`,
      kind: "model",
    },
    unfamiliar(windowSeconds) {
      const duration = readableWindowDuration(windowSeconds);
      return {
        id: `model:${id}:window:${duration}`,
        label: `${label} ${duration} window`,
        kind: "model",
      };
    },
  };
  return [
    normalizeWindow(
      container.primary_window ?? container.primary,
      identities.session,
      identities,
    ),
    normalizeWindow(
      container.secondary_window ?? container.secondary,
      identities.weekly,
      identities,
    ),
  ].filter((window): window is QuotaWindow => Boolean(window));
}

export function deduplicateWindowIds(windows: QuotaWindow[]): QuotaWindow[] {
  const counts = new Map<string, number>();
  return windows.map((window) => {
    const count = (counts.get(window.id) ?? 0) + 1;
    counts.set(window.id, count);
    return count === 1 ? window : { ...window, id: `${window.id}_${count}` };
  });
}

export function mergeAccountAndLimits(
  account: unknown,
  limits: unknown,
): Record<string, unknown> {
  const accountData = objectValue(account) ?? {};
  const accountRecord = objectValue(accountData.account) ?? accountData;
  const limitData = objectValue(limits) ?? {};
  return {
    ...limitData,
    email: accountRecord.email ?? limitData.email,
    account_id:
      accountRecord.account_id ??
      accountRecord.accountId ??
      limitData.account_id,
    plan_type:
      accountRecord.plan_type ?? accountRecord.planType ?? limitData.plan_type,
  };
}

export function normalizeWindow(
  raw: unknown,
  fallbackIdentity: WindowIdentity,
  identities: WindowIdentitySet,
): QuotaWindow | undefined {
  const data = objectValue(raw) as RawWindow | undefined;
  if (!data) return undefined;
  const used = numberValue(data.used_percent) ?? numberValue(data.usedPercent);
  if (used === undefined) return undefined;
  const windowSeconds =
    numberValue(data.limit_window_seconds) ??
    (numberValue(data.windowDurationMins) === undefined
      ? undefined
      : numberValue(data.windowDurationMins)! * 60);
  const resetFromSeconds =
    numberValue(data.reset_after_seconds) === undefined
      ? undefined
      : new Date(
          Date.now() + numberValue(data.reset_after_seconds)! * 1000,
        ).toISOString();
  const identity = windowIdentity(windowSeconds, fallbackIdentity, identities);
  return withRemaining({
    ...identity,
    percentUsed: clampPercent(used),
    resetsAt:
      parseEpochOrIso(data.reset_at) ??
      parseEpochOrIso(data.resetsAt) ??
      resetFromSeconds,
    windowSeconds,
  });
}

export function windowIdentity(
  windowSeconds: number | undefined,
  fallbackIdentity: WindowIdentity,
  identities: WindowIdentitySet,
): WindowIdentity {
  if (windowSeconds === undefined) return fallbackIdentity;
  if (windowSeconds === 18_000) return identities.session;
  if (windowSeconds === 604_800) return identities.weekly;
  return identities.unfamiliar(windowSeconds);
}

export function readableWindowDuration(windowSeconds: number): string {
  const hours = windowSeconds / 3600;
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(2))}h`;
}

export function normalizeCredits(
  raw: unknown,
): ProviderQuota["credits"] | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const balance = numberValue(data.balance);
  const unlimited =
    typeof data.unlimited === "boolean" ? data.unlimited : undefined;
  if (balance === undefined && unlimited === undefined) return undefined;
  return {
    remaining: balance,
    unlimited,
    unit: "credits",
  };
}

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
