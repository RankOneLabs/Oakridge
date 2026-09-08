import type { Theme } from "../types";
import type { RuntimeDescriptor } from "../types";
import { defaultModelForRuntime } from "../../runtime";

export const THEME_STORAGE_KEY = "oakridge.theme";
/**
 * @deprecated Use runtimeId-namespaced keys via newSessionModelKey().
 * Kept for the migration read path so existing stored values are preserved.
 */
export const NEW_SESSION_MODEL_STORAGE_KEY = "oakridge.newSessionModel";

/**
 * Returns the localStorage key for per-runtime model preference.
 * Format: `kbbl.newSession.model.<runtimeId>` (e.g.
 * `kbbl.newSession.model.claude-code`).
 */
export function newSessionModelKey(runtimeId: string): string {
  return `kbbl.newSession.model.${runtimeId}`;
}

export function isValidNewSessionModelForRuntime(
  value: string,
  runtime: RuntimeDescriptor,
): boolean {
  if (value === "") return true;
  return runtime.models.some((o) => o.value === value);
}

export function defaultNewSessionModelForRuntime(runtime: RuntimeDescriptor): string {
  const preferred = defaultModelForRuntime(runtime.id);
  return runtime.models.some((option) => option.value === preferred)
    ? preferred
    : "";
}

export function normalizeNewSessionModelForRuntime(
  value: string,
  runtime: RuntimeDescriptor,
): string {
  if (isValidNewSessionModelForRuntime(value, runtime)) return value;
  return defaultNewSessionModelForRuntime(runtime);
}

/**
 * Read the stored model for the given runtime. Falls back to the legacy
 * un-namespaced key so existing stored values are preserved on first access
 * after the migration.
 */
export function readStoredNewSessionModel(runtime: RuntimeDescriptor): string {
  try {
    const namespacedKey = newSessionModelKey(runtime.id);
    const namespaced = localStorage.getItem(namespacedKey);
    if (
      namespaced !== null &&
      isValidNewSessionModelForRuntime(namespaced, runtime)
    ) {
      return namespaced;
    }
    // Migration: read legacy key once, migrate to namespaced key.
    const legacy = localStorage.getItem(NEW_SESSION_MODEL_STORAGE_KEY);
    if (
      legacy !== null &&
      isValidNewSessionModelForRuntime(legacy, runtime)
    ) {
      try { localStorage.setItem(namespacedKey, legacy); } catch {}
      return legacy;
    }
  } catch {}
  return defaultNewSessionModelForRuntime(runtime);
}

/**
 * Write the stored model for the given runtime.
 */
export function writeStoredNewSessionModel(value: string, runtime: RuntimeDescriptor): string {
  const normalized = normalizeNewSessionModelForRuntime(value, runtime);
  try {
    localStorage.setItem(
      newSessionModelKey(runtime.id),
      normalized,
    );
  } catch {}
  return normalized;
}

/**
 * Returns the localStorage key for per-runtime effort preference.
 * Format: `kbbl.newSession.effort.<runtimeId>`. No legacy un-namespaced key
 * exists (effort is a newer control), so there's no migration read path.
 */
export function newSessionEffortKey(runtimeId: string): string {
  return `kbbl.newSession.effort.${runtimeId}`;
}

export function isValidNewSessionEffortForRuntime(
  value: string,
  runtime: RuntimeDescriptor,
): boolean {
  if (value === "") return true;
  return runtime.efforts.some((o) => o.value === value);
}

/**
 * Default effort is "" (no override → the runtime's own default). Unlike
 * model, there's no cost-engineering nudge — effort defaults are the runtime's
 * concern, and silently forcing one could surprise operators.
 */
export function defaultNewSessionEffortForRuntime(runtime: RuntimeDescriptor): string {
  void runtime;
  return "";
}

export function normalizeNewSessionEffortForRuntime(
  value: string,
  runtime: RuntimeDescriptor,
): string {
  if (isValidNewSessionEffortForRuntime(value, runtime)) return value;
  return defaultNewSessionEffortForRuntime(runtime);
}

export function readStoredNewSessionEffort(runtime: RuntimeDescriptor): string {
  try {
    const stored = localStorage.getItem(newSessionEffortKey(runtime.id));
    if (stored !== null && isValidNewSessionEffortForRuntime(stored, runtime)) {
      return stored;
    }
  } catch {}
  return defaultNewSessionEffortForRuntime(runtime);
}

export function writeStoredNewSessionEffort(value: string, runtime: RuntimeDescriptor): string {
  const normalized = normalizeNewSessionEffortForRuntime(value, runtime);
  try {
    localStorage.setItem(newSessionEffortKey(runtime.id), normalized);
  } catch {}
  return normalized;
}

export function readStoredTheme(): Theme {
  // SSR-safe guard; also swallows SecurityError from sandboxed localStorage.
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "dark";
}
