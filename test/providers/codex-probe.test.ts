import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractCodexTokensFromFile,
  findCodexCredentialFile,
  probeCodexCredential,
  resolveCodexBinary,
  sendRpc,
} from "../../src/providers/codex-probe.js";

describe("Codex probe helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-codex-probe-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("extractCodexTokensFromFile", () => {
    it("extracts tokens from nested tokens object", () => {
      const filePath = join(tempDir, "auth.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          tokens: {
            access_token: "test-access-token",
            account_id: "acct-123",
            id_token: "test-id-token",
            refresh_token: "test-refresh-token",
          },
        }),
        "utf8",
      );

      const tokens = extractCodexTokensFromFile(filePath);
      expect(tokens).toEqual({
        accessToken: "test-access-token",
        accountId: "acct-123",
        idToken: "test-id-token",
        refreshToken: "test-refresh-token",
      });
    });

    it("extracts tokens from root-level fields (camelCase and snake_case)", () => {
      const filePath = join(tempDir, "auth-root.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          accessToken: "camel-access",
          accountId: "camel-acct",
        }),
        "utf8",
      );

      const tokens = extractCodexTokensFromFile(filePath);
      expect(tokens).toEqual({
        accessToken: "camel-access",
        accountId: "camel-acct",
        idToken: undefined,
        refreshToken: undefined,
      });
    });

    it("returns undefined for missing or invalid JSON", () => {
      expect(
        extractCodexTokensFromFile(join(tempDir, "nonexistent.json")),
      ).toBeUndefined();

      const corruptPath = join(tempDir, "corrupt.json");
      writeFileSync(corruptPath, "not-json", "utf8");
      expect(extractCodexTokensFromFile(corruptPath)).toBeUndefined();
    });

    it("returns undefined when access_token is empty or missing", () => {
      const emptyPath = join(tempDir, "empty.json");
      writeFileSync(emptyPath, JSON.stringify({ tokens: {} }), "utf8");
      expect(extractCodexTokensFromFile(emptyPath)).toBeUndefined();
    });
  });

  describe("findCodexCredentialFile", () => {
    it("finds credential file in CPA dir by authId with or without .json suffix", () => {
      const credFile = join(tempDir, "acc1.json");
      writeFileSync(credFile, "{}", "utf8");

      expect(
        findCodexCredentialFile({
          cpaDir: tempDir,
          authId: "acc1.json",
          accountKey: "acc1.json",
        }),
      ).toBe(credFile);

      expect(
        findCodexCredentialFile({
          cpaDir: tempDir,
          authId: "acc1",
          accountKey: "acc1",
        }),
      ).toBe(credFile);
    });

    it("returns undefined when no credential file exists", () => {
      expect(
        findCodexCredentialFile({
          cpaDir: tempDir,
          authId: "nonexistent",
          accountKey: "nonexistent",
        }),
      ).toBeUndefined();
    });
  });

  describe("resolveCodexBinary", () => {
    it("returns missing when configured binary path is not absolute", async () => {
      const result = await resolveCodexBinary({
        QUOTA_AXI_CODEX_BINARY: "relative/path",
      });
      expect(result.status).toBe("missing");
      if (result.status === "missing") {
        expect(result.error).toBe("codex_binary_override_not_absolute");
      }
    });

    it("returns missing when configured binary path does not exist", async () => {
      const result = await resolveCodexBinary({
        QUOTA_AXI_CODEX_BINARY: "/nonexistent/binary/path",
      });
      expect(result.status).toBe("missing");
      if (result.status === "missing") {
        expect(result.error).toBe("codex_binary_override_not_executable");
      }
    });
  });

  describe("sendRpc", () => {
    it("writes formatted JSON RPC request with trailing newline", () => {
      const written: string[] = [];
      const fakeChild = {
        stdin: {
          writable: true,
          write: (chunk: string) => {
            written.push(chunk);
          },
        },
      };

      sendRpc(fakeChild, 1, "initialize", { client: "test" });
      expect(written).toEqual([
        `${JSON.stringify({ id: 1, method: "initialize", params: { client: "test" } })}\n`,
      ]);
    });

    it("handles null or non-writable stdin safely", () => {
      expect(() => sendRpc({ stdin: null }, 1, "test")).not.toThrow();
      expect(() =>
        sendRpc({ stdin: { writable: false, write: () => {} } }, 1, "test"),
      ).not.toThrow();
    });
  });

  describe("probeCodexCredential", () => {
    it("returns unverified when no auth file exists", async () => {
      const result = await probeCodexCredential({
        cpaDir: tempDir,
        authId: "missing-auth.json",
        accountKey: "missing-auth.json",
      });
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("no_auth_material");
      }
    });

    it("returns unverified when auth file has no access token", async () => {
      const credFile = join(tempDir, "no-token.json");
      writeFileSync(credFile, JSON.stringify({}), "utf8");

      const result = await probeCodexCredential({
        cpaDir: tempDir,
        authId: "no-token.json",
        accountKey: "no-token.json",
      });
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("no_auth_material");
      }
    });

    it("returns unverified when codex binary is unavailable", async () => {
      const credFile = join(tempDir, "has-token.json");
      writeFileSync(
        credFile,
        JSON.stringify({ tokens: { access_token: "test-token" } }),
        "utf8",
      );

      const result = await probeCodexCredential({
        cpaDir: tempDir,
        authId: "has-token.json",
        accountKey: "has-token.json",
        environment: {
          QUOTA_AXI_CODEX_BINARY: "/nonexistent/codex",
          PATH: "",
        },
      });
      expect(result.status).toBe("unverified");
      if (result.status === "unverified") {
        expect(result.reason).toBe("no_cli");
      }
    });
  });
});
