import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { readJsonFileResult } from "../lib/fs.js";
import { findCommandPath, terminateChild } from "../lib/process.js";
import type { ProviderQuota, QuotaWindow } from "../types.js";
import {
  mergeAccountAndLimits,
  normalizeCodexUsage,
} from "./codex-normalize.js";

const CLI_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 8_000;
export const CODEX_BINARY_ENV = "QUOTA_AXI_CODEX_BINARY";

export type CodexBinaryState =
  | { status: "available"; path: string }
  | { status: "missing"; path?: string; error?: string };

export type CodexPoolProbeContext = {
  authId: string;
  accountKey: string;
  email?: string;
  cpaDir: string;
  authPath?: string;
};

export type CodexProbeResult = {
  status: "success" | "failed";
  plan?: string;
  account?: ProviderQuota["account"];
  windows?: QuotaWindow[];
  error?: string;
};

export type CodexPoolProbe = (
  context: CodexPoolProbeContext,
) => Promise<CodexProbeResult | undefined> | CodexProbeResult | undefined;

export type CodexAuthTokens = {
  accessToken: string;
  accountId?: string;
  idToken?: string;
  refreshToken?: string;
};

export async function resolveCodexBinary(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CodexBinaryState> {
  const configured = environment[CODEX_BINARY_ENV];
  if (configured !== undefined) {
    const path = configured.trim();
    if (!path || !isAbsolute(path)) {
      return {
        status: "missing",
        error: "codex_binary_override_not_absolute",
      };
    }
    const executable = await findCommandPath(path);
    if (!executable) {
      return {
        status: "missing",
        path,
        error: "codex_binary_override_not_executable",
      };
    }
    return { status: "available", path: executable };
  }

  const executable = await findCommandPath("codex");
  return executable
    ? { status: "available", path: executable }
    : { status: "missing" };
}

export function codexBinaryErrorMessage(
  binary: Extract<CodexBinaryState, { status: "missing" }>,
): string {
  if (binary.error === "codex_binary_override_not_absolute") {
    return "Configured Codex binary must be an absolute executable path";
  }
  if (binary.error === "codex_binary_override_not_executable") {
    return "Configured Codex binary is not executable";
  }
  return "Codex quota unavailable";
}

export function sendRpc(
  child: {
    stdin: { writable: boolean; write: (chunk: string) => unknown } | null;
  },
  id: number,
  method: string,
  params: unknown = {},
): void {
  if (!child.stdin || !child.stdin.writable) return;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
}

export function extractCodexTokensFromFile(
  filePath: string,
): CodexAuthTokens | undefined {
  const result = readJsonFileResult(filePath);
  if (
    result.status !== "success" ||
    !result.value ||
    typeof result.value !== "object"
  ) {
    return undefined;
  }
  const data = result.value as Record<string, unknown>;
  const tokens =
    data.tokens && typeof data.tokens === "object"
      ? (data.tokens as Record<string, unknown>)
      : undefined;

  const accessToken =
    (typeof tokens?.access_token === "string" && tokens.access_token.trim()) ||
    (typeof tokens?.accessToken === "string" && tokens.accessToken.trim()) ||
    (typeof data.access_token === "string" && data.access_token.trim()) ||
    (typeof data.accessToken === "string" && data.accessToken.trim()) ||
    undefined;

  if (!accessToken) return undefined;

  const accountId =
    (typeof tokens?.account_id === "string" && tokens.account_id.trim()) ||
    (typeof tokens?.accountId === "string" && tokens.accountId.trim()) ||
    (typeof data.account_id === "string" && data.account_id.trim()) ||
    (typeof data.accountId === "string" && data.accountId.trim()) ||
    undefined;

  const idToken =
    (typeof tokens?.id_token === "string" && tokens.id_token.trim()) ||
    (typeof tokens?.idToken === "string" && tokens.idToken.trim()) ||
    (typeof data.id_token === "string" && data.id_token.trim()) ||
    (typeof data.idToken === "string" && data.idToken.trim()) ||
    undefined;

  const refreshToken =
    (typeof tokens?.refresh_token === "string" &&
      tokens.refresh_token.trim()) ||
    (typeof tokens?.refreshToken === "string" && tokens.refreshToken.trim()) ||
    (typeof data.refresh_token === "string" && data.refresh_token.trim()) ||
    (typeof data.refreshToken === "string" && data.refreshToken.trim()) ||
    undefined;

  return { accessToken, accountId, idToken, refreshToken };
}

export function findCodexCredentialFile(options: {
  cpaDir: string;
  authId: string;
  accountKey: string;
  environment?: NodeJS.ProcessEnv;
}): string | undefined {
  const { cpaDir, authId, accountKey } = options;
  const candidates: string[] = [];

  if (isAbsolute(authId)) {
    candidates.push(authId);
  } else {
    candidates.push(join(cpaDir, authId));
    if (!authId.endsWith(".json")) {
      candidates.push(join(cpaDir, `${authId}.json`));
    }
  }

  if (accountKey && accountKey !== authId) {
    if (isAbsolute(accountKey)) {
      candidates.push(accountKey);
    } else {
      candidates.push(join(cpaDir, accountKey));
      if (!accountKey.endsWith(".json")) {
        candidates.push(join(cpaDir, `${accountKey}.json`));
      }
    }
  }

  const codexHome =
    options.environment?.CODEX_HOME?.trim() || join(homedir(), ".codex");
  candidates.push(join(codexHome, "accounts", `${accountKey}.auth.json`));
  candidates.push(join(codexHome, "accounts", `${accountKey}.json`));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function probeCodexAppServer(options: {
  binaryPath: string;
  tokens: CodexAuthTokens;
  environment?: NodeJS.ProcessEnv;
}): Promise<CodexProbeResult> {
  const { binaryPath, tokens, environment = process.env } = options;
  const tempDir = mkdtempSync(join(tmpdir(), "quota-axi-codex-probe-"));
  const authJsonPath = join(tempDir, "auth.json");

  let child: ReturnType<typeof spawn> | undefined;
  try {
    const authPayload = {
      auth_mode: "chatgpt",
      tokens: {
        access_token: tokens.accessToken,
        ...(tokens.accountId ? { account_id: tokens.accountId } : {}),
        ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
        ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
      },
    };
    writeFileSync(authJsonPath, JSON.stringify(authPayload), {
      mode: 0o600,
    });

    child = spawn(
      binaryPath,
      ["-s", "read-only", "-a", "never", "app-server"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...environment,
          CODEX_HOME: tempDir,
          NO_COLOR: "1",
          TERM: "dumb",
        },
      },
    );

    let nextId = 1;
    let buffer = "";
    let fatalError: Error | undefined;
    const responses = new Map<number, unknown>();
    const waiters = new Map<
      number,
      {
        timer: NodeJS.Timeout;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    >();

    const failAll = (error: Error) => {
      if (fatalError) return;
      fatalError = error;
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      waiters.clear();
    };

    child.stdin?.on("error", () => {});
    child.stderr?.resume();
    child.on("error", () => failAll(new Error("Codex quota unavailable")));
    child.on("close", () => failAll(new Error("Codex quota unavailable")));

    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as {
            id?: unknown;
            result?: unknown;
            params?: unknown;
            error?: unknown;
          };
          if (typeof message.id !== "number") continue;
          const value = message.error ?? message.result ?? message.params;
          const waiter = waiters.get(message.id);
          if (waiter) {
            waiters.delete(message.id);
            clearTimeout(waiter.timer);
            waiter.resolve(value);
          } else {
            responses.set(message.id, value);
          }
        } catch {
          // Ignore non-JSON startup output.
        }
      }
    });

    const waitFor = (id: number, timeoutMs: number) =>
      new Promise<unknown>((resolve, reject) => {
        if (responses.has(id)) {
          resolve(responses.get(id));
          return;
        }
        if (fatalError) {
          reject(fatalError);
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error("Codex quota unavailable"));
        }, timeoutMs);
        waiters.set(id, { timer, resolve, reject });
      });

    const initId = nextId++;
    sendRpc(child, initId, "initialize", {
      clientInfo: { name: "quota-axi", version: "1" },
    });
    await waitFor(initId, CLI_TIMEOUT_MS);

    const accountId = nextId++;
    sendRpc(child, accountId, "account/read");
    const account = await waitFor(accountId, RPC_TIMEOUT_MS).catch(
      () => undefined,
    );

    const limitsId = nextId++;
    sendRpc(child, limitsId, "account/rateLimits/read");
    const limits = await waitFor(limitsId, RPC_TIMEOUT_MS);

    const merged = mergeAccountAndLimits(account, limits);
    const quota = normalizeCodexUsage(merged);
    if (!quota || quota.windows.length === 0) {
      return { status: "failed", error: "Codex quota unavailable" };
    }

    const allExhausted = quota.windows.every(
      (w) => w.percentUsed !== undefined && w.percentUsed >= 100,
    );
    if (allExhausted) {
      return { status: "failed", error: "rate_limit_exceeded" };
    }

    return {
      status: "success",
      plan: quota.plan,
      account: quota.account,
      windows: quota.windows,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Codex probe failed",
    };
  } finally {
    if (child) {
      terminateChild(child);
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp dir cleanup
    }
  }
}

export type ProbeCredentialOutcome =
  | {
      status: "success";
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
    }
  | { status: "failed"; error: string }
  | { status: "unverified"; reason: "no_auth_material" | "no_cli" };

export async function probeCodexCredential(options: {
  cpaDir: string;
  authId: string;
  accountKey: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<ProbeCredentialOutcome> {
  const authPath = findCodexCredentialFile(options);
  if (!authPath) {
    return { status: "unverified", reason: "no_auth_material" };
  }

  const tokens = extractCodexTokensFromFile(authPath);
  if (!tokens || !tokens.accessToken) {
    return { status: "unverified", reason: "no_auth_material" };
  }

  const binary = await resolveCodexBinary(options.environment);
  if (binary.status === "missing") {
    return { status: "unverified", reason: "no_cli" };
  }

  const res = await probeCodexAppServer({
    binaryPath: binary.path,
    tokens,
    environment: options.environment,
  });

  if (res.status === "success") {
    return {
      status: "success",
      plan: res.plan,
      account: res.account,
      windows: res.windows ?? [],
    };
  }

  return {
    status: "failed",
    error: res.error ?? "Codex probe failed",
  };
}
