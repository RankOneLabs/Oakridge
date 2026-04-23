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

export function App() {
  const [events, setEvents] = useState<EnvelopeEvent[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const seenIds = useRef<Set<number>>(new Set());

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
      } catch {
        // malformed frame; ignore
      }
    };
    return () => es.close();
  }, []);

  return (
    <div className="app">
      <TopBar status={status} eventCount={events.length} />
      <EventList events={events} />
      <InputBox />
    </div>
  );
}

function TopBar({ status, eventCount }: { status: Status; eventCount: number }) {
  return (
    <header className="top-bar">
      <span className={`status status-${status}`}>{status}</span>
      <span className="event-count">{eventCount} events</span>
    </header>
  );
}

function EventList({ events }: { events: EnvelopeEvent[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [events.length]);
  return (
    <div className="events">
      {events.map((e) => (
        <EventRow key={e.id} event={e} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function EventRow({ event }: { event: EnvelopeEvent }) {
  switch (event.type) {
    case "user":
      return <UserRow event={event} />;
    case "assistant":
      return <AssistantRow event={event} />;
    case "system":
    case "session_started":
    case "subprocess_exited":
    case "subprocess_stderr":
    case "rate_limit_event":
    case "permission_resolved":
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
      content: string;
      is_error?: boolean;
    };

function UserRow({ event }: { event: EnvelopeEvent }) {
  const p = event.payload as CCUserPayload;
  const content = p.message?.content;

  // User-typed text (arrives as a string; flagged isReplay via --replay-user-messages).
  if (typeof content === "string") {
    return (
      <div className="row row-user">
        <div className="bubble bubble-user">{content}</div>
      </div>
    );
  }

  // Content is an array of blocks (tool_result comes through here).
  // Tool_result is rendered in a follow-up commit; for now surface as a muted notice.
  if (Array.isArray(content)) {
    return (
      <div className="row row-system">
        <div className="notice notice-muted">
          <span className="notice-tag">#{event.id}</span>{" "}
          {content.map((b) => b.type).join(", ")}
        </div>
      </div>
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
          // Rendered properly in the next commit; stub for now.
          return (
            <div key={key} className="row row-system">
              <div className="notice notice-muted">
                tool_use {block.name}
              </div>
            </div>
          );
        }
        return <UnknownRow key={key} event={event} />;
      })}
    </>
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
    case "permission_resolved":
      text = `permission ${String(p.decision ?? "?")}`;
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

  async function send() {
    const payload = text.trim();
    if (!payload || sending) return;
    setSending(true);
    try {
      const res = await fetch("/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: payload }),
      });
      if (res.ok) setText("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="input-bar">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="message CC…"
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
  );
}
