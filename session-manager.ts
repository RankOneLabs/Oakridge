import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  Session,
  extractResultUsage,
  newSessionId,
  readJsonlOrEmpty,
  type EnvelopeEvent,
  type ResultUsage,
  type SessionSnapshot,
  type SessionStatus,
  type SpawnCmd,
} from "./session";

export interface SessionManagerOpts {
  sessionsDir: string;
  /**
   * Build the command + spawn env for a new session. Receives the session
   * object (so the manager doesn't need to know which flags come from where)
   * and returns a SpawnCmd ready to hand to Bun.spawn. Resume is expressed
   * via parentCcSid on the Session, not as a separate flag here — the
   * builder inspects session.parentCcSid.
   */
  buildSpawnCmd: (session: Session) => SpawnCmd;
}

export interface CreateSessionOpts {
  workdir: string;
  name?: string;
  parentCcSid?: string;
  parentOakridgeSid?: string;
}

/**
 * /inbox delta shapes. `session_created` carries the full snapshot so clients
 * can add a row without a follow-up fetch; the later deltas only carry the
 * fields that actually change so a reconnect-with-snapshot is authoritative.
 */
export type InboxDelta =
  | { type: "session_created"; session: SessionSnapshot }
  | { type: "session_ended"; sid: string }
  | { type: "session_removed"; sid: string }
  | { type: "status_changed"; sid: string; status: SessionStatus }
  | { type: "pending_count_changed"; sid: string; count: number }
  | { type: "last_activity_changed"; sid: string; ts: string }
  | { type: "yolo_changed"; sid: string; yoloMode: boolean };

export interface InboxSnapshot {
  sessions: SessionSnapshot[];
}

type InboxSubscriber = (delta: InboxDelta) => void;

const LAST_ACTIVITY_THROTTLE_MS = 1000;

export class SessionManager {
  private readonly opts: SessionManagerOpts;
  private readonly sessions = new Map<string, Session>();
  /**
   * Maps CC's session_id (captured from system/init) back to our
   * oakridgeSid, so /hook/approval can route incoming hooks — which carry
   * CC's session_id in the payload, not ours — to the right Session.
   */
  private readonly ccSidToOakridgeSid = new Map<string, string>();

  private readonly inboxSubscribers = new Set<InboxSubscriber>();
  /**
   * Tracks the last time we actually emitted a last_activity_changed delta
   * for a given sid so we can throttle noisy emit() traffic down to ~1/sec
   * per session. Paired with pendingActivityTimers below so an event that
   * arrives mid-window still produces a trailing flush.
   */
  private readonly lastActivityFlushAt = new Map<string, number>();
  private readonly pendingActivityTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /**
   * Lazy cache of the archived-snapshot scan. Populated on first call to
   * listArchivedSnapshots() and reused thereafter — within a single
   * server run, archived sessions are immutable (in-memory ones are
   * filtered out, and a session never re-enters the archived set after
   * starting in memory). Only remove() invalidates an entry.
   *
   * null = not yet loaded; non-null = loaded once, value is authoritative.
   */
  private archivedSnapshotCache: Map<string, SessionSnapshot> | null = null;
  /**
   * Single-flight guard for the initial archived scan. While a scan is in
   * flight this holds the populating promise; concurrent
   * listArchivedSnapshots() callers await the same promise instead of each
   * launching a duplicate readdir+parse pass, and remove() awaits it before
   * mutating the cache so a delete arriving mid-scan can't race with the
   * later cache write and resurrect a purged sid.
   */
  private archivedScanPromise: Promise<void> | null = null;

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
  }

  async create(opts: CreateSessionOpts): Promise<Session> {
    const oakridgeSid = newSessionId();
    // Server-side fallback so requests without a usable name still produce a
    // human-readable session name. `name` is optional in practice, and
    // resume/default client flows may omit it, so this can run for normal
    // client traffic as well as direct API hits.
    const name =
      opts.name && opts.name.trim() ? opts.name.trim() : `session-${oakridgeSid.slice(0, 8)}`;
    const session = new Session({
      oakridgeSid,
      workdir: opts.workdir,
      name,
      sessionsDir: this.opts.sessionsDir,
      parentCcSid: opts.parentCcSid,
      parentOakridgeSid: opts.parentOakridgeSid,
      callbacks: {
        onCcSidObserved: (s, ccSid) => {
          this.ccSidToOakridgeSid.set(ccSid, s.oakridgeSid);
        },
        onEnded: (s) => {
          const ccSid = s.currentCcSid;
          if (ccSid && this.ccSidToOakridgeSid.get(ccSid) === s.oakridgeSid) {
            this.ccSidToOakridgeSid.delete(ccSid);
          }
          this.clearActivityTimer(s.oakridgeSid);
          this.broadcastDelta({ type: "session_ended", sid: s.oakridgeSid });
        },
        onStatusChanged: (s, status) => {
          this.broadcastDelta({
            type: "status_changed",
            sid: s.oakridgeSid,
            status,
          });
        },
        onPendingCountChanged: (s, count) => {
          this.broadcastDelta({
            type: "pending_count_changed",
            sid: s.oakridgeSid,
            count,
          });
        },
        onLastActivityChanged: (s, ts) => {
          this.scheduleActivityDelta(s.oakridgeSid, ts);
        },
        onYoloChanged: (s, yoloMode) => {
          this.broadcastDelta({
            type: "yolo_changed",
            sid: s.oakridgeSid,
            yoloMode,
          });
        },
      },
    });
    // Register in the live map before spawn so /hook/approval can find the
    // session as soon as system/init arrives. If spawn throws, we keep it
    // in the map (as ended) so a client that POSTed /sessions can still
    // read the failure via /:sid/events. Reaping of ended sessions is a
    // future PR; for now they accumulate, bounded by server lifetime.
    this.sessions.set(session.oakridgeSid, session);
    // Broadcast session_created with the starting-state snapshot before we
    // await spawn(). That way /inbox subscribers see the new row appear
    // immediately and then receive status/pending/activity deltas as the
    // subprocess comes up.
    this.broadcastDelta({ type: "session_created", session: session.snapshot() });
    await session.spawn(this.opts.buildSpawnCmd(session));
    return session;
  }

  get(oakridgeSid: string): Session | undefined {
    return this.sessions.get(oakridgeSid);
  }

  getByCcSid(ccSid: string): Session | undefined {
    const oakridgeSid = this.ccSidToOakridgeSid.get(ccSid);
    return oakridgeSid ? this.sessions.get(oakridgeSid) : undefined;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Live sessions only. Ended sessions linger in the map so clients can
   * still read archived events via /:sid/events, but callers that only
   * care about actionable state (pending approvals, input routing) want
   * this filtered view.
   */
  listLive(): Session[] {
    return [...this.sessions.values()].filter((s) => s.status === "live");
  }

  listSnapshots(): SessionSnapshot[] {
    return this.list().map((s) => s.snapshot());
  }

  /**
   * Returns snapshots of sessions whose JSONL exists on disk but which
   * aren't currently in memory — i.e. sessions from prior server runs that
   * completed before restart. Live/ended-in-memory sessions are filtered
   * out here so the caller can merge these with listSnapshots() without
   * duplicates.
   *
   * First call scans the sessions directory and parses each JSONL; result
   * is cached for the lifetime of the server process. Subsequent calls
   * return cached snapshots without I/O. Only remove() can invalidate an
   * entry. With ~20 archived sessions, this cuts a 100ms+ /sessions call
   * to <1ms after the first hit, which matters for PWA cold start where
   * multiple tabs all fetch the list at once.
   */
  async listArchivedSnapshots(): Promise<SessionSnapshot[]> {
    // Cold path: if the cache hasn't been populated yet, kick off (or
    // join) the single-flight scan. All concurrent callers await the same
    // promise so the readdir+parse pass runs once. We catch rejection
    // here so a transient scan failure surfaces as an empty list rather
    // than a 500 from /sessions?include=archived; the .finally() in the
    // launch site already clears archivedScanPromise so the next call
    // retries the scan from scratch. Logged (not silently swallowed) so
    // a real EACCES/I/O error on sessionsDir is diagnosable in server
    // logs instead of looking like "no archived sessions".
    if (this.archivedSnapshotCache === null) {
      if (this.archivedScanPromise === null) {
        this.archivedScanPromise = this.populateArchivedCache().finally(() => {
          this.archivedScanPromise = null;
        });
      }
      await this.archivedScanPromise.catch((err) => {
        console.error(
          `cc-deck: archived snapshot scan failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    // Re-read after the (possible) await — populateArchivedCache may have
    // populated the cache, or thrown without populating. In the latter
    // case we return an empty list and the next call will retry.
    const cache: Map<string, SessionSnapshot> | null = this.archivedSnapshotCache;
    if (cache === null) return [];
    // Filter on read so an entry whose sid has since started in memory
    // (extremely rare — would require a sid collision or a server-on-server
    // scenario) doesn't escape the cache and confuse callers.
    const out: SessionSnapshot[] = [];
    cache.forEach((snap, sid) => {
      if (!this.sessions.has(sid)) out.push(snap);
    });
    return out;
  }

  private async populateArchivedCache(): Promise<void> {
    const cache = new Map<string, SessionSnapshot>();
    let entries: string[];
    try {
      entries = await readdir(this.opts.sessionsDir);
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "ENOENT"
      ) {
        // Empty cache is still a valid populated state — sessionsDir
        // missing is a normal cold start and shouldn't force a re-scan.
        this.archivedSnapshotCache = cache;
        return;
      }
      throw err;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const sid = name.slice(0, -".jsonl".length);
      if (this.sessions.has(sid)) continue;
      const jsonlPath = join(this.opts.sessionsDir, name);
      const snap = await loadArchivedSnapshot(sid, jsonlPath);
      if (snap) cache.set(sid, snap);
    }
    this.archivedSnapshotCache = cache;
  }

  /**
   * Returns the single live session if exactly one exists, otherwise null.
   * Used by the legacy (non-sid-prefixed) HTTP routes so the existing PWA
   * keeps working through the refactor. At zero or 2+ live sessions the
   * legacy routes return 409; they're a bridge, not a long-term shape.
   */
  getSingleLive(): Session | null {
    let found: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s.status !== "live") continue;
      if (found) return null;
      found = s;
    }
    return found;
  }

  /**
   * Aborts a specific session and awaits its exit. Returns the subprocess
   * exit code (or -1 if unknown).
   */
  async end(oakridgeSid: string): Promise<number> {
    const session = this.sessions.get(oakridgeSid);
    if (!session) return -1;
    return session.abort();
  }

  /**
   * Hard-deletes a session: aborts it if live, drops it from the in-memory
   * map, removes its JSONL from disk, and broadcasts session_removed.
   * Works on archived-only sids too (not in memory) — those just delete the
   * JSONL. Returns true if anything was removed (file or map entry), false
   * if the sid was unknown to both. Throws RemoveFailedError if unlink
   * fails for any reason other than ENOENT, so the route handler can
   * return 5xx instead of advertising a successful purge while removal
   * of the transcript could not be confirmed (an EACCES on the parent
   * directory, for example, fails before we'd know whether the file
   * existed).
   *
   * Order of operations:
   *  1. Wait for any in-flight archived scan so we operate on a consistent
   *     cache state (otherwise a scan finishing after our cache.delete()
   *     could resurrect this sid).
   *  2. Abort the live subprocess if any (drains the jsonlWriter so the
   *     unlink doesn't race with an open FD).
   *  3. Unlink the JSONL. ENOENT = already gone = success. Any other error
   *     is propagated; the in-memory map entry stays put so a retry can
   *     finish the job.
   *  4. After unlink success (or ENOENT), evict from cache + drop map
   *     entry + broadcast. These in-memory removals are part of the
   *     "anything was removed" return contract; this step just does not
   *     run if unlink fails for a non-ENOENT reason (we throw before
   *     reaching it).
   */
  async remove(oakridgeSid: string): Promise<boolean> {
    if (this.archivedScanPromise) {
      try {
        await this.archivedScanPromise;
      } catch {
        // Scan failure is the scan's problem; we still want to attempt
        // the remove. If the cache is null after this, the cache eviction
        // step below is a no-op.
      }
    }
    const session = this.sessions.get(oakridgeSid);
    if (session) {
      // abort() is idempotent on already-ended sessions, so this is safe
      // for both live and ended map entries.
      try {
        await session.abort();
      } catch (err) {
        console.error(
          `cc-deck: abort during remove failed for ${oakridgeSid}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const jsonlPath = join(this.opts.sessionsDir, `${oakridgeSid}.jsonl`);
    // Distinct from "unlink resolved without throwing": only true when
    // unlink actually deleted a file (ENOENT does NOT set this). Used
    // below for the cache-null edge case so a bogus sid that ENOENTs
    // can't be reported as a successful removal.
    let unlinkDeletedFile = false;
    try {
      await unlink(jsonlPath);
      unlinkDeletedFile = true;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code: string }).code
          : null;
      if (code !== "ENOENT") {
        // Real failure (EACCES, EBUSY, EIO, ...). Leave the in-memory map
        // entry alone — the subprocess is already dead from the abort
        // above, but the operator can still see a stuck row and retry.
        // Do NOT broadcast session_removed; do NOT evict from cache.
        throw new RemoveFailedError(oakridgeSid, jsonlPath, err);
      }
      // ENOENT — file was already gone. Resolved without throwing, but
      // we did not actually delete anything; unlinkDeletedFile stays false.
    }
    // Past this point: unlink succeeded OR ENOENT (file already absent).
    // Reflect the new state in our in-memory bookkeeping.
    let removed = false;
    if (session) {
      this.sessions.delete(oakridgeSid);
      this.clearActivityTimer(oakridgeSid);
      removed = true;
    }
    if (this.archivedSnapshotCache?.delete(oakridgeSid)) removed = true;
    if (!removed && unlinkDeletedFile && this.archivedSnapshotCache === null) {
      // First-call edge: cache hasn't been populated yet, sid wasn't in
      // memory, but unlink really removed a file from disk — treat that
      // as a successful removal so the operator's Remove click on an
      // archived-on-disk row right after server boot is honored. ENOENT
      // is intentionally excluded so a typo'd sid doesn't get a
      // false-positive "removed" response.
      removed = true;
    }
    if (removed) {
      this.broadcastDelta({ type: "session_removed", sid: oakridgeSid });
    }
    return removed;
  }

  /**
   * Aborts every session in the map (live, starting, or already ended —
   * iterating all is intentional so a session mid-spawn is waited on, not
   * skipped). Ended sessions short-circuit cheaply in Session.abort().
   * Returns the highest exit code across all sessions, or 0 if all exited
   * cleanly.
   */
  async endAll(): Promise<number> {
    const exits = await Promise.all(
      [...this.sessions.values()].map((s) => s.abort().catch(() => 1)),
    );
    return Math.max(0, ...exits);
  }

  // === inbox ===

  subscribeInbox(cb: InboxSubscriber): () => void {
    this.inboxSubscribers.add(cb);
    return () => this.inboxSubscribers.delete(cb);
  }

  private broadcastDelta(delta: InboxDelta): void {
    for (const cb of this.inboxSubscribers) {
      try {
        cb(delta);
      } catch (err) {
        // One bad subscriber shouldn't block the others or corrupt
        // in-session state — mirror the Session.emit subscriber contract.
        console.error(
          `cc-deck: inbox subscriber failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private scheduleActivityDelta(sid: string, ts: string): void {
    const now = Date.now();
    const lastFlush = this.lastActivityFlushAt.get(sid) ?? 0;
    const elapsed = now - lastFlush;
    if (elapsed >= LAST_ACTIVITY_THROTTLE_MS) {
      this.lastActivityFlushAt.set(sid, now);
      this.broadcastDelta({ type: "last_activity_changed", sid, ts });
      return;
    }
    // Inside the throttle window. If a trailing timer is already scheduled
    // it'll pick up the newest ts from the session's snapshot when it
    // fires — no need to reschedule, just drop this tick.
    if (this.pendingActivityTimers.has(sid)) return;
    const delay = LAST_ACTIVITY_THROTTLE_MS - elapsed;
    const timer = setTimeout(() => {
      this.pendingActivityTimers.delete(sid);
      this.flushActivity(sid);
    }, delay);
    this.pendingActivityTimers.set(sid, timer);
  }

  private flushActivity(sid: string): void {
    const session = this.sessions.get(sid);
    if (!session) return;
    this.lastActivityFlushAt.set(sid, Date.now());
    this.broadcastDelta({
      type: "last_activity_changed",
      sid,
      ts: session.snapshot().lastActivityTs,
    });
  }

  private clearActivityTimer(sid: string): void {
    const timer = this.pendingActivityTimers.get(sid);
    if (timer) {
      clearTimeout(timer);
      this.pendingActivityTimers.delete(sid);
      // Flush the latest activity ts on teardown so a session that ends
      // inside the throttle window doesn't strand its final
      // subprocess_exited/last-emit ts in a cancelled trailing timer.
      this.flushActivity(sid);
    }
    this.lastActivityFlushAt.delete(sid);
  }
}

/**
 * Thrown by SessionManager.remove() when the JSONL exists on disk but
 * unlink fails for any reason other than ENOENT. The HTTP route handler
 * catches this and returns a 500 so the client doesn't see a misleading
 * "removed" success while the transcript is still present. ENOENT is
 * intentionally treated as success in remove() and never throws this.
 */
export class RemoveFailedError extends Error {
  readonly sid: string;
  readonly jsonlPath: string;
  // `cause` is on the ES2022 Error base; `override` keeps strict TS happy.
  override readonly cause: unknown;
  constructor(sid: string, jsonlPath: string, cause: unknown) {
    super(
      `failed to unlink ${jsonlPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "RemoveFailedError";
    this.sid = sid;
    this.jsonlPath = jsonlPath;
    this.cause = cause;
  }
}

/**
 * Reconstructs a SessionSnapshot from an on-disk JSONL. Used by archived
 * scans and (via the caller) /:sid/events fall-through for sessions that
 * aren't in memory — e.g. after a server restart. Returns null if the file
 * is empty, missing, or unreadable, since an empty jsonl can't yield a
 * useful row and a single unreadable jsonl shouldn't fail the whole
 * archived-list response.
 */
async function loadArchivedSnapshot(
  sid: string,
  jsonlPath: string,
): Promise<SessionSnapshot | null> {
  let contents: string;
  try {
    contents = await readJsonlOrEmpty(jsonlPath);
  } catch (err) {
    // readJsonlOrEmpty swallows ENOENT but rethrows everything else (e.g.
    // EACCES, EISDIR, I/O errors). Skip the entry rather than 500 the
    // caller — the admin can chase it in logs.
    console.error(
      `cc-deck: failed to read archived jsonl ${jsonlPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (!contents) return null;
  let createdAt: string | null = null;
  let workdir = "";
  let name = "";
  let ccSid: string | null = null;
  let parentCcSid: string | null = null;
  let parentOakridgeSid: string | null = null;
  let lastActivityTs = "";
  const allowedTools = new Set<string>();
  let yoloMode = false;
  let lastResultUsage: ResultUsage | null = null;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      continue;
    }
    lastActivityTs = evt.ts;
    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    switch (evt.type) {
      case "session_started": {
        if (createdAt === null) createdAt = evt.ts;
        if (typeof payload.workdir === "string") workdir = payload.workdir;
        if (typeof payload.name === "string") name = payload.name;
        if (typeof payload.parentCcSid === "string") {
          parentCcSid = payload.parentCcSid;
        }
        if (typeof payload.parentOakridgeSid === "string") {
          parentOakridgeSid = payload.parentOakridgeSid;
        }
        break;
      }
      case "cc_session_id_observed": {
        if (typeof payload.cc_session_id === "string") {
          ccSid = payload.cc_session_id;
        }
        break;
      }
      case "tool_allowlisted": {
        if (typeof payload.tool_name === "string") {
          allowedTools.add(payload.tool_name);
        }
        break;
      }
      case "yolo_mode_changed": {
        if (typeof payload.enabled === "boolean") yoloMode = payload.enabled;
        break;
      }
      case "result": {
        const usage = extractResultUsage(payload);
        if (usage) lastResultUsage = usage;
        break;
      }
    }
  }
  if (!createdAt) return null;
  return {
    sid,
    name: name || `session-${sid.slice(0, 8)}`,
    workdir,
    // If the file is on disk and not in memory, by definition the session
    // is no longer running. A more sophisticated check would look for a
    // subprocess_exited event, but its absence just means the process
    // didn't get a chance to write it (e.g. server crash) — the session
    // is still ended either way.
    status: "ended",
    createdAt,
    lastActivityTs: lastActivityTs || createdAt,
    ccSid,
    parentCcSid,
    parentOakridgeSid,
    pendingCount: 0,
    yoloMode,
    allowedTools: [...allowedTools],
    lastResultUsage,
  };
}
