import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface EnvelopeEvent {
  id: number;
  type: string;
  ts: string;
  payload: unknown;
}

export type Subscriber = (evt: EnvelopeEvent) => void;

export type Decision = "allow" | "deny";

export interface PendingApproval {
  resolve: (d: Decision) => void;
  toolName: string;
}

export interface SpawnCmd {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface SessionCallbacks {
  onCcSidObserved?: (session: Session, ccSid: string) => void;
  onEnded?: (session: Session) => void;
  onEmit?: (session: Session, evt: EnvelopeEvent) => void;
  onStatusChanged?: (session: Session, status: SessionStatus) => void;
  onPendingCountChanged?: (session: Session, count: number) => void;
  onLastActivityChanged?: (session: Session, ts: string) => void;
  onYoloChanged?: (session: Session, yoloMode: boolean) => void;
}

export interface SessionOpts {
  oakridgeSid: string;
  workdir: string;
  sessionsDir: string;
  parentCcSid?: string;
  parentOakridgeSid?: string;
  callbacks?: SessionCallbacks;
}

export type SessionStatus = "starting" | "live" | "ended";

/**
 * Subset of CC's `result`-event usage block. Captured on every `result`
 * emit and snapshotted so the PWA can show a rough token footprint on
 * the Resume button — important on Claude Max where a resume re-ingests
 * parent context and burns against the 5-hour rate-limit window.
 */
export interface ResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SessionSnapshot {
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

export async function readJsonlOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return "";
    }
    throw err;
  }
}

export class Session {
  readonly oakridgeSid: string;
  readonly workdir: string;
  readonly jsonlPath: string;
  readonly parentCcSid: string | null;
  readonly parentOakridgeSid: string | null;
  readonly createdAt: string;

  private readonly callbacks: SessionCallbacks;
  private readonly jsonlWriter: import("bun").FileSink;
  private nextId = 0;
  private subscribers = new Set<Subscriber>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private inputQueue: Promise<unknown> = Promise.resolve();
  // Serialize write+flush+fanout for every emit so concurrent callers
  // (stdout pump, stderr pump, /hook/approval, /yolo, etc.) can't race on
  // jsonlWriter.flush() resolution order and deliver subscriber frames
  // out of id sequence — SSE's sentUpTo dedup would permanently drop the
  // one that lost the race.
  private emitQueue: Promise<unknown> = Promise.resolve();
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private ccSid: string | null = null;
  private _status: SessionStatus = "starting";
  private shutdownSignalReceived = false;
  private lastActivityTs: string;
  private yoloMode = false;
  private allowedTools = new Set<string>();
  private lastResultUsage: ResultUsage | null = null;
  private exitPromise: Promise<number> | null = null;
  // Tracks the in-flight spawn so an abort() that arrives during the
  // starting window (between manager.sessions.set() and spawn() finishing
  // wiring the pumps + exitPromise) can wait for wiring to complete
  // instead of racing finalize() against still-running spawn code.
  private _spawnPromise: Promise<void> | null = null;
  // Aborts when finalize() runs so long-lived consumers (SSE streams,
  // subscribers) can exit their loops instead of hanging on a dead session.
  private readonly endedController = new AbortController();

  constructor(opts: SessionOpts) {
    this.oakridgeSid = opts.oakridgeSid;
    this.workdir = opts.workdir;
    this.jsonlPath = join(opts.sessionsDir, `${opts.oakridgeSid}.jsonl`);
    this.parentCcSid = opts.parentCcSid ?? null;
    this.parentOakridgeSid = opts.parentOakridgeSid ?? null;
    this.createdAt = new Date().toISOString();
    this.lastActivityTs = this.createdAt;
    this.callbacks = opts.callbacks ?? {};
    this.jsonlWriter = Bun.file(this.jsonlPath).writer();
  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentCcSid(): string | null {
    return this.ccSid;
  }

  get endedSignal(): AbortSignal {
    return this.endedController.signal;
  }

  private setStatus(status: SessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    try {
      this.callbacks.onStatusChanged?.(this, status);
    } catch (e) {
      console.error(
        `cc-deck: onStatusChanged callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  snapshot(): SessionSnapshot {
    return {
      sid: this.oakridgeSid,
      workdir: this.workdir,
      status: this._status,
      createdAt: this.createdAt,
      lastActivityTs: this.lastActivityTs,
      ccSid: this.ccSid,
      parentCcSid: this.parentCcSid,
      parentOakridgeSid: this.parentOakridgeSid,
      pendingCount: this.pendingApprovals.size,
      yoloMode: this.yoloMode,
      allowedTools: [...this.allowedTools],
      lastResultUsage: this.lastResultUsage,
    };
  }

  async emit(type: string, payload: unknown): Promise<EnvelopeEvent> {
    if (this._status === "ended") {
      // A /hook/approval handler can still try to emit permission_resolved
      // after the subprocess dies mid-decision; finalize() flipped status
      // to "ended" and closed (or is about to close) the writer. Log and
      // return a sentinel instead of queueing work onto a doomed writer.
      console.error(
        `cc-deck: dropping emit(${type}) on ended session ${this.oakridgeSid}`,
      );
      return { id: -1, type, ts: new Date().toISOString(), payload };
    }
    // Id assignment is synchronous (no await before `this.nextId++`), so
    // ids are monotonic in invocation order regardless of how many callers
    // race into emit. The queue below then preserves that same order for
    // the jsonl write and subscriber fan-out.
    const evt: EnvelopeEvent = {
      id: this.nextId++,
      type,
      ts: new Date().toISOString(),
      payload,
    };
    this.lastActivityTs = evt.ts;
    try {
      this.callbacks.onLastActivityChanged?.(this, evt.ts);
    } catch (e) {
      console.error(
        `cc-deck: onLastActivityChanged callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    // Capture the usage block off CC's result events so the PWA can
    // surface a rough parent-context size on the Resume button. Each new
    // result overwrites the prior one — the most recent usage is what
    // matters for "how much will a resume cost."
    if (type === "result") {
      const usage = extractResultUsage(payload);
      if (usage) this.lastResultUsage = usage;
    }
    const task = async () => {
      this.jsonlWriter.write(JSON.stringify(evt) + "\n");
      await this.jsonlWriter.flush();
      for (const cb of this.subscribers) {
        try {
          cb(evt);
        } catch {
          // one subscriber's failure shouldn't affect others
        }
      }
      try {
        this.callbacks.onEmit?.(this, evt);
      } catch {
        // a badly-behaved manager hook mustn't corrupt per-session state
      }
    };
    const next = this.emitQueue.then(task, task);
    this.emitQueue = next;
    await next;
    return evt;
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  async readJsonl(): Promise<string> {
    return readJsonlOrEmpty(this.jsonlPath);
  }

  async spawn(cmd: SpawnCmd): Promise<void> {
    if (this._spawnPromise) return this._spawnPromise;
    // Capture the promise synchronously (no await before this assignment
    // in the caller sequence) so a concurrent abort() can reliably find
    // it via the sync prefix of this call.
    this._spawnPromise = this._runSpawn(cmd);
    return this._spawnPromise;
  }

  private async _runSpawn(cmd: SpawnCmd): Promise<void> {
    await this.emit("session_started", {
      command: cmd.cmd,
      workdir: this.workdir,
      sessionId: this.oakridgeSid,
      parentCcSid: this.parentCcSid,
      parentOakridgeSid: this.parentOakridgeSid,
    });

    try {
      this.proc = Bun.spawn({
        cmd: cmd.cmd,
        cwd: cmd.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: cmd.env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.emit("subprocess_exited", {
        code: -1,
        reason: `spawn failed: ${msg}`,
      });
      await this.finalize();
      throw err;
    }

    this.setStatus("live");

    const activeProc = this.proc;
    const procStdout = activeProc.stdout as ReadableStream<Uint8Array>;
    const procStderr = activeProc.stderr as ReadableStream<Uint8Array>;

    const fatalPumpError = (where: string) => (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`cc-deck: ${where} [${this.oakridgeSid}] failed: ${msg}`);
      this.shutdownSignalReceived = true;
      activeProc.kill();
    };

    const stdoutPump = (async () => {
      for await (const line of readLines(procStdout)) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          const type = typeof raw?.type === "string" ? raw.type : "unknown";
          await this.emit(type, raw);
          // Capture CC's session id from its init event. Recorded into this
          // session's own JSONL as cc_session_id_observed so resume survives
          // a server restart, and also reported to the manager so
          // /hook/approval can route CC's hooks (which carry CC's session_id)
          // back to this oakridge session.
          if (
            type === "system" &&
            raw &&
            typeof raw === "object" &&
            raw.subtype === "init" &&
            typeof raw.session_id === "string" &&
            this.ccSid === null
          ) {
            this.ccSid = raw.session_id;
            const capturedCcSid = raw.session_id;
            await this.emit("cc_session_id_observed", {
              cc_session_id: capturedCcSid,
            });
            try {
              this.callbacks.onCcSidObserved?.(this, capturedCcSid);
            } catch (e) {
              console.error(
                `cc-deck: onCcSidObserved callback failed: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              );
            }
          }
        } catch (err) {
          await this.emit("subprocess_stdout_parse_error", {
            line,
            error: (err as Error).message,
          });
        }
      }
    })().catch(fatalPumpError("stdout pump"));

    const stderrPump = (async () => {
      for await (const line of readLines(procStderr)) {
        await this.emit("subprocess_stderr", { line });
      }
    })().catch(fatalPumpError("stderr pump"));

    this.exitPromise = (async () => {
      const code = await activeProc.exited;
      // Wait for both pumps to drain their buffers — activeProc.exited can
      // resolve before readLines() has finished yielding the last of the
      // stdout/stderr lines. Without this, finalize() would flip _status
      // to "ended" and the trailing pump emits would short-circuit to
      // the sentinel branch.
      await Promise.allSettled([stdoutPump, stderrPump]);
      // finalize() must run even if the exit emit throws (disk full, perm
      // error), otherwise pending approvals stay parked and the jsonl
      // writer is never ended.
      try {
        await this.emit("subprocess_exited", {
          code,
          reason: this.shutdownSignalReceived
            ? "operator signal"
            : code === 0
              ? "clean"
              : "error",
        });
      } finally {
        await this.finalize();
      }
      return code;
    })();

    this.exitPromise.catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `cc-deck: session ${this.oakridgeSid} shutdown failed: ${msg}`,
      );
    });
  }

  private async finalize(): Promise<void> {
    // Idempotent: abort() and the exitPromise's finally can both race into
    // finalize; the first one wins and the second is a no-op.
    if (this._status === "ended") return;
    // Write terminal permission_resolved frames for every still-parked
    // approval BEFORE flipping status. Once setStatus("ended") runs, emit()
    // short-circuits, so if we resolved the pending promises first the
    // /hook/approval handler would race to emit its own
    // permission_resolved and hit the short-circuit — leaving the JSONL
    // with a permission_request that has no terminal resolution. Emitting
    // here (status still "live", writer still open) keeps the transcript
    // closed over every request.
    //
    // The .delete() below happens synchronously BEFORE the await, which
    // claims ownership of the request_id atomically. If a concurrent
    // /:sid/approval handler is resolving the same request, its
    // deleteApproval() either already ran (we see .get() === undefined
    // and skip) or races and finds nothing — either way only one
    // permission_resolved entry makes it to the JSONL.
    const parkedRequestIds = [...this.pendingApprovals.keys()];
    let resolvedCount = 0;
    for (const requestId of parkedRequestIds) {
      const pending = this.pendingApprovals.get(requestId);
      if (!pending) continue;
      this.pendingApprovals.delete(requestId);
      try {
        await this.emit("permission_resolved", {
          request_id: requestId,
          decision: "deny",
          reason: "session_ended",
        });
      } catch (err) {
        console.error(
          `cc-deck: failed to emit terminal permission_resolved for ${requestId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        pending.resolve("deny");
      } catch {
        // ignore
      }
      resolvedCount++;
    }
    // Flip status BEFORE draining so any emit() racing with finalize sees
    // the ended flag and short-circuits instead of queueing new writes
    // onto a writer we're about to close.
    this.setStatus("ended");
    // Unblock long-lived consumers (SSE streams, subscribers) waiting on
    // events from this session. Done before resolving pending approvals so
    // stream loops see the aborted signal promptly.
    this.endedController.abort();
    // Sweep anything that slipped in during the emit loop (a /hook/approval
    // that racked between our status check and the final clear). These are
    // resolved without a JSONL entry since status is now ended; the
    // handler's own emit will short-circuit as before.
    const hadStragglers = this.pendingApprovals.size > 0;
    for (const [, pending] of this.pendingApprovals) {
      try {
        pending.resolve("deny");
      } catch {
        // ignore
      }
    }
    this.pendingApprovals.clear();
    if (resolvedCount > 0 || hadStragglers) this.firePendingCountChanged();
    // Drain in-flight emit work (write+flush+fanout) before closing the
    // writer — otherwise queued tasks that were accepted before the status
    // flip would hit an ended writer.
    try {
      await this.emitQueue;
    } catch (err) {
      console.error(
        `cc-deck: emit queue drain failed for ${this.oakridgeSid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      await this.jsonlWriter.end();
    } catch (err) {
      console.error(
        `cc-deck: jsonl writer end failed for ${this.oakridgeSid}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    try {
      this.callbacks.onEnded?.(this);
    } catch (e) {
      console.error(
        `cc-deck: onEnded callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  async writeInput(text: string): Promise<void> {
    if (!this.proc || this._status !== "live") {
      throw new SessionNotReadyError();
    }
    const stdin = this.proc.stdin as import("bun").FileSink;
    const task = async () => {
      const line =
        JSON.stringify({
          type: "user",
          message: { role: "user", content: text },
        }) + "\n";
      stdin.write(line);
      await stdin.flush();
    };
    this.inputQueue = this.inputQueue.then(task, task);
    await this.inputQueue;
  }

  registerApproval(requestId: string, pending: PendingApproval): void {
    this.pendingApprovals.set(requestId, pending);
    this.firePendingCountChanged();
  }

  deleteApproval(requestId: string): PendingApproval | undefined {
    const p = this.pendingApprovals.get(requestId);
    if (p) {
      this.pendingApprovals.delete(requestId);
      this.firePendingCountChanged();
    }
    return p;
  }

  private firePendingCountChanged(): void {
    try {
      this.callbacks.onPendingCountChanged?.(this, this.pendingApprovals.size);
    } catch (e) {
      console.error(
        `cc-deck: onPendingCountChanged callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  getApproval(requestId: string): PendingApproval | undefined {
    return this.pendingApprovals.get(requestId);
  }

  hasApproval(requestId: string): boolean {
    return this.pendingApprovals.has(requestId);
  }

  get yolo(): boolean {
    return this.yoloMode;
  }

  get toolAllowlist(): ReadonlySet<string> {
    return this.allowedTools;
  }

  /**
   * Emits yolo_mode_changed and flips yoloMode, but only when the value
   * actually changes. The emit happens before the mutation so the JSONL log
   * stays authoritative if emit throws.
   */
  async setYolo(enabled: boolean): Promise<boolean> {
    if (this.yoloMode === enabled) return this.yoloMode;
    await this.emit("yolo_mode_changed", { enabled });
    this.yoloMode = enabled;
    try {
      this.callbacks.onYoloChanged?.(this, this.yoloMode);
    } catch (e) {
      console.error(
        `cc-deck: onYoloChanged callback failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (this.yoloMode) this.drainParkedFor(() => true);
    return this.yoloMode;
  }

  /**
   * Adds a tool to this session's allowlist and drains any parked approvals
   * for that tool. Idempotent: if the tool is already allowlisted, returns
   * without emitting.
   */
  async allowlistTool(toolName: string): Promise<void> {
    if (this.allowedTools.has(toolName)) return;
    await this.emit("tool_allowlisted", { tool_name: toolName });
    this.allowedTools.add(toolName);
    this.drainParkedFor((p) => p.toolName === toolName);
  }

  drainParkedFor(predicate: (a: PendingApproval) => boolean): void {
    let drained = false;
    for (const [requestId, pending] of this.pendingApprovals) {
      if (!predicate(pending)) continue;
      this.pendingApprovals.delete(requestId);
      pending.resolve("allow");
      drained = true;
    }
    if (drained) this.firePendingCountChanged();
  }

  async abort(): Promise<number> {
    this.shutdownSignalReceived = true;
    // Wait for spawn to finish wiring (or fail). Without this, an abort
    // arriving in the "starting" window could finalize() the session
    // while _runSpawn() is still mid-way through wiring pumps, producing
    // write-after-end on the jsonl writer.
    if (this._spawnPromise) {
      try {
        await this._spawnPromise;
      } catch {
        // Spawn failed and finalize() already ran; fall through to the
        // ended-state handling below.
      }
    }
    if (this._status === "ended") {
      if (this.exitPromise) {
        try {
          return await this.exitPromise;
        } catch {
          return 1;
        }
      }
      // Ended without an exitPromise means _runSpawn() threw (Bun.spawn
      // failed) before we wired the exit handler. That's a failure, not
      // a clean exit — report non-zero so endAll()/DELETE aggregate it
      // as an error.
      return 1;
    }
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // proc may already be dead; finalize via exitPromise handles it
      }
    }
    if (this.exitPromise) {
      try {
        return await this.exitPromise;
      } catch {
        return 1;
      }
    }
    // No exit promise wired (spawn was never called or Session was used
    // outside the manager); finalize synchronously to clean up.
    await this.finalize();
    return 1;
  }
}

export class SessionNotReadyError extends Error {
  constructor() {
    super("subprocess not ready");
    this.name = "SessionNotReadyError";
  }
}

export function extractResultUsage(payload: unknown): ResultUsage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : null;
  const output = typeof u.output_tokens === "number" ? u.output_tokens : null;
  if (input === null || output === null) return null;
  const result: ResultUsage = {
    input_tokens: input,
    output_tokens: output,
  };
  if (typeof u.cache_creation_input_tokens === "number") {
    result.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }
  if (typeof u.cache_read_input_tokens === "number") {
    result.cache_read_input_tokens = u.cache_read_input_tokens;
  }
  return result;
}

export function newSessionId(): string {
  return randomUUID();
}

async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const trimCR = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode();
        if (buf.length > 0) yield trimCR(buf);
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        yield trimCR(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
