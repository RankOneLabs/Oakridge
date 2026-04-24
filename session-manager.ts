import {
  Session,
  newSessionId,
  type SessionSnapshot,
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
  parentCcSid?: string;
  parentOakridgeSid?: string;
}

export class SessionManager {
  private readonly opts: SessionManagerOpts;
  private readonly sessions = new Map<string, Session>();
  /**
   * Maps CC's session_id (captured from system/init) back to our
   * oakridgeSid, so /hook/approval can route incoming hooks — which carry
   * CC's session_id in the payload, not ours — to the right Session.
   */
  private readonly ccSidToOakridgeSid = new Map<string, string>();

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
  }

  async create(opts: CreateSessionOpts): Promise<Session> {
    const session = new Session({
      oakridgeSid: newSessionId(),
      workdir: opts.workdir,
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
        },
      },
    });
    // Register in the live map before spawn so /hook/approval can find the
    // session as soon as system/init arrives. If spawn throws, we remove it.
    this.sessions.set(session.oakridgeSid, session);
    try {
      await session.spawn(this.opts.buildSpawnCmd(session));
    } catch (err) {
      // Keep the ended session in the map briefly so clients that POSTed /sessions
      // and want to read the failure via /:sid/events can still do so. A future
      // PR can add explicit reaping of ended sessions; for now they accumulate
      // in memory over the server's lifetime, which is bounded.
      throw err;
    }
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

  listSnapshots(): SessionSnapshot[] {
    return this.list().map((s) => s.snapshot());
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
   * Aborts every live session and awaits each one's finalize path
   * (jsonlWriter.end, subprocess_exited emit, ended callback). Returns the
   * worst non-zero exit code across all sessions, or 0 if all exited cleanly.
   */
  async endAll(): Promise<number> {
    const exits = await Promise.all(
      [...this.sessions.values()].map((s) => s.abort().catch(() => 1)),
    );
    return exits.reduce((worst, c) => (c !== 0 ? c : worst), 0);
  }
}
