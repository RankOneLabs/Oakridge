import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { RUNTIME_EFFORTS, RUNTIME_MODELS } from "../../../../runtime";
import type { RuntimeDescriptors } from "../../../hooks/useServerConfig";
import { roleDefaultModel } from "../../lib/runtime-selection";
import { RoleModelPicker } from "./RoleModelPicker";

const runtimeDescriptors: RuntimeDescriptors = [
  {
    id: "claude-code",
    label: "Claude Code",
    models: [...RUNTIME_MODELS["claude-code"]],
    efforts: [...RUNTIME_EFFORTS["claude-code"]],
    supportsCompaction: false,
  },
  {
    id: "codex",
    label: "Codex",
    models: [...RUNTIME_MODELS.codex],
    efforts: [...RUNTIME_EFFORTS.codex],
    supportsCompaction: false,
  },
];

describe("Oakridge v2 role model choices", () => {
  test("uses Opus and Sol as both role defaults", () => {
    for (const role of ["planner", "worker"] as const) {
      expect(roleDefaultModel(role, runtimeDescriptors[0])).toBe("claude-opus-5");
      expect(roleDefaultModel(role, runtimeDescriptors[1])).toBe("gpt-5.6-sol");
    }
  });

  test("switches between the Claude Code and Codex launch catalogs", () => {
    const setSelection = vi.fn();
    const view = render(
      <RoleModelPicker
        role="planner"
        selection={{ runtime: "claude-code", model: "claude-opus-5" }}
        setSelection={setSelection}
        setRuntimeTouched={() => {}}
        runtimeDescriptors={runtimeDescriptors}
        defaultRuntimeId="claude-code"
        isPending={false}
      />,
    );

    expect(screen.getByLabelText("Planner model").textContent).toContain("fable 5.1");
    expect(screen.getByLabelText("Planner model").textContent).toContain("opus 4.8");
    expect(screen.getByLabelText("Planner effort").textContent).toContain("max");

    fireEvent.change(screen.getByLabelText("Planner runtime"), {
      target: { value: "codex" },
    });
    expect(setSelection).toHaveBeenCalledWith({
      runtime: "codex",
      model: "gpt-5.6-sol",
    });

    view.rerender(
      <RoleModelPicker
        role="planner"
        selection={{ runtime: "codex", model: "gpt-5.6-sol" }}
        setSelection={setSelection}
        setRuntimeTouched={() => {}}
        runtimeDescriptors={runtimeDescriptors}
        defaultRuntimeId="claude-code"
        isPending={false}
      />,
    );

    expect(screen.getByLabelText("Planner model").textContent).toContain("gpt-6 astra");
    expect(screen.getByLabelText("Planner effort").textContent).toContain("minimal");
  });
});
