import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

export interface EnvelopeEvent {
  id: number;
  type: string;
  ts: string;
  payload: unknown;
}

type Status = "connecting" | "connected" | "disconnected";
type ResolutionMap = Map<string, "allow" | "deny">;

export function App() {
  const [events, setEvents] = useState<EnvelopeEvent[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  // Maintain the resolutions map incrementally (O(1) per event) rather than
  // recomputing across the whole events array on every render.
  const [resolutions, setResolutions] = useState<ResolutionMap>(
    () => new Map(),
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Auto-approve state, replayed from the server's event log on connect.
  const [yoloMode, setYoloMode] = useState(false);
  const [allowedTools, setAllowedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const seenIds = useRef<Set<number>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  useEffect(() => {
    const es = new EventSource("/stream");
    es.onopen = () => setStatus("connected");
    es.onerror = () => setStatus("disconnected");
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as EnvelopeEvent;
        if (seenIds.current.has(evt.id)) return;
        seenIds.current.add(evt.id);
        setEvents((prev) => [...prev, evt]);
        if (evt.type === "permission_resolved") {
          const p = evt.payload as {
            request_id?: string;
            decision?: "allow" | "deny";
          };
          if (p.request_id && p.decision) {
            const requestId = p.request_id;
            const decision = p.decision;
            setResolutions((prev) => {
              if (prev.get(requestId) === decision) return prev;
              const next = new Map(prev);
              next.set(requestId, decision);
              return next;
            });
          }
        }
        if (evt.type === "session_started") {
          const p = evt.payload as { sessionId?: unknown };
          // Latest session_started wins — after a reconnect, the server's
          // current session id replaces any stale one from catchup.
          if (typeof p.sessionId === "string") {
            setSessionId(p.sessionId);
          }
        }
        if (evt.type === "yolo_mode_changed") {
          const p = evt.payload as { enabled?: unknown };
          if (typeof p.enabled === "boolean") setYoloMode(p.enabled);
        }
        if (evt.type === "tool_allowlisted") {
          const p = evt.payload as { tool_name?: unknown };
          if (typeof p.tool_name === "string") {
            const name = p.tool_name;
            setAllowedTools((prev) => {
              if (prev.has(name)) return prev;
              const next = new Set(prev);
              next.add(name);
              return next;
            });
          }
        }
      } catch {
        // malformed frame; ignore
      }
    };
    return () => es.close();
  }, []);

  return (
    <div className="app">
      <TopBar
        status={status}
        eventCount={events.length}
        sessionId={sessionId}
        yoloMode={yoloMode}
      />
      <EventList
        events={events}
        resolutions={resolutions}
        allowedTools={allowedTools}
      />
      <InputBox />
      {/* Scroll sentinel lives after InputBox so auto-scroll keeps the input
          visible on desktop (where the input is inline, not fixed). On mobile
          the input is position:fixed, so this sits behind the overlay, which
          is harmless. */}
      <div ref={endRef} aria-hidden="true" />
    </div>
  );
}

function TopBar({
  status,
  eventCount,
  sessionId,
  yoloMode,
}: {
  status: Status;
  eventCount: number;
  sessionId: string | null;
  yoloMode: boolean;
}) {
  const [pending, setPending] = useState(false);
  async function toggleYolo() {
    if (pending) return;
    setPending(true);
    try {
      await fetch("/yolo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !yoloMode }),
      });
      // Don't optimistically flip — wait for the yolo_mode_changed event so
      // every connected client sees the same state at the same time.
    } catch {
      // Surface failure quietly; the toggle just won't flip.
    } finally {
      setPending(false);
    }
  }
  return (
    <header className="top-bar">
      <span className={`status status-${status}`}>{status}</span>
      <span className="event-count">{eventCount} events</span>
      <button
        type="button"
        className={`yolo-toggle ${yoloMode ? "is-on" : ""}`}
        onClick={() => void toggleYolo()}
        disabled={pending}
        title={
          yoloMode
            ? "YOLO mode on — every tool call auto-approves"
            : "Tap to enable YOLO mode (auto-approve every tool call)"
        }
        aria-pressed={yoloMode}
      >
        {yoloMode ? "YOLO ON" : "YOLO"}
      </button>
      {sessionId && (
        <span
          className="session-id"
          title={`session ${sessionId}`}
          aria-label={`Session ID ${sessionId}`}
        >
          {sessionId.slice(0, 8)}
        </span>
      )}
    </header>
  );
}

function EventList({
  events,
  resolutions,
  allowedTools,
}: {
  events: EnvelopeEvent[];
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
}) {
  return (
    <div className="events">
      {events.map((e) => (
        <EventRow
          key={e.id}
          event={e}
          resolutions={resolutions}
          allowedTools={allowedTools}
        />
      ))}
    </div>
  );
}

function EventRow({
  event,
  resolutions,
  allowedTools,
}: {
  event: EnvelopeEvent;
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
}) {
  switch (event.type) {
    case "user":
      return <UserRow event={event} />;
    case "assistant":
      return <AssistantRow event={event} />;
    case "permission_request":
      return (
        <PermissionRow event={event} resolutions={resolutions} allowedTools={allowedTools} />
      );
    case "permission_resolved":
      // folded into the matching permission_request card
      return null;
    case "permission_auto_approved":
      return <AutoApprovedNotice event={event} />;
    case "yolo_mode_changed":
    case "tool_allowlisted":
      return <SystemNotice event={event} />;
    case "system":
    case "session_started":
    case "subprocess_exited":
    case "subprocess_stderr":
    case "rate_limit_event":
      return <SystemNotice event={event} />;
    default:
      return <UnknownRow event={event} />;
  }
}

interface CCUserPayload {
  message?: { role?: string; content?: string | ContentBlock[] };
}
interface CCAssistantPayload {
  message?: { content?: ContentBlock[] };
}
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      // Anthropic's tool_result block technically allows structured content
      // (text blocks, image blocks) in addition to plain strings. CC's CLI
      // emits strings today but typing this as `unknown` lets the renderer
      // handle both without a future schema drift breaking the UI.
      content: unknown;
      is_error?: boolean;
    };

function UserRow({ event }: { event: EnvelopeEvent }) {
  const p = event.payload as CCUserPayload;
  const content = p.message?.content;

  if (typeof content === "string") {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">{content}</div>
      </div>
    );
  }

  if (Array.isArray(content)) {
    return (
      <>
        {content.map((block, idx) => {
          if (block.type === "tool_result") {
            return (
              <ToolResultCard
                key={`${event.id}-${idx}`}
                block={block}
                eventId={event.id}
              />
            );
          }
          return <UnknownRow key={`${event.id}-${idx}`} event={event} />;
        })}
      </>
    );
  }
  return <UnknownRow event={event} />;
}

function AssistantRow({ event }: { event: EnvelopeEvent }) {
  const p = event.payload as CCAssistantPayload;
  const blocks = p.message?.content ?? [];
  return (
    <>
      {blocks.map((block, idx) => {
        const key = `${event.id}-${idx}`;
        if (block.type === "text") {
          return (
            <div key={key} className="row row-assistant">
              <div className="bubble bubble-assistant">
                <Markdown rehypePlugins={[rehypeSanitize]}>
                  {block.text}
                </Markdown>
              </div>
            </div>
          );
        }
        if (block.type === "thinking") {
          return (
            <details key={key} className="row row-thinking">
              <summary>thinking</summary>
              <pre>{block.thinking}</pre>
            </details>
          );
        }
        if (block.type === "tool_use") {
          return <ToolUseCard key={key} block={block} />;
        }
        return <UnknownRow key={key} event={event} />;
      })}
    </>
  );
}

function ToolUseCard({
  block,
}: {
  block: Extract<ContentBlock, { type: "tool_use" }>;
}) {
  // JSON.stringify(undefined) returns undefined, not the string "undefined";
  // coalesce to null so preview is always a string even for malformed inputs.
  const preview = JSON.stringify(block.input ?? null) ?? "null";
  const short = preview.length > 80 ? preview.slice(0, 80) + "…" : preview;
  return (
    <details className="card card-tool-use">
      <summary>
        <span className="card-label">tool_use</span>
        <span className="card-name">{block.name}</span>
        <span className="card-preview">{short}</span>
      </summary>
      <pre className="card-body">{JSON.stringify(block.input, null, 2)}</pre>
    </details>
  );
}

function ToolResultCard({
  block,
  eventId,
}: {
  block: Extract<ContentBlock, { type: "tool_result" }>;
  eventId: number;
}) {
  const content =
    typeof block.content === "string"
      ? block.content
      : (JSON.stringify(block.content ?? null) ?? "null");
  const preview = content.length > 80 ? content.slice(0, 80) + "…" : content;
  return (
    <details
      className={`card card-tool-result ${block.is_error ? "is-error" : ""}`}
    >
      <summary>
        <span className="card-label">
          tool_result{block.is_error ? " (error)" : ""}
        </span>
        <span className="card-preview">{preview || <em>empty</em>}</span>
      </summary>
      <pre className="card-body">{content}</pre>
      <div className="card-footer">id #{eventId} · tool_use_id {block.tool_use_id.slice(0, 12)}…</div>
    </details>
  );
}

interface PermissionRequestPayload {
  request_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

function PermissionRow({
  event,
  resolutions,
  allowedTools,
}: {
  event: EnvelopeEvent;
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
}) {
  const p = event.payload as PermissionRequestPayload;
  const resolution = resolutions.get(p.request_id);
  const [localPending, setLocalPending] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (resolution) {
    return (
      <div className="row row-system">
        <div className={`notice notice-${resolution}`}>
          {resolution === "allow" ? "approved" : "denied"} · {p.tool_name}
        </div>
      </div>
    );
  }

  async function decide(
    decision: "approve" | "deny",
    scope: "once" | "always" = "once",
  ) {
    if (localPending) return;
    setLocalPending(true);
    setLocalError(null);
    try {
      const res = await fetch("/approval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: p.request_id,
          decision,
          scope,
        }),
      });
      if (!res.ok) {
        setLocalError(`server returned ${res.status}`);
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "request failed");
    } finally {
      setLocalPending(false);
    }
  }

  const inputPreview = JSON.stringify(p.tool_input, null, 2);
  // If the tool is already on the session allowlist, hide the redundant
  // "always allow" button — server would have auto-approved this request
  // had it arrived after the allowlist entry, so a stale parked card might
  // still show it; one tap suffices.
  const showAlways = !allowedTools.has(p.tool_name);

  return (
    <div className="card card-permission">
      <div className="card-permission-header">Approve {p.tool_name}?</div>
      <pre className="card-body">{inputPreview}</pre>
      {localError && <div className="card-error">error: {localError}</div>}
      <div className="card-permission-buttons">
        <button
          type="button"
          className="btn-deny"
          disabled={localPending}
          onClick={() => void decide("deny")}
        >
          Deny
        </button>
        {showAlways && (
          <button
            type="button"
            className="btn-always"
            disabled={localPending}
            onClick={() => void decide("approve", "always")}
            title={`Approve and auto-allow all future ${p.tool_name} calls this session`}
          >
            Always {p.tool_name}
          </button>
        )}
        <button
          type="button"
          className="btn-approve"
          disabled={localPending}
          onClick={() => void decide("approve")}
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function AutoApprovedNotice({ event }: { event: EnvelopeEvent }) {
  const p = (event.payload ?? {}) as {
    tool_name?: unknown;
    reason?: unknown;
  };
  const tool = typeof p.tool_name === "string" ? p.tool_name : "tool";
  const reason = p.reason === "yolo" ? "yolo" : "always allow";
  return (
    <div className="row row-system">
      <div className="notice notice-allow">
        auto-approved · {tool} <span className="notice-tag">({reason})</span>
      </div>
    </div>
  );
}

function SystemNotice({ event }: { event: EnvelopeEvent }) {
  const p = (event.payload as Record<string, unknown>) ?? {};
  let text: string;
  switch (event.type) {
    case "session_started":
      text = `session started (${String(p.sessionId ?? "").slice(0, 8)}…)`;
      break;
    case "subprocess_exited":
      text = `subprocess exited: ${String(p.reason ?? "unknown")} (code ${String(p.code ?? "?")})`;
      break;
    case "subprocess_stderr":
      text = `stderr: ${String(p.line ?? "")}`;
      break;
    case "rate_limit_event":
      text = "rate limit event";
      break;
    case "yolo_mode_changed":
      text = `yolo mode ${p.enabled ? "enabled" : "disabled"}`;
      break;
    case "tool_allowlisted":
      text = `always allow: ${String(p.tool_name ?? "?")}`;
      break;
    case "system": {
      const raw = event.payload as { subtype?: string } | null;
      text = `system: ${String(raw?.subtype ?? "event")}`;
      break;
    }
    default:
      text = event.type;
  }
  return (
    <div className="row row-system">
      <div className="notice">
        <span className="notice-tag">#{event.id}</span> {text}
      </div>
    </div>
  );
}

function UnknownRow({ event }: { event: EnvelopeEvent }) {
  return (
    <div className="row row-system">
      <div className="notice notice-muted">
        <span className="notice-tag">#{event.id}</span> unknown type=
        {event.type}
      </div>
    </div>
  );
}

function InputBox() {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const payload = text.trim();
    if (!payload || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: payload }),
      });
      if (res.ok) {
        setText("");
      } else {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setError(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="input-bar">
      {error && <div className="input-error">error: {error}</div>}
      <div className="input-bar-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="message CC…"
          aria-label="message input"
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || text.trim().length === 0}
        >
          Send
        </button>
      </div>
      <div className="input-hint">Enter to send · Shift+Enter for newline</div>
    </div>
  );
}
