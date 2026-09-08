// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type React from "react";

import { AddSpecModal, coerceSelection } from "./AddSpecModal";
import type { RuntimeDescriptor } from "../types";

const originalFetch = globalThis.fetch;

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

type Config = {
  defaultWorkdir: string;
  defaultRuntimeId: string;
  runtimes: Array<{
    id: string;
    label: string;
    supportsCompaction: boolean;
    models: Array<{ value: string; label: string }>;
    efforts?: Array<{ value: string; label: string }>;
  }>;
};

function stubFetch(config: Config, onCreate?: (body: unknown) => void) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/config") {
      return new Response(JSON.stringify(config), { status: 200 });
    }
    if (url === "/specs" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      onCreate?.(body);
      return new Response(JSON.stringify({ id: "spec-1" }), { status: 201 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function getSelectOptions(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((option) => option.value);
}

const CODEX_MODELS: Array<{ value: string; label: string }> = [
  { value: "gpt-5.6-sol", label: "gpt-5.6 sol" },
  { value: "gpt-5.6-terra", label: "gpt-5.6 terra" },
  { value: "gpt-5.6-luna", label: "gpt-5.6 luna" },
  { value: "gpt-5.5", label: "gpt-5.5" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  { value: "gpt-5.3-codex-spark", label: "gpt-5.3 codex spark" },
];

describe("AddSpecModal split role selection", () => {
  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch;
    }
  });

  test("defaults planner and worker independently and submits split model selections", async () => {
    let postBody: unknown = null;
    stubFetch(
      {
        defaultWorkdir: "/tmp/repo",
        defaultRuntimeId: "codex",
        runtimes: [
          {
            id: "claude-code",
            label: "Claude Code",
            supportsCompaction: true,
            models: [
              { value: "claude-opus-4-8", label: "opus 4.8" },
              { value: "claude-sonnet-4-6", label: "sonnet 4.6" },
            ],
          },
          {
            id: "codex",
            label: "Codex",
            supportsCompaction: false,
            models: CODEX_MODELS,
          },
        ],
      },
      (body) => {
        postBody = body;
      },
    );

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "codex");
    });

    expect(screen.getByLabelText("Planner model")).toHaveProperty("value", "gpt-5.6-sol");
    expect(screen.getByLabelText("Worker runtime")).toHaveProperty("value", "codex");
    expect(screen.getByLabelText("Worker model")).toHaveProperty("value", "gpt-5.6-sol");

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Build the thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        project_id: "project-1",
        title: "Build the thing",
        planner_model_selection: { runtime: "codex", model: "gpt-5.6-sol" },
        worker_model_selection: { runtime: "codex", model: "gpt-5.6-sol" },
      });
    });
    expect(Object.keys(postBody as Record<string, unknown>).sort()).toEqual([
      "planner_model_selection",
      "project_id",
      "title",
      "worker_model_selection",
    ]);
  });

  test("submits a selected planner effort when the runtime advertises efforts", async () => {
    let postBody: unknown = null;
    stubFetch(
      {
        defaultWorkdir: "/tmp/repo",
        defaultRuntimeId: "claude-code",
        runtimes: [
          {
            id: "claude-code",
            label: "Claude Code",
            supportsCompaction: true,
            models: [{ value: "claude-opus-4-8", label: "opus 4.8" }],
            efforts: [
              { value: "medium", label: "medium" },
              { value: "high", label: "high" },
            ],
          },
        ],
      },
      (body) => {
        postBody = body;
      },
    );

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    // Wait until /config resolves and the modal adopts the stub descriptor's
    // efforts (the pre-config fallback descriptor advertises a different set).
    await waitFor(() => {
      expect(
        getSelectOptions(screen.getByLabelText("Planner effort") as HTMLSelectElement),
      ).toEqual(["", "medium", "high"]);
    });
    // Default is "" (runtime default) until the operator picks a level.
    expect(screen.getByLabelText("Planner effort")).toHaveProperty("value", "");

    fireEvent.change(screen.getByLabelText("Planner effort"), {
      target: { value: "high" },
    });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Effort thing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        planner_model_selection: { runtime: "claude-code", model: "claude-opus-4-8", effort: "high" },
      });
    });
  });

  test("keeps planner and worker model scopes independent when runtimes change", async () => {
    stubFetch({
      defaultWorkdir: "/tmp/repo",
      defaultRuntimeId: "codex",
      runtimes: [
        {
          id: "claude-code",
          label: "Claude Code",
          supportsCompaction: true,
          models: [
            { value: "claude-opus-4-8", label: "opus 4.8" },
            { value: "claude-sonnet-4-6", label: "sonnet 4.6" },
          ],
        },
        {
          id: "codex",
          label: "Codex",
          supportsCompaction: false,
          models: CODEX_MODELS,
        },
      ],
    });

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "codex");
    });

    fireEvent.change(screen.getByLabelText("Planner runtime"), {
      target: { value: "claude-code" },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "claude-code");
    });
    expect(screen.getByLabelText("Planner model")).toHaveProperty("value", "claude-opus-4-8");
    expect(getSelectOptions(screen.getByLabelText("Planner model") as HTMLSelectElement)).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ]);
    expect(screen.getByLabelText("Worker runtime")).toHaveProperty("value", "codex");
    expect(screen.getByLabelText("Worker model")).toHaveProperty("value", "gpt-5.6-sol");
    expect(getSelectOptions(screen.getByLabelText("Worker model") as HTMLSelectElement)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);

    fireEvent.change(screen.getByLabelText("Worker runtime"), {
      target: { value: "claude-code" },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Worker runtime")).toHaveProperty("value", "claude-code");
    });
    expect(screen.getByLabelText("Worker model")).toHaveProperty("value", "claude-opus-4-8");
    expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "claude-code");
    expect(screen.getByLabelText("Planner model")).toHaveProperty("value", "claude-opus-4-8");
  });

  test("keeps the model field editable when a runtime exposes no enumerable models", async () => {
    let postBody: unknown = null;
    stubFetch(
      {
        defaultWorkdir: "/tmp/repo",
        defaultRuntimeId: "codex",
        runtimes: [
          {
            id: "codex",
            label: "Codex",
            supportsCompaction: false,
            models: [],
          },
        ],
      },
      (body) => {
        postBody = body;
      },
    );

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "codex");
    });
    expect(screen.getByLabelText("Planner model").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Worker model").tagName).toBe("INPUT");

    fireEvent.change(screen.getByLabelText("Planner model"), {
      target: { value: "custom-planner-model" },
    });
    fireEvent.change(screen.getByLabelText("Worker model"), {
      target: { value: "custom-worker-model" },
    });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "No model runtime" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        title: "No model runtime",
        planner_model_selection: { runtime: "codex", model: "custom-planner-model" },
        worker_model_selection: { runtime: "codex", model: "custom-worker-model" },
      });
    });
  });

  test("submits notes loaded from an uploaded file", async () => {
    let postBody: unknown = null;
    stubFetch(
      {
        defaultWorkdir: "/tmp/repo",
        defaultRuntimeId: "codex",
        runtimes: [
          {
            id: "codex",
            label: "Codex",
            supportsCompaction: false,
            models: CODEX_MODELS,
          },
        ],
      },
      (body) => {
        postBody = body;
      },
    );

    renderWithClient(
      <AddSpecModal
        project={{ id: "project-1", name: "Project", repo_path: "/tmp/repo" }}
        onCreated={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Planner runtime")).toHaveProperty("value", "codex");
    });

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "From a file" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    const content = "spec from file\nline two";
    const file = new File([content], "spec.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(screen.getByLabelText("Notes file"), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Notes preview")).toHaveProperty("value", content);
    });

    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "manual notes" },
    });
    expect(screen.queryByText(/Loaded spec\.md —/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    expect(screen.queryByText(/Loaded spec\.md —/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(postBody).toMatchObject({
        title: "From a file",
        notes: "manual notes",
        planner_model_selection: { runtime: "codex", model: "gpt-5.6-sol" },
        worker_model_selection: { runtime: "codex", model: "gpt-5.6-sol" },
      });
    });
  });
});

describe("coerceSelection effort handling", () => {
  const claude: RuntimeDescriptor = {
    id: "claude-code",
    label: "Claude Code",
    models: [{ value: "claude-opus-4-8", label: "opus 4.8" }],
    efforts: [
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
    supportsCompaction: true,
  };
  const codex: RuntimeDescriptor = {
    id: "codex",
    label: "Codex",
    models: [{ value: "gpt-5.6-sol", label: "gpt-5.6 sol" }],
    efforts: [{ value: "minimal", label: "minimal" }],
    supportsCompaction: false,
  };
  const descriptors = [claude, codex];

  test("preserves an effort still valid for the unchanged runtime", () => {
    const next = coerceSelection(
      "planner",
      { runtime: "claude-code", model: "claude-opus-4-8", effort: "high" },
      descriptors,
      "codex", // default differs; runtimeTouched=true keeps the selected runtime
      true,
    );
    expect(next.effort).toBe("high");
  });

  test("drops an effort the (swapped) descriptor no longer advertises", () => {
    // Same runtime id, but the descriptor's effort set no longer includes the
    // stale level (e.g. fallback → server descriptor swap). Force a re-coerce
    // by changing the model so the early same-selection return is skipped.
    const next = coerceSelection(
      "planner",
      { runtime: "claude-code", model: "stale-model", effort: "minimal" },
      descriptors,
      "codex",
      true,
    );
    expect(next.effort).toBeUndefined();
  });

  test("drops the effort when the runtime changes", () => {
    const next = coerceSelection(
      "planner",
      { runtime: "codex", model: "gpt-5.6-sol", effort: "minimal" },
      descriptors,
      "claude-code",
      false, // not touched → coerces back to the default (claude-code) runtime
    );
    expect(next.runtime).toBe("claude-code");
    expect(next.effort).toBeUndefined();
  });
});
