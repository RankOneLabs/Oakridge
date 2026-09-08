import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import { KbblConfigSchema, type KbblConfig } from "../config";
import type { SessionManager } from "../session/session-manager";
import type { AcpSessionService } from "../acp/session-service";
import type { createDispatcher } from "../orchestrator/backends/dispatcher";
import { openTestDb } from "../db/test-db";
import { createApp } from "./app";
import type { AuthPolicy } from "./auth";

let tmpRoot: string;
let configPath: string;
let db: Database;

function makeStubAcp(
  profiles: Array<{ id: string; label: string; enabled: boolean }>,
  defaultAgent = "claude-code",
): AcpSessionService {
  return {
    listProfiles: () => profiles,
    get defaultAgent() {
      return defaultAgent;
    },
  } as unknown as AcpSessionService;
}

function buildApp(
  config: KbblConfig,
  defaultWorkdir: string | null = "/tmp/test-workdir",
  acp: AcpSessionService = makeStubAcp([
    { id: "claude-code", label: "Claude Code (ACP)", enabled: true },
    { id: "codex", label: "Codex (ACP)", enabled: true },
  ]),
  authPolicy?: AuthPolicy,
): Hono {
  const dispatcher: ReturnType<typeof createDispatcher> = {
    dispatch: async () => { throw new Error("not used in config tests"); },
  };
  return createApp({
    manager: {} as unknown as SessionManager,
    acp,
    defaultWorkdir,
    handoffsDir: tmpRoot,
    pwaDistDir: tmpRoot,
    getBunServer: () => null,
    config,
    configPath,
    db,
    dispatcher,
    authPolicy,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-app-test-"));
  configPath = join(tmpRoot, "config.json");
  db = openTestDb();
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /config", () => {
  test("returns defaultWorkdir and softThresholdTokens", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultWorkdir: string | null; softThresholdTokens: number };
    expect(body.defaultWorkdir).toBe("/tmp/test-workdir");
    expect(body.softThresholdTokens).toBe(config.compact.soft_threshold_tokens);
  });

  test("returns launch choices for built-in ACP profiles", async () => {
    const acp = makeStubAcp(
      [
        { id: "claude-code", label: "Claude Code (ACP)", enabled: true },
        { id: "codex", label: "Codex (ACP)", enabled: true },
        { id: "disabled-agent", label: "Disabled", enabled: false },
      ],
      "codex",
    );
    const app = buildApp(KbblConfigSchema.parse({}), "/tmp/test-workdir", acp);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      defaultRuntimeId: string;
      runtimes: Array<{
        id: string;
        label: string;
        supportsCompaction: boolean;
        models: unknown[];
        efforts: unknown[];
      }>;
    };
    expect(body.defaultRuntimeId).toBe("codex");
    expect(body.runtimes).toHaveLength(2);
    expect(body.runtimes[0]).toMatchObject({
      id: "claude-code",
      label: "Claude Code (ACP)",
      supportsCompaction: false,
    });
    expect(body.runtimes[0]?.models).toContainEqual({
      value: "claude-fable-5-1",
      label: "fable 5.1",
    });
    expect(body.runtimes[0]?.efforts).toContainEqual({ value: "max", label: "max" });
    expect(body.runtimes[1]).toMatchObject({
      id: "codex",
      label: "Codex (ACP)",
      supportsCompaction: false,
    });
    expect(body.runtimes[1]?.models).toContainEqual({
      value: "gpt-6-astra",
      label: "gpt-6 astra",
    });
    expect(body.runtimes[1]?.efforts).toContainEqual({ value: "minimal", label: "minimal" });
  });

  test("allows a null defaultWorkdir", async () => {
    const app = buildApp(KbblConfigSchema.parse({}), null);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultWorkdir: string | null };
    expect(body.defaultWorkdir).toBeNull();
  });
});

describe("GET /dispatch-attempts auth", () => {
  test("requires token auth in token mode despite being a GET route", async () => {
    const app = buildApp(
      KbblConfigSchema.parse({}),
      "/tmp/test-workdir",
      undefined,
      { mode: "token", token: "secret" },
    );

    const missing = await app.request("/dispatch-attempts");
    expect(missing.status).toBe(401);

    const wrong = await app.request("/dispatch-attempts", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(403);

    const ok = await app.request("/dispatch-attempts", {
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ attempts: [] });
  });
});

describe("PATCH /config", () => {
  test("rejects invalid JSON body", async () => {
    const app = buildApp(KbblConfigSchema.parse({}));
    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid json/);
  });

  test("rejects empty body with no settable fields", async () => {
    const app = buildApp(KbblConfigSchema.parse({}));
    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no settable fields/);
  });

  test("rejects non-integer softThresholdTokens", async () => {
    const app = buildApp(KbblConfigSchema.parse({}));
    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ softThresholdTokens: 1.5 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/positive integer/);
  });

  test("rejects softThresholdTokens >= hard threshold", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);
    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ softThresholdTokens: config.compact.hard_threshold_tokens }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/< hardThresholdTokens/);
  });

  test("persists softThresholdTokens and returns the updated value", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const patchRes = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ softThresholdTokens: 12345 }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { softThresholdTokens: number };
    expect(patchBody.softThresholdTokens).toBe(12345);

    // In-memory config is mutated so the next GET reflects the new value.
    const getRes = await app.request("/config");
    const getBody = (await getRes.json()) as { softThresholdTokens: number };
    expect(getBody.softThresholdTokens).toBe(12345);

    // And the change is persisted to disk so it survives a server restart.
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
      compact: { soft_threshold_tokens: number };
    };
    expect(persisted.compact.soft_threshold_tokens).toBe(12345);
  });
});

describe("GET /directories", () => {
  test("lists child directories for the picker", async () => {
    mkdirSync(join(tmpRoot, "repo-a"));
    mkdirSync(join(tmpRoot, "repo-b"));
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);

    const res = await app.request(`/directories?path=${encodeURIComponent(tmpRoot)}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      entries: Array<{ name: string; path: string }>;
    };
    expect(body.path).toBe(tmpRoot);
    expect(body.entries.map((entry) => entry.name)).toEqual(["repo-a", "repo-b"]);
  });

  test("omits hidden child directories from the picker", async () => {
    mkdirSync(join(tmpRoot, ".hidden-repo"));
    mkdirSync(join(tmpRoot, "visible-repo"));
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);

    const res = await app.request(`/directories?path=${encodeURIComponent(tmpRoot)}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ name: string; path: string }>;
    };
    expect(body.entries.map((entry) => entry.name)).toEqual(["visible-repo"]);
  });

  test("rejects relative directory paths", async () => {
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);

    const res = await app.request("/directories?path=./relative");

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("path must be absolute");
  });

  test("rejects non-directory paths", async () => {
    const filePath = join(tmpRoot, "not-a-dir.txt");
    writeFileSync(filePath, "not a directory", "utf8");
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);

    const res = await app.request(`/directories?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("path is not a directory");
  });

  test("rejects paths outside allowed roots", async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "kbbl-app-outside-"));
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);
    try {
      const res = await app.request(`/directories?path=${encodeURIComponent(outsideRoot)}`);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "path is outside allowed directory roots",
      );
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test("allows paths under a root directory default workdir", async () => {
    const app = buildApp(KbblConfigSchema.parse({}), "/");

    const res = await app.request(`/directories?path=${encodeURIComponent(tmpRoot)}`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe(tmpRoot);
  });
});
