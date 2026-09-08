import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { RuntimeDescriptor } from "../../types";
import { RUNTIME_EFFORTS, RUNTIME_MODELS } from "../../../runtime";
import { newSessionModelKey } from "../../lib/storage";
import { NewSessionForm, type NewSessionFormValues } from "./NewSessionForm";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

const runtimes: RuntimeDescriptor[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    supportsCompaction: true,
    models: [...RUNTIME_MODELS["claude-code"]],
    efforts: [...RUNTIME_EFFORTS["claude-code"]],
  },
  {
    id: "codex",
    label: "Codex",
    supportsCompaction: false,
    models: [...RUNTIME_MODELS.codex],
    efforts: [...RUNTIME_EFFORTS.codex],
  },
];

function renderForm(onSubmit: (values: NewSessionFormValues) => void): void {
  render(
    <NewSessionForm
      defaultWorkdir="/tmp"
      defaultRuntimeId="claude-code"
      runtimes={runtimes}
      initialWorkdir={null}
      workdirTouchedInitial={false}
      pending={false}
      pendingError={null}
      autostartPending={false}
      onAutostartConsumed={() => {}}
      resetSignal={0}
      onSubmit={onSubmit}
    />,
  );
}

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

describe("NewSessionForm runtime model selection", () => {
  test("switching runtime changes model options", () => {
    renderForm(() => {});

    const modelSelect = screen.getByLabelText("Model for new session");
    expect(modelSelect).toHaveProperty("value", "claude-opus-5");
    expect(modelSelect.textContent).toContain("fable 5.1");
    expect(modelSelect.textContent).toContain("sonnet 4.6");
    expect(modelSelect.textContent).not.toContain("gpt-6 astra");

    fireEvent.change(screen.getByLabelText("Runtime for new session"), {
      target: { value: "codex" },
    });

    expect(modelSelect).toHaveProperty("value", "gpt-5.6-sol");
    expect(modelSelect.textContent).toContain("gpt-6 astra");
    expect(modelSelect.textContent).not.toContain("sonnet 4.6");
  });

  test("submit includes selected runtime and model", () => {
    let submitted: NewSessionFormValues | null = null;
    renderForm((values) => {
      submitted = values;
    });

    fireEvent.change(screen.getByLabelText("Runtime for new session"), {
      target: { value: "codex" },
    });
    fireEvent.change(screen.getByLabelText("Model for new session"), {
      target: { value: "gpt-5.6-sol" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "+ New" }));

    expect(submitted).toMatchObject({
      workdir: "/tmp",
      runtimeId: "codex",
      model: "gpt-5.6-sol",
    });
  });

  test("switching runtime preserves stored model preference", async () => {
    localStorage.setItem(newSessionModelKey("codex"), "gpt-5.6-sol");
    renderForm(() => {});

    fireEvent.change(screen.getByLabelText("Runtime for new session"), {
      target: { value: "codex" },
    });

    expect(screen.getByLabelText("Model for new session")).toHaveProperty(
      "value",
      "gpt-5.6-sol",
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Model for new session")).toHaveProperty(
        "value",
        "gpt-5.6-sol",
      );
    });
    expect(localStorage.getItem(newSessionModelKey("codex"))).toBe("gpt-5.6-sol");
  });
});
