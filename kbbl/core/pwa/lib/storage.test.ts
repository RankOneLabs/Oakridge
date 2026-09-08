import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  newSessionModelKey,
  readStoredNewSessionModel,
  writeStoredNewSessionModel,
} from "./storage";
import type { RuntimeDescriptor } from "../types";
import { RUNTIME_EFFORTS, RUNTIME_MODELS } from "../../runtime";

const claudeRuntime: RuntimeDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  supportsCompaction: true,
  models: [...RUNTIME_MODELS["claude-code"]],
  efforts: [...RUNTIME_EFFORTS["claude-code"]],
};

const codexRuntime: RuntimeDescriptor = {
  id: "codex",
  label: "Codex",
  supportsCompaction: false,
  models: [...RUNTIME_MODELS.codex],
  efforts: [...RUNTIME_EFFORTS.codex],
};

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  clear(): void {
    this.values.clear();
  }
}

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

afterEach(() => {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
    return;
  }
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("new session model storage", () => {
  test("preserves supported Codex model writes", () => {
    const normalized = writeStoredNewSessionModel("gpt-5.6-sol", codexRuntime);

    expect(normalized).toBe("gpt-5.6-sol");
    expect(localStorage.getItem(newSessionModelKey("codex"))).toBe("gpt-5.6-sol");
    expect(readStoredNewSessionModel(codexRuntime)).toBe("gpt-5.6-sol");
  });

  test("coerces unsupported model writes to runtime default", () => {
    const normalized = writeStoredNewSessionModel("claude-sonnet-4-6", codexRuntime);

    expect(normalized).toBe("gpt-5.6-sol");
    expect(localStorage.getItem(newSessionModelKey("codex"))).toBe("gpt-5.6-sol");
    expect(readStoredNewSessionModel(codexRuntime)).toBe("gpt-5.6-sol");
  });

  test("preserves supported Claude model writes", () => {
    const normalized = writeStoredNewSessionModel("claude-opus-5", claudeRuntime);

    expect(normalized).toBe("claude-opus-5");
    expect(localStorage.getItem(newSessionModelKey("claude-code"))).toBe(
      "claude-opus-5",
    );
    expect(readStoredNewSessionModel(claudeRuntime)).toBe("claude-opus-5");
  });

  test("stores runtime preferences independently", () => {
    writeStoredNewSessionModel("claude-opus-5", claudeRuntime);
    writeStoredNewSessionModel("gpt-5.6-sol", codexRuntime);

    expect(readStoredNewSessionModel(claudeRuntime)).toBe("claude-opus-5");
    expect(readStoredNewSessionModel(codexRuntime)).toBe("gpt-5.6-sol");
  });

  test("uses Opus and Sol when no preference is stored", () => {
    expect(readStoredNewSessionModel(claudeRuntime)).toBe("claude-opus-5");
    expect(readStoredNewSessionModel(codexRuntime)).toBe("gpt-5.6-sol");
  });
});
