// Runtime identity + launch/config surface (§12, §20.2).
//
// The provider-adapter contract (AgentRuntime, RuntimeRegistry,
// classifyEvent, the RuntimeEvent union, the conformance harness) is gone
// with the legacy per-session state machine — the ACP substrate
// (core/acp/*) replaced it, and no adapter ever implemented this contract
// against ACP. What survives here is the small vocabulary the launch and
// config surfaces still use directly: which runtime ids exist, their
// descriptors (label/models/efforts), and default-model lookup.

export type RuntimeId = "claude-code" | "codex";

export function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "claude-code" || value === "codex";
}

export interface RuntimeDescriptor {
  id: RuntimeId;
  label: string;
  models: readonly { value: string; label: string }[];
  /**
   * Reasoning/effort levels this runtime accepts, most-effort-last. Empty for
   * runtimes with no effort control. The PWA renders these as an effort picker
   * (prepending a "default" = unset option) exactly as it does `models`. Values
   * differ per runtime (CC: low..max; Codex: minimal..max), so each adapter
   * advertises its own set rather than sharing a global enum.
   */
  efforts: readonly { value: string; label: string }[];
  supportsCompaction: boolean;
}

export interface RuntimeOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Built-in choices used by the single-session launcher and Oakridge v2's
 * planner/worker pickers before a session exists. Once a session has started,
 * the agent's ACP config options are authoritative and may be more specific to
 * the operator's account or configuration.
 */
export const RUNTIME_MODELS: Readonly<Record<RuntimeId, readonly RuntimeOption[]>> = {
  "claude-code": [
    { value: "claude-fable-5-1", label: "fable 5.1" },
    { value: "claude-fable-5", label: "fable 5" },
    { value: "claude-opus-5", label: "opus 5" },
    { value: "claude-sonnet-5", label: "sonnet 5" },
    { value: "claude-sonnet-4-6", label: "sonnet 4.6" },
    { value: "claude-opus-4-8", label: "opus 4.8" },
    { value: "claude-opus-4-7", label: "opus 4.7" },
    { value: "claude-haiku-4-5-20251001", label: "haiku 4.5" },
  ],
  codex: [
    { value: "gpt-6-astra", label: "gpt-6 astra" },
    { value: "gpt-5.6-sol", label: "gpt-5.6 sol" },
    { value: "gpt-5.6-terra", label: "gpt-5.6 terra" },
    { value: "gpt-5.6-luna", label: "gpt-5.6 luna" },
    { value: "gpt-5.5", label: "gpt-5.5" },
    { value: "gpt-5.4", label: "gpt-5.4" },
    { value: "gpt-5.4-mini", label: "gpt-5.4 mini" },
    { value: "gpt-5.3-codex-spark", label: "gpt-5.3 codex spark" },
  ],
};

export const RUNTIME_EFFORTS: Readonly<Record<RuntimeId, readonly RuntimeOption[]>> = {
  "claude-code": [
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
    { value: "max", label: "max" },
  ],
  codex: [
    { value: "minimal", label: "minimal" },
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
    { value: "max", label: "max" },
  ],
};

export type RuntimeModelSelection = {
  runtime: RuntimeId;
  model: string;
  /**
   * Reasoning/effort level for this role's sessions. Omitted / null means "no
   * override — use the runtime default", mirroring standalone sessions. Model
   * defaults are pinned per runtime; effort has no convention worth forcing.
   */
  effort?: string | null;
};

const DEFAULT_MODEL_BY_RUNTIME: Record<RuntimeId, string> = {
  "claude-code": "claude-opus-5",
  codex: "gpt-5.6-sol",
};

export function defaultModelForRuntime(runtimeId: RuntimeId): string {
  return DEFAULT_MODEL_BY_RUNTIME[runtimeId];
}

export function defaultPlannerModelForRuntime(runtimeId: RuntimeId): string {
  return defaultModelForRuntime(runtimeId);
}

export function defaultWorkerModelForRuntime(runtimeId: RuntimeId): string {
  return defaultModelForRuntime(runtimeId);
}

/** Minimal shape `isAllowedModelForRuntime` needs from a runtime descriptor
 * lookup — narrower than the old AgentRuntime contract, since it needs
 * nothing beyond the descriptor and an optional adapter-native validator. */
export interface RuntimeDescriptorLookup {
  descriptor: RuntimeDescriptor;
  isAllowedModel?(model: string): boolean;
}

export function isAllowedModelForRuntime(
  runtime: RuntimeDescriptorLookup | undefined,
  model: string,
): boolean {
  const trimmedModel = model.trim();
  if (runtime?.isAllowedModel) return runtime.isAllowedModel(trimmedModel);
  const declaredModels = runtime?.descriptor.models ?? [];
  if (declaredModels.length > 0) {
    return declaredModels.some((m) => m.value === trimmedModel);
  }
  return trimmedModel.length > 0;
}
