import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { isRuntimeId, type RuntimeId } from "../../runtime-interface";
import type { RuntimeDescriptor, RuntimeModelOption } from "../types";
import { PWA_MODEL_OPTIONS } from "../lib/format";

interface ServerConfigResponse {
  defaultWorkdir: string | null;
  softThresholdTokens?: number;
  defaultRuntimeId?: string;
  runtimes?: unknown;
}

export interface ServerConfig {
  defaultWorkdir: string | null;
  softThresholdTokens?: number;
  defaultRuntimeId: RuntimeId;
  runtimes: RuntimeDescriptor[];
}

export type RuntimeDescriptors = [RuntimeDescriptor, ...RuntimeDescriptor[]];

export function runtimeDescriptorsForConfig(
  serverConfig: ServerConfig | null,
): RuntimeDescriptors {
  const runtimes = serverConfig?.runtimes ?? [];
  if (runtimes.length === 0) return [fallbackClaudeDescriptor()];
  const [first, ...rest] = runtimes;
  return [first, ...rest];
}

export function defaultRuntimeIdForConfig(serverConfig: ServerConfig | null): RuntimeId {
  const runtimes = runtimeDescriptorsForConfig(serverConfig);
  const rawId = serverConfig?.defaultRuntimeId;
  return rawId && runtimes.some((runtime) => runtime.id === rawId) ? rawId : runtimes[0].id;
}

function fallbackClaudeDescriptor(): RuntimeDescriptor {
  return {
    id: "claude-code",
    label: "Claude Code",
    models: PWA_MODEL_OPTIONS.filter((o) => o.value !== "").map((o) => ({
      value: o.value,
      label: o.label,
    })),
    // No efforts in the pre-/config fallback: PWA_EFFORT_OPTIONS is a
    // cross-runtime union (includes Codex-only levels like "minimal"), so
    // advertising it under this claude-code descriptor would offer a level the
    // backend rejects for CC. Leave empty until /config supplies the real
    // per-runtime effort set; the picker simply doesn't render meanwhile.
    efforts: [],
    supportsCompaction: true,
  };
}

// Coerces a value/label option array from the server response. Shared by the
// model and effort descriptor fields (identical shape).
function coerceRuntimeModels(value: unknown): RuntimeModelOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const model = raw as { value?: unknown; label?: unknown };
    if (typeof model.value !== "string") return [];
    return [{
      value: model.value,
      label: typeof model.label === "string" ? model.label : model.value,
    }];
  });
}

function coerceRuntimeDescriptors(value: unknown): [RuntimeDescriptor, ...RuntimeDescriptor[]] {
  if (!Array.isArray(value)) return [fallbackClaudeDescriptor()];
  const runtimes = value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const runtime = raw as {
      id?: unknown;
      label?: unknown;
      models?: unknown;
      efforts?: unknown;
      supportsCompaction?: unknown;
    };
    if (!isRuntimeId(runtime.id)) return [];
    return [{
      id: runtime.id,
      label: typeof runtime.label === "string" ? runtime.label : runtime.id,
      models: coerceRuntimeModels(runtime.models),
      efforts: coerceRuntimeModels(runtime.efforts),
      supportsCompaction: runtime.supportsCompaction === true,
    }];
  });
  if (runtimes.length === 0) return [fallbackClaudeDescriptor()];
  const [first, ...rest] = runtimes;
  return [first, ...rest];
}

/**
 * Fetches the server's /config once. Returns null until the fetch resolves
 * so callers can render a "loading" placeholder rather than racing forms
 * with empty defaults. Cached indefinitely — the server's config doesn't
 * change mid-session, and SessionTopBar's PATCH /config invalidates this
 * query so the next read reflects the server response.
 */
export function useServerConfig(): ServerConfig | null {
  const query = useQuery({
    queryKey: ["config"],
    queryFn: async (): Promise<ServerConfigResponse> => {
      const res = await fetch("/config");
      if (!res.ok) throw new Error(`config: ${res.status}`);
      return (await res.json()) as ServerConfigResponse;
    },
    staleTime: Infinity,
  });
  return useMemo(() => {
    if (!query.data) return null;
    const runtimes = coerceRuntimeDescriptors(query.data.runtimes);
    return {
      defaultWorkdir: query.data.defaultWorkdir,
      softThresholdTokens:
        typeof query.data.softThresholdTokens === "number"
          ? query.data.softThresholdTokens
          : undefined,
      defaultRuntimeId: defaultRuntimeIdForConfig({
        defaultWorkdir: query.data.defaultWorkdir,
        softThresholdTokens: query.data.softThresholdTokens,
        defaultRuntimeId: isRuntimeId(query.data.defaultRuntimeId)
          ? query.data.defaultRuntimeId
          : "claude-code",
        runtimes,
      }),
      runtimes,
    };
  }, [query.data]);
}
