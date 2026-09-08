import { RUNTIME_MODELS } from "../../runtime";

export const PWA_MODEL_OPTIONS = [
  ...RUNTIME_MODELS["claude-code"],
  { value: "", label: "default" },
] as const;

export function prettyModelLabel(model: string): string {
  return PWA_MODEL_OPTIONS.find((o) => o.value === model)?.label ?? model;
}

// Union of every runtime's effort levels, used only as the fallback effort
// list (no server descriptor) and for pretty labels. The live picker reads the
// selected runtime's descriptor.efforts, so this need not match any single
// runtime exactly. "" is the "use the runtime default" sentinel.
export const PWA_EFFORT_OPTIONS = [
  { value: "minimal", label: "minimal" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
  { value: "", label: "default" },
] as const;

export function prettyEffortLabel(effort: string): string {
  return PWA_EFFORT_OPTIONS.find((o) => o.value === effort)?.label ?? effort;
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tokens`;
  return `${(n / 1_000_000).toFixed(1)}M tokens`;
}

export function fmtTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtDuration(ms: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Round to total seconds first, then split — splitting independently lets
  // the seconds round up to 60 and produce strings like "1m60s".
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m${secs.toString().padStart(2, "0")}s`;
}

export function fmtCost(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  if (cost < 0.9995) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
