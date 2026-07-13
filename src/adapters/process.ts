/**
 * The real agent-spawn adapter — the piece the review called "literally
 * unimplemented, so it can't run work". It spawns an actual worker process
 * per seat (any harness CLI: claude, codex, a shell script) inside the
 * seat's git worktree, and speaks a line-oriented JSON driver protocol:
 *
 *   worker stdout → engine (one JSON object per line):
 *     {"kind":"session_started"}
 *     {"kind":"worker_ready","manifestHash":…,"observedBranch":…,"observedSha":…}
 *     {"kind":"worker_refused","observed":{…}}
 *     {"kind":"turn_completed","turn":N,"toolCalls":N,"tokens":{"input":N,"output":N}}
 *     {"kind":"file_change","path":…}
 *     {"kind":"checkpoint","sha":…}
 *     {"kind":"stalled"}
 *     {"kind":"finished","signal":{…done-signal…},"spendUsd":N}
 *
 *   engine → worker stdin:
 *     {"kind":"nudge","text":…}
 *
 * Before launch the adapter writes the §6.4 stage manifest to
 * `.beckett/stage-manifest.json` and the brief to `.beckett/brief.md` in
 * the worktree, and exports BECKETT_MANIFEST / BECKETT_BRIEF so the worker
 * can complete the readiness handshake (echo the manifest hash plus the
 * branch/sha it actually observes via git).
 *
 * Failure honesty is preserved end to end: non-JSON stdout is ignored as
 * chatter; a process that exits without a `finished` line synthesizes
 * `finished{signal:null}` — the engine's silent-exit alarm and retry ladder
 * take it from there. Abort commits WIP in the worktree, then terminates
 * the process tree.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SeatRequest, SpawnAdapter, TokenUsage, WorkerEvent, WorkerHandle } from "../engine/ports.js";
import type { DoneSignal } from "../run/events.js";
import { GitWorktreeSpawnAdapter } from "./git.js";
import type { Deliver } from "./simulated.js";

export interface WorkerCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/** Resolve the command for a seat — typically keyed off request.cast.harness. */
export type CommandResolver = (request: SeatRequest) => WorkerCommand;

interface LiveProcess {
  request: SeatRequest;
  child: ChildProcessWithoutNullStreams;
  startedAtMs: number;
  finishedDelivered: boolean;
  aborted: boolean;
  timeout?: NodeJS.Timeout;
  terminate?: Promise<string>;
  turns: number;
  toolCalls: number;
  tokens: TokenUsage;
}

export class ProcessSpawnAdapter implements SpawnAdapter {
  private deliverFn: Deliver | null = null;
  private readonly live = new Map<string, LiveProcess>();
  /** per-seat delivery chains keep driver events strictly ordered */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    /** provisioning (worktrees, branches, base shas, WIP commits) is git's */
    private readonly git: GitWorktreeSpawnAdapter,
    private readonly command: CommandResolver,
    private readonly opts: { killGraceMs?: number; executionTimeoutMs?: number } = {},
  ) {}

  connect(deliver: Deliver): void {
    this.deliverFn = deliver;
  }

  provision(id: {
    ref: string;
    node: string;
    visit: number;
    arm?: number;
    isolation?: "worktree-each" | "shared";
  }): { worktree: string; branch: string; baseSha: string } {
    return this.git.provision(id);
  }

  baseShaFor(ref: string): string {
    return this.git.baseShaFor(ref);
  }

  /** Wait for every live child to exit (drain for tests / shutdown). */
  async drain(): Promise<void> {
    while (this.live.size > 0 || (await this.anyChainPending())) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Reap every live process group before tracker shutdown. */
  async shutdown(reason = "tracker_shutdown"): Promise<void> {
    await Promise.all([...this.live.values()].map((proc) => this.terminate(proc, reason)));
    await this.drain();
  }

  private async anyChainPending(): Promise<boolean> {
    await Promise.all([...this.chains.values()]);
    return false;
  }

  spawn(request: SeatRequest): WorkerHandle {
    if (!this.deliverFn) throw new Error("ProcessSpawnAdapter not connected to an engine");
    const dotdir = path.join(request.worktree, ".beckett");
    fs.mkdirSync(dotdir, { recursive: true });
    const manifestPath = path.join(dotdir, "stage-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(request.manifest, null, 2));
    const briefPath = path.join(dotdir, "brief.md");
    fs.writeFileSync(briefPath, renderBrief(request));

    const { cmd, args, env } = this.command(request);
    const child = spawn(cmd, args, {
      cwd: request.worktree,
      env: {
        ...process.env,
        ...env,
        BECKETT_MANIFEST: manifestPath,
        BECKETT_BRIEF: briefPath,
        BECKETT_SEAT: request.seatKey,
        BECKETT_REF: request.ref,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // A detached child is the leader of a new process group on POSIX. This
      // lets abort/timeout kill the worker's grandchildren, not just its PID.
      detached: process.platform !== "win32",
    });

    const key = `${request.ref}::${request.seatKey}`;
    const proc: LiveProcess = {
      request,
      child,
      startedAtMs: Date.now(),
      finishedDelivered: false,
      aborted: false,
      turns: 0,
      toolCalls: 0,
      tokens: { input: 0, output: 0 },
    };
    this.live.set(key, proc);
    const timeoutMs = this.opts.executionTimeoutMs ?? request.envelope.wallClockS * 1000;
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      proc.timeout = setTimeout(() => {
        void this.terminate(proc, "execution_timeout", timeoutMs).then(() => {
          this.enqueue(key, proc, {
            kind: "timeout",
            timeoutMs,
            reason: "execution_timeout",
          });
        });
      }, timeoutMs);
      proc.timeout.unref();
    }

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) this.handleLine(key, proc, line);
      }
    });
    child.stderr.on("data", () => {
      /* stderr is deliberately not mixed into the structured event feed */
    });
    child.on("error", (err) => {
      // spawn(ENOENT) may emit close without exit. Terminate/commit anyway,
      // then drive the same visible synthetic-exit path as a crashed worker.
      void this.terminate(proc, "spawn_process_error").then(() => {
        this.enqueue(key, proc, { kind: "error", code: "SPAWN_PROCESS_ERROR", message: err.message });
        this.enqueue(key, proc, { kind: "aborted", reason: "spawn_process_error" });
        this.live.delete(key);
      });
    });
    child.on("exit", (code, signal) => {
      if (proc.timeout) clearTimeout(proc.timeout);
      delete proc.timeout;
      const tail = buffer.trim();
      if (tail) this.handleLine(key, proc, tail);
      if (!proc.finishedDelivered && !proc.aborted) {
        // An exiting parent can leave grandchildren behind. Commit WIP then
        // kill its detached group before publishing the synthetic failure.
        void this.terminate(proc, "worker_unexpected_exit").then(() => {
          this.enqueue(key, proc, {
            kind: "error",
            code: "WORKER_UNEXPECTED_EXIT",
            message: `worker exited code=${code ?? "null"} signal=${signal ?? "none"}`,
          });
          // Do not merely synthesize a finished signal here: the worker has
          // already died, so this is an abort with a WIP receipt. The engine
          // records seat_aborted before taking its retry ladder.
          this.enqueue(key, proc, { kind: "aborted", reason: "worker_unexpected_exit" });
          this.live.delete(key);
        });
        return;
      }
      // A normal done-signal still must not leave a helper in this seat's
      // process group after the worker leader has exited.
      if (!proc.aborted) this.killProcessGroup(proc, "SIGTERM");
      this.live.delete(key);
    });

    return {
      seatKey: request.seatKey,
      nudge: (text: string) => {
        if (proc.child.exitCode != null || proc.aborted) return { receipt: "dropped" as const };
        try {
          proc.child.stdin.write(JSON.stringify({ kind: "nudge", text }) + "\n");
          return { receipt: "delivered" as const };
        } catch (err) {
          this.enqueue(key, proc, {
            kind: "error",
            code: "NUDGE_WRITE_FAILED",
            message: err instanceof Error ? err.message : String(err),
          });
          return { receipt: "dropped" as const };
        }
      },
      abort: async (reason: string) => this.terminate(proc, reason),
      telemetry: () => ({
        turns: proc.turns,
        toolCalls: proc.toolCalls,
        tokens: proc.tokens,
        wallClockS: (Date.now() - proc.startedAtMs) / 1000,
      }),
    };
  }

  /** Commit first, then terminate the complete process group and wait for reaping. */
  private terminate(proc: LiveProcess, reason: string, timeoutMs?: number): Promise<string> {
    if (proc.terminate) return proc.terminate;
    proc.aborted = true;
    if (proc.timeout) clearTimeout(proc.timeout);
    delete proc.timeout;
    proc.terminate = (async () => {
      let sha = "";
      try {
        // --allow-empty in the git adapter means even a clean abort has a WIP receipt.
        sha = this.git.commitWip(proc.request.worktree, `WIP: seat aborted (${reason})`);
      } catch (err) {
        this.enqueue(`${proc.request.ref}::${proc.request.seatKey}`, proc, {
          kind: "error",
          code: "WIP_COMMIT_FAILED",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      const exited = this.waitForExit(proc.child);
      this.killProcessGroup(proc, "SIGTERM");
      const grace = this.opts.killGraceMs ?? 3000;
      // `exit` only proves the leader is gone. A process group can outlive
      // its leader, so also poll the group itself before declaring it reaped.
      if (!(await this.waitForReap(proc, exited, grace))) {
        this.killProcessGroup(proc, "SIGKILL");
        if (!(await this.waitForReap(proc, exited, 1000))) {
          this.enqueue(`${proc.request.ref}::${proc.request.seatKey}`, proc, {
            kind: "error",
            code: "PROCESS_GROUP_REAP_TIMEOUT",
            message: "worker process group remained after SIGKILL",
          });
        }
      }
      void timeoutMs;
      return sha;
    })();
    return proc.terminate;
  }

  private killProcessGroup(proc: LiveProcess, signal: NodeJS.Signals): void {
    const { child } = proc;
    if (child.pid == null) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (err) {
      // ESRCH is the successful "already reaped" outcome. Other failures
      // are durable operator-visible errors, never a swallowed kill failure.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        this.enqueue(`${proc.request.ref}::${proc.request.seatKey}`, proc, {
          kind: "error",
          code: "PROCESS_GROUP_KILL_FAILED",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async waitForReap(
    proc: LiveProcess,
    exited: Promise<void>,
    ms: number,
  ): Promise<boolean> {
    const leaderExited = await settlesWithin(exited, ms);
    if (!leaderExited) return false;
    if (process.platform === "win32" || proc.child.pid == null) return true;
    return processGroupGone(proc.child.pid, ms);
  }

  private waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
    // `spawn` errors can produce close without exit. Either proves Node has
    // released the child handle and lets the caller finish its WIP receipt.
    return new Promise((resolve) => {
      const done = () => {
        child.removeListener("exit", done);
        child.removeListener("close", done);
        resolve();
      };
      child.once("exit", done);
      child.once("close", done);
    });
  }

  private handleLine(key: string, proc: LiveProcess, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // non-protocol stdout is worker chatter, not an event
    }
    const ev = coerceWorkerEvent(parsed);
    if (!ev) return;
    if (ev.kind === "turn_completed") {
      proc.turns += 1;
      proc.toolCalls += ev.toolCalls;
      proc.tokens = {
        input: proc.tokens.input + ev.tokens.input,
        output: proc.tokens.output + ev.tokens.output,
      };
    }
    if (ev.kind === "finished") proc.finishedDelivered = true;
    this.enqueue(key, proc, ev);
  }

  private enqueue(key: string, proc: LiveProcess, ev: WorkerEvent): void {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() =>
      this.deliverFn!(proc.request.ref, proc.request.seatKey, ev).catch(() => {
        /* engine dropped a late event — fine */
      }),
    );
    this.chains.set(key, next);
  }
}

/** Validate a decoded protocol line into a WorkerEvent (or reject it). */
export function coerceWorkerEvent(data: unknown): WorkerEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const ev = data as Record<string, unknown>;
  switch (ev["kind"]) {
    case "session_started":
    case "stalled":
      return { kind: ev["kind"] };
    case "worker_ready":
      if (
        typeof ev["manifestHash"] === "string" &&
        typeof ev["observedBranch"] === "string" &&
        typeof ev["observedSha"] === "string"
      ) {
        return {
          kind: "worker_ready",
          manifestHash: ev["manifestHash"],
          observedBranch: ev["observedBranch"],
          observedSha: ev["observedSha"],
        };
      }
      return null;
    case "worker_refused":
      return {
        kind: "worker_refused",
        observed: (ev["observed"] as Record<string, string>) ?? {},
      };
    case "turn_completed": {
      const tokens = ev["tokens"] as { input?: number; output?: number } | undefined;
      return {
        kind: "turn_completed",
        turn: Number(ev["turn"] ?? 0),
        toolCalls: Number(ev["toolCalls"] ?? 0),
        tokens: { input: Number(tokens?.input ?? 0), output: Number(tokens?.output ?? 0) },
      };
    }
    case "file_change":
      return typeof ev["path"] === "string" ? { kind: "file_change", path: ev["path"] } : null;
    case "checkpoint":
      return typeof ev["sha"] === "string" ? { kind: "checkpoint", sha: ev["sha"] } : null;
    case "finished": {
      const raw = ev["signal"];
      let signal: DoneSignal | null = null;
      if (raw && typeof raw === "object") {
        const s = raw as Record<string, unknown>;
        if (["complete", "blocked", "partial"].includes(s["status"] as string)) {
          signal = {
            status: s["status"] as DoneSignal["status"],
            summary: String(s["summary"] ?? ""),
            filesChanged: Array.isArray(s["filesChanged"]) ? (s["filesChanged"] as string[]) : [],
            checksRun: Array.isArray(s["checksRun"]) ? (s["checksRun"] as string[]) : null,
            blockedReason: typeof s["blockedReason"] === "string" ? s["blockedReason"] : null,
            ...(s["data"] && typeof s["data"] === "object"
              ? { data: s["data"] as Record<string, unknown> }
              : {}),
          };
        }
      }
      return {
        kind: "finished",
        signal,
        ...(typeof ev["error"] === "string" ? { error: ev["error"] } : {}),
        ...(typeof ev["spendUsd"] === "number" ? { spendUsd: ev["spendUsd"] } : {}),
      };
    }
    default:
      return null;
  }
}

async function settlesWithin(done: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** True only once no process remains in the detached worker's process group. */
async function processGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
      // EPERM means the group still exists but cannot be inspected as us.
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function renderBrief(request: SeatRequest): string {
  const b = request.briefParts;
  const lines = [
    `# ${request.ref} — ${request.node} (visit ${request.visit}${request.arm != null ? `, arm ${request.arm}` : ""})`,
    "",
    b.body,
  ];
  if (b.criteria.length) {
    lines.push("", "## Acceptance criteria", ...b.criteria.map((c) => `- ${c}`));
  }
  if (b.nodeBrief) lines.push("", "## Stage instruction", b.nodeBrief);
  if (b.rubric) lines.push("", "## Rubric", b.rubric);
  if (b.priorArtifacts.length) {
    lines.push("", "## Prior artifacts", ...b.priorArtifacts.map((a) => `- ${a.path} (from ${a.fromNode})`));
  }
  if (b.steers.length) {
    lines.push("", "## Steering", ...b.steers.map((s) => `- ${s.text}`));
  }
  lines.push(
    "",
    "## Envelope (advisory)",
    `- ${request.envelope.turnCap} turns / ${request.envelope.wallClockS}s`,
  );
  return lines.join("\n") + "\n";
}
