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
  private exitPromise: Promise<number> | null = null;

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
    };
  }

  async emit(type: string, payload: unknown): Promise<EnvelopeEvent> {
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

    this._status = "live";

    const activeProc = this.proc;
    const procStdout = activeProc.stdout as ReadableStream<Uint8Array>;
    const procStderr = activeProc.stderr as ReadableStream<Uint8Array>;

    const fatalPumpError = (where: string) => (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`cc-deck: ${where} [${this.oakridgeSid}] failed: ${msg}`);
      this.shutdownSignalReceived = true;
      activeProc.kill();
    };

    void (async () => {
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

    void (async () => {
      for await (const line of readLines(procStderr)) {
        await this.emit("subprocess_stderr", { line });
      }
    })().catch(fatalPumpError("stderr pump"));

    this.exitPromise = (async () => {
      const code = await activeProc.exited;
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
    this._status = "ended";
    // Reject any still-parked approvals so the gate's curl calls don't hang
    // indefinitely on a dead subprocess.
    for (const [, pending] of this.pendingApprovals) {
      try {
        pending.resolve("deny");
      } catch {
        // ignore
      }
    }
    this.pendingApprovals.clear();
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
  }

  deleteApproval(requestId: string): PendingApproval | undefined {
    const p = this.pendingApprovals.get(requestId);
    if (p) this.pendingApprovals.delete(requestId);
    return p;
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
    for (const [requestId, pending] of this.pendingApprovals) {
      if (!predicate(pending)) continue;
      this.pendingApprovals.delete(requestId);
      pending.resolve("allow");
    }
  }

  async abort(): Promise<number> {
    if (this._status === "ended") {
      return this.exitPromise ? await this.exitPromise : 0;
    }
    this.shutdownSignalReceived = true;
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
    // spawn failed before exit promise was wired up
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
