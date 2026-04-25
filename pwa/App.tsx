import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

export interface EnvelopeEvent {
  id: number;
  type: string;
  ts: string;
  payload: unknown;
}

type SessionStatus = "starting" | "live" | "ended";

interface ResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface SessionSnapshot {
  sid: string;
  workdir: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityTs: string;
  ccSid: string | null;
  parentCcSid: string | null;
  parentOakridgeSid: string | null;
  pendingCount: number;
  yoloMode: boolean;
  allowedTools: string[];
  lastResultUsage: ResultUsage | null;
}

type InboxDelta =
  | { type: "session_created"; session: SessionSnapshot }
  | { type: "session_ended"; sid: string }
  | { type: "status_changed"; sid: string; status: SessionStatus }
  | { type: "pending_count_changed"; sid: string; count: number }
  | { type: "last_activity_changed"; sid: string; ts: string }
  | { type: "yolo_changed"; sid: string; yoloMode: boolean };

type Status = "connecting" | "connected" | "disconnected";
type Theme = "dark" | "light";
type ResolutionMap = Map<string, "allow" | "deny">;

const THEME_STORAGE_KEY = "oakridge.theme";

function readStoredTheme(): Theme {
  // SSR-safe guard; also swallows SecurityError from sandboxed localStorage.
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "dark";
}

function readHashSid(): string | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return params.get("sid");
}

function writeHashSid(sid: string | null): void {
  if (sid === null) {
    // history.replaceState so hitting Back from a SessionView returns to the
    // prior tab/page rather than chaining through every sid the user viewed.
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } else {
    window.location.hash = `sid=${encodeURIComponent(sid)}`;
  }
}

function useHashSid(): [string | null, (sid: string | null) => void] {
  const [sid, setSid] = useState<string | null>(() => readHashSid());
  useEffect(() => {
    const onHash = () => setSid(readHashSid());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = (next: string | null) => {
    writeHashSid(next);
    setSid(next);
  };
  return [sid, navigate];
}

/**
 * Fetches the server's /config once on mount. Currently exposes the
 * default workdir so the new-session form can prefill it. Returns null
 * until the fetch resolves, so callers can render a "loading" placeholder
 * rather than racing the form into life with an empty default.
 */
function useServerConfig(): { defaultWorkdir: string } | null {
  const [config, setConfig] = useState<{ defaultWorkdir: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/config")
      .then((r) => r.json() as Promise<{ defaultWorkdir: string }>)
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch(() => {
        // Server may be down or this build is older — leave config null,
        // the form will show a generic placeholder and the server will
        // still validate whatever the operator types.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {}
  }, [theme]);
  return [theme, () => setTheme((p) => (p === "dark" ? "light" : "dark"))];
}

interface InboxState {
  sessions: Map<string, SessionSnapshot>;
  /**
   * Sids the server currently has in memory (live or ended-but-lingering).
   * Differs from `sessions.keys()` because archived-only entries from the
   * /sessions?include=archived fetch aren't in memory. Used to decide whether
   * a SessionView can open /:sid/stream (in-memory) or must fall back to the
   * one-shot /:sid/events (archived on disk).
   */
  inMemorySids: Set<string>;
  inboxStatus: Status;
  /**
   * Fold a snapshot we already have in hand (e.g. the response body of
   * POST /sessions) into the inbox state so the destination view mounts
   * with the correct snapshot instead of racing the /inbox delta. Safe
   * to call before /inbox actually delivers session_created — the delta
   * just re-seats the same entry.
   */
  hydrateSession: (snapshot: SessionSnapshot) => void;
}

function useInbox(): InboxState {
  const [sessions, setSessions] = useState<Map<string, SessionSnapshot>>(
    () => new Map(),
  );
  const [inMemorySids, setInMemorySids] = useState<Set<string>>(
    () => new Set(),
  );
  const [inboxStatus, setInboxStatus] = useState<Status>("connecting");

  const hydrateSession = useCallback((snapshot: SessionSnapshot) => {
    setSessions((prev) => {
      const next = new Map(prev);
      next.set(snapshot.sid, snapshot);
      return next;
    });
    setInMemorySids((prev) => {
      if (prev.has(snapshot.sid)) return prev;
      const next = new Set(prev);
      next.add(snapshot.sid);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Seed with the full list (in-memory + archived). The inbox snapshot
    // that arrives below will overwrite in-memory entries with fresher
    // copies; archived-only entries carry over untouched.
    fetch("/sessions?include=archived")
      .then((r) => r.json() as Promise<{ sessions: SessionSnapshot[] }>)
      .then((data) => {
        if (cancelled) return;
        setSessions((prev) => {
          const next = new Map(prev);
          for (const s of data.sessions) {
            if (!next.has(s.sid)) next.set(s.sid, s);
          }
          return next;
        });
        // Seed inMemorySids with every non-ended sid so SessionView picks
        // /:sid/stream (SSE) over one-shot /:sid/events when the user
        // clicks a live session before the /inbox SSE has connected. Only
        // non-ended sids: archived-on-disk entries (always status=ended)
        // would otherwise be incorrectly marked as in-memory.
        setInMemorySids((prev) => {
          const next = new Set(prev);
          for (const s of data.sessions) {
            if (s.status !== "ended") next.add(s.sid);
          }
          return next;
        });
      })
      .catch(() => {
        // Network error; the inbox subscription below still provides live
        // state, it just won't show prior-run archived sessions.
      });

    const es = new EventSource("/inbox");
    es.onopen = () => setInboxStatus("connected");
    es.onerror = () => setInboxStatus("disconnected");
    es.addEventListener("snapshot", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        sessions: SessionSnapshot[];
      };
      setSessions((prev) => {
        const next = new Map(prev);
        for (const s of data.sessions) next.set(s.sid, s);
        return next;
      });
      setInMemorySids(new Set(data.sessions.map((s) => s.sid)));
    });
    es.addEventListener("delta", (e) => {
      const delta = JSON.parse((e as MessageEvent).data) as InboxDelta;
      setSessions((prev) => applyDelta(prev, delta));
      if (delta.type === "session_created") {
        setInMemorySids((prev) => {
          if (prev.has(delta.session.sid)) return prev;
          const next = new Set(prev);
          next.add(delta.session.sid);
          return next;
        });
      }
      // session_ended keeps the sid in inMemorySids: ended sessions linger
      // in the manager map (and stream/events still work against them)
      // until the server process exits.
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  return { sessions, inMemorySids, inboxStatus, hydrateSession };
}

function applyDelta(
  prev: Map<string, SessionSnapshot>,
  delta: InboxDelta,
): Map<string, SessionSnapshot> {
  const next = new Map(prev);
  switch (delta.type) {
    case "session_created":
      next.set(delta.session.sid, delta.session);
      break;
    case "session_ended": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, status: "ended", pendingCount: 0 });
      break;
    }
    case "status_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, status: delta.status });
      break;
    }
    case "pending_count_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, pendingCount: delta.count });
      break;
    }
    case "last_activity_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, lastActivityTs: delta.ts });
      break;
    }
    case "yolo_changed": {
      const s = next.get(delta.sid);
      if (s) next.set(delta.sid, { ...s, yoloMode: delta.yoloMode });
      break;
    }
  }
  return next;
}

export function App() {
  const [sid, navigate] = useHashSid();
  const [theme, toggleTheme] = useTheme();
  const { sessions, inMemorySids, inboxStatus, hydrateSession } = useInbox();
  const config = useServerConfig();

  if (sid === null) {
    return (
      <SessionListView
        sessions={sessions}
        inboxStatus={inboxStatus}
        theme={theme}
        defaultWorkdir={config?.defaultWorkdir ?? ""}
        onToggleTheme={toggleTheme}
        onSelect={(nextSid) => navigate(nextSid)}
        onHydrateSession={hydrateSession}
      />
    );
  }
  return (
    <SessionView
      sid={sid}
      snapshot={sessions.get(sid) ?? null}
      inMemory={inMemorySids.has(sid)}
      inboxStatus={inboxStatus}
      theme={theme}
      onToggleTheme={toggleTheme}
      onBack={() => navigate(null)}
    />
  );
}

// === session list ===

function SessionListView({
  sessions,
  inboxStatus,
  theme,
  defaultWorkdir,
  onToggleTheme,
  onSelect,
  onHydrateSession,
}: {
  sessions: Map<string, SessionSnapshot>;
  inboxStatus: Status;
  theme: Theme;
  defaultWorkdir: string;
  onToggleTheme: () => void;
  onSelect: (sid: string) => void;
  onHydrateSession: (snapshot: SessionSnapshot) => void;
}) {
  const [pending, setPending] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [workdirInput, setWorkdirInput] = useState("");
  const sorted = useMemo(() => sortSessions(sessions), [sessions]);

  // Shared POST /sessions path for both the "+ New session" button and
  // row-level Resume buttons. Resume passes resume_from and ignores
  // workdir (parent's workdir wins server-side); a fresh session sends
  // the workdir from the input box (falling back to the server default
  // if blank).
  async function startSession(resumeFrom?: string) {
    if (pending) return;
    setPending(true);
    setPendingError(null);
    try {
      const body: { resume_from?: string; workdir?: string } = {};
      if (resumeFrom) {
        body.resume_from = resumeFrom;
      } else {
        const trimmed = workdirInput.trim();
        if (trimmed) body.workdir = trimmed;
      }
      const hasBody = Object.keys(body).length > 0;
      const res = await fetch("/sessions", {
        method: "POST",
        headers: hasBody ? { "content-type": "application/json" } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const responseBody = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setPendingError(
          typeof responseBody?.error === "string"
            ? responseBody.error
            : `server returned ${res.status}`,
        );
        return;
      }
      const snap = (await res.json()) as SessionSnapshot;
      // Hydrate before navigating so SessionView mounts with the snapshot
      // present and inMemory=true, rather than racing the /inbox
      // session_created delta. Without this the input box is hidden and
      // the stream falls back to one-shot /events for the first ~100ms.
      onHydrateSession(snap);
      onSelect(snap.sid);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : "network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="app app-list">
      <header className="top-bar">
        <span className={`status status-${inboxStatus}`}>{inboxStatus}</span>
        <span className="event-count">
          {sorted.length} {sorted.length === 1 ? "session" : "sessions"}
        </span>
        <button
          type="button"
          className="theme-toggle"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
        >
          {theme === "dark" ? "LIGHT" : "DARK"}
        </button>
      </header>
      <div className="session-list-actions">
        <form
          className="new-session-form"
          onSubmit={(e) => {
            e.preventDefault();
            void startSession();
          }}
        >
          <input
            type="text"
            className="new-session-workdir"
            placeholder={defaultWorkdir || "/absolute/path/to/workdir"}
            value={workdirInput}
            onChange={(e) => setWorkdirInput(e.target.value)}
            disabled={pending}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Workdir for new session (blank = server default)"
          />
          <button
            type="submit"
            className="btn-new-session"
            disabled={pending}
          >
            {pending ? "starting…" : "+ New"}
          </button>
        </form>
        {pendingError && (
          <div className="input-error" role="alert">
            error: {pendingError}
          </div>
        )}
      </div>
      {sorted.length === 0 ? (
        <div className="session-list-empty">No sessions yet.</div>
      ) : (
        <ul className="session-list">
          {sorted.map((s) => (
            <SessionRow
              key={s.sid}
              snapshot={s}
              onOpen={() => onSelect(s.sid)}
              onResume={() => void startSession(s.sid)}
              resumeDisabled={pending}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function sortSessions(sessions: Map<string, SessionSnapshot>): SessionSnapshot[] {
  // Sort by last activity, newest first. Pending-approval sessions don't
  // float — the pending badge is visible enough, and operators told us
  // they'd rather preserve predictable chronological order.
  return [...sessions.values()].sort((a, b) => {
    if (a.lastActivityTs === b.lastActivityTs) return 0;
    return a.lastActivityTs < b.lastActivityTs ? 1 : -1;
  });
}

function SessionRow({
  snapshot,
  onOpen,
  onResume,
  resumeDisabled,
}: {
  snapshot: SessionSnapshot;
  onOpen: () => void;
  onResume: () => void;
  resumeDisabled: boolean;
}) {
  const relative = useRelativeTime(snapshot.lastActivityTs);
  const canResume = snapshot.status === "ended";
  return (
    <li className="session-row-li">
      <button
        type="button"
        className={`session-row session-row-${snapshot.status}`}
        onClick={onOpen}
      >
        <div className="session-row-line">
          <span className={`session-row-status session-row-status-${snapshot.status}`}>
            {snapshot.status}
          </span>
          <span className="session-row-sid" title={snapshot.sid}>
            {snapshot.sid.slice(0, 8)}
          </span>
          {snapshot.pendingCount > 0 && (
            <span className="session-row-pending" aria-label={`${snapshot.pendingCount} pending approvals`}>
              {snapshot.pendingCount} pending
            </span>
          )}
          {snapshot.yoloMode && (
            <span className="session-row-yolo">YOLO</span>
          )}
          <span className="session-row-activity">{relative}</span>
        </div>
        <div className="session-row-workdir" title={snapshot.workdir}>
          {snapshot.workdir}
        </div>
      </button>
      {canResume && (
        <button
          type="button"
          className="btn-resume"
          disabled={resumeDisabled}
          title={resumeTitle(snapshot.lastResultUsage)}
          onClick={(e) => {
            // Don't also trigger the row's open-transcript click behind us.
            e.stopPropagation();
            onResume();
          }}
        >
          Resume
        </button>
      )}
    </li>
  );
}

function resumeTitle(usage: ResultUsage | null): string {
  if (!usage) {
    return "Start a new session inheriting this one's context.";
  }
  // Cache reads are ~free; cache_creation is what a resume re-ingests as
  // new context on Claude Max, so include it in the rough "cost" number.
  // This is a ballpark — CC's internal tokenization + prompt scaffolding
  // add overhead we can't see from the result event alone.
  const rough =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    usage.output_tokens;
  return (
    `Start a new session inheriting this one's context.\n` +
    `~${formatTokens(rough)} parent context — ` +
    `on Claude Max this burns against the 5-hour rate-limit window, not dollars.`
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k tokens`;
  return `${(n / 1_000_000).toFixed(1)}M tokens`;
}

function useRelativeTime(iso: string): string {
  // Re-render once per minute so "2m ago" doesn't get stale. A 60s tick is
  // coarse enough to stay off the render hot path but fine-grained enough
  // that operators see the list refresh before the data feels wrong.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return formatRelative(iso);
}

function formatRelative(iso: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const deltaSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  // Floor rather than round for the larger unit conversions — a 1m30s-old
  // session showing as "2m ago" overstates the elapsed time. Labels
  // advance only once the next threshold is actually crossed.
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// === session view ===

function SessionView({
  sid,
  snapshot,
  inMemory,
  inboxStatus,
  theme,
  onToggleTheme,
  onBack,
}: {
  sid: string;
  snapshot: SessionSnapshot | null;
  inMemory: boolean;
  inboxStatus: Status;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}) {
  const [events, setEvents] = useState<EnvelopeEvent[]>([]);
  const [streamStatus, setStreamStatus] = useState<Status>("connecting");
  const [resolutions, setResolutions] = useState<ResolutionMap>(
    () => new Map(),
  );
  const [yoloMode, setYoloMode] = useState(false);
  const [allowedTools, setAllowedTools] = useState<Set<string>>(
    () => new Set(),
  );
  const seenIds = useRef<Set<number>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  // Reset per-session state when navigating between sids so stale events
  // from the previous session's EventSource don't leak into this view.
  useEffect(() => {
    setEvents([]);
    setResolutions(new Map());
    setYoloMode(false);
    setAllowedTools(new Set());
    seenIds.current = new Set();
  }, [sid]);

  useEffect(() => {
    const ingest = (evt: EnvelopeEvent) => {
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
    };

    if (!inMemory) {
      // Archived-on-disk session: no live stream, one-shot fetch. If the
      // /inbox reconnects later and learns the session is in-memory after
      // all (rare race at server startup), this effect re-runs and upgrades
      // to SSE.
      setStreamStatus("connecting");
      let cancelled = false;
      fetch(`/${encodeURIComponent(sid)}/events`)
        .then((r) => {
          if (!r.ok) throw new Error(`server returned ${r.status}`);
          return r.json() as Promise<{ events: EnvelopeEvent[] }>;
        })
        .then((data) => {
          if (cancelled) return;
          for (const evt of data.events) ingest(evt);
          setStreamStatus("disconnected");
        })
        .catch(() => {
          if (cancelled) return;
          setStreamStatus("disconnected");
        });
      return () => {
        cancelled = true;
      };
    }

    const es = new EventSource(`/${encodeURIComponent(sid)}/stream`);
    es.onopen = () => setStreamStatus("connected");
    es.onerror = () => setStreamStatus("disconnected");
    es.onmessage = (e) => {
      try {
        ingest(JSON.parse(e.data) as EnvelopeEvent);
      } catch {
        // malformed frame; ignore
      }
    };
    return () => es.close();
  }, [sid, inMemory]);

  const canInput = snapshot?.status === "live";
  return (
    <div className="app">
      <SessionTopBar
        sid={sid}
        snapshot={snapshot}
        streamStatus={streamStatus}
        inboxStatus={inboxStatus}
        eventCount={events.length}
        yoloMode={yoloMode}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onBack={onBack}
      />
      <EventList
        events={events}
        resolutions={resolutions}
        allowedTools={allowedTools}
        sid={sid}
        sessionStatus={snapshot?.status ?? null}
      />
      {canInput && <InputBox sid={sid} />}
      {!canInput && snapshot?.status === "ended" && (
        <div className="session-ended-banner">
          Session ended · read-only transcript
        </div>
      )}
      <div ref={endRef} aria-hidden="true" />
    </div>
  );
}

function SessionTopBar({
  sid,
  snapshot,
  streamStatus,
  inboxStatus,
  eventCount,
  yoloMode,
  theme,
  onToggleTheme,
  onBack,
}: {
  sid: string;
  snapshot: SessionSnapshot | null;
  streamStatus: Status;
  inboxStatus: Status;
  eventCount: number;
  yoloMode: boolean;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canToggleYolo = snapshot?.status === "live";
  async function toggleYolo() {
    if (pending || !canToggleYolo) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/${encodeURIComponent(sid)}/yolo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !yoloMode }),
      });
      if (!res.ok) {
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
      setPending(false);
    }
  }
  // Show stream status when on a live session, inbox status otherwise —
  // stream status on an archived-only view is misleading ("disconnected"
  // just means the one-shot fetch finished).
  const shownStatus = snapshot?.status === "live" ? streamStatus : inboxStatus;
  return (
    <header className="top-bar">
      <button
        type="button"
        className="back-button"
        onClick={onBack}
        aria-label="Back to session list"
        title="Back to session list"
      >
        ←
      </button>
      <span className={`status status-${shownStatus}`}>{shownStatus}</span>
      <span className="event-count">{eventCount} events</span>
      <button
        type="button"
        className="theme-toggle"
        onClick={onToggleTheme}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        aria-label={
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
        }
      >
        {theme === "dark" ? "LIGHT" : "DARK"}
      </button>
      <button
        type="button"
        className={`yolo-toggle ${yoloMode ? "is-on" : ""}`}
        onClick={() => void toggleYolo()}
        disabled={pending || !canToggleYolo}
        title={
          !canToggleYolo
            ? "YOLO only toggleable while the session is live"
            : yoloMode
              ? "YOLO mode on — every tool call auto-approves"
              : "Tap to enable YOLO mode (auto-approve every tool call)"
        }
        aria-pressed={yoloMode}
      >
        {yoloMode ? "YOLO ON" : "YOLO"}
      </button>
      {error && (
        <span className="yolo-error" title={error} role="alert">
          ⚠ {error}
        </span>
      )}
      <span
        className="session-id"
        title={`session ${sid}`}
        aria-label={`Session ID ${sid}`}
      >
        {sid.slice(0, 8)}
      </span>
    </header>
  );
}

function EventList({
  events,
  resolutions,
  allowedTools,
  sid,
  sessionStatus,
}: {
  events: EnvelopeEvent[];
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
  sid: string;
  sessionStatus: SessionStatus | null;
}) {
  return (
    <div className="events">
      {events.map((e) => (
        <EventRow
          key={e.id}
          event={e}
          resolutions={resolutions}
          allowedTools={allowedTools}
          sid={sid}
          sessionStatus={sessionStatus}
        />
      ))}
    </div>
  );
}

function EventRow({
  event,
  resolutions,
  allowedTools,
  sid,
  sessionStatus,
}: {
  event: EnvelopeEvent;
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
  sid: string;
  sessionStatus: SessionStatus | null;
}) {
  switch (event.type) {
    case "user":
      return <UserRow event={event} />;
    case "assistant":
      return <AssistantRow event={event} />;
    case "permission_request":
      return (
        <PermissionRow
          event={event}
          resolutions={resolutions}
          allowedTools={allowedTools}
          sid={sid}
          sessionStatus={sessionStatus}
        />
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
  sid,
  sessionStatus,
}: {
  event: EnvelopeEvent;
  resolutions: ResolutionMap;
  allowedTools: Set<string>;
  sid: string;
  sessionStatus: SessionStatus | null;
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

  // Only collapse to a read-only notice when the session is definitively
  // ended. For "starting" or a still-loading inbox snapshot (null), fall
  // through to the normal buttons — realistic case is a brief window where
  // the inbox hasn't delivered the snapshot yet, and the server will
  // 404/503 if the operator taps before it's ready. "session ended"
  // messaging is wrong for those cases.
  if (sessionStatus === "ended") {
    return (
      <div className="row row-system">
        <div className="notice notice-muted">
          unresolved · {p.tool_name} (session ended)
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
      const res = await fetch(`/${encodeURIComponent(sid)}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: p.request_id,
          decision,
          scope,
        }),
      });
      if (!res.ok) {
        // Mirror InputBox: surface the server's JSON `error` field if
        // present so the operator sees `scope must be...` etc instead of
        // a bare status code.
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        setLocalError(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
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

function InputBox({ sid }: { sid: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const payload = text.trim();
    if (!payload || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/${encodeURIComponent(sid)}/input`, {
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
