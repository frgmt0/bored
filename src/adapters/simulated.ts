/**
 * Simulated spawn/merge adapters. Workers are hand-cranked (or scripted)
 * test doubles that speak the real driver-event vocabulary; worktrees,
 * branches and shas are deterministic fakes. Used by the unit tests and by
 * the §7 simulated deployments. The git-backed adapter in ./git.ts swaps
 * the fakes for real worktrees while keeping this seat-control surface.
 */
import { createHash } from "node:crypto";
import { refToSlug } from "../run/store.js";
import type { DoneSignal, SeatKey } from "../run/events.js";
import type {
  Announcement,
  AnnounceSink,
  Clock,
  MergeOutcome,
  MergeProvider,
  NudgeReceipt,
  SeatRequest,
  SpawnAdapter,
  TokenUsage,
  WorkerEvent,
  WorkerHandle,
} from "../engine/ports.js";

export type Deliver = (ref: string, seatKey: SeatKey, ev: WorkerEvent) => Promise<void>;

function fakeSha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

/**
 * One simulated seat: the test (or a registered script) plays the worker.
 * Every method that emits a driver event awaits the engine's processing of
 * it, so a test line like `await seat.complete(...)` returns only after the
 * engine has routed the signal and taken the edge.
 */
export class SimSeat {
  readonly nudges: string[] = [];
  aborted?: { reason: string };
  finishedEmitted = false;
  private turns = 0;
  private toolCalls = 0;
  private tokens: TokenUsage = { input: 0, output: 0 };
  private readonly startedAtMs: number;

  constructor(
    readonly request: SeatRequest,
    private readonly deliver: Deliver,
    private readonly clock: Clock,
    private readonly onAbortSha: () => string,
  ) {
    this.startedAtMs = clock.now().getTime();
  }

  get handle(): WorkerHandle {
    return {
      seatKey: this.request.seatKey,
      nudge: (text: string): NudgeReceipt => {
        if (this.finishedEmitted || this.aborted) return { receipt: "dropped" };
        this.nudges.push(text);
        return { receipt: "delivered" };
      },
      abort: async (reason: string): Promise<string> => {
        this.aborted = { reason };
        return this.onAbortSha();
      },
      telemetry: () => ({
        turns: this.turns,
        toolCalls: this.toolCalls,
        tokens: this.tokens,
        wallClockS: (this.clock.now().getTime() - this.startedAtMs) / 1000,
      }),
    };
  }

  private emit(ev: WorkerEvent): Promise<void> {
    return this.deliver(this.request.ref, this.request.seatKey, ev);
  }

  /** The §6.4 readiness handshake, answered honestly. */
  async ready(): Promise<void> {
    await this.emit({ kind: "session_started" });
    await this.emit({
      kind: "worker_ready",
      manifestHash: this.request.manifest.manifestHash,
      observedBranch: this.request.branch,
      observedSha: this.request.baseSha,
    });
  }

  /** A worker that woke up somewhere it shouldn't be. */
  async readyWith(claim: {
    manifestHash?: string;
    observedBranch?: string;
    observedSha?: string;
  }): Promise<void> {
    await this.emit({ kind: "session_started" });
    await this.emit({
      kind: "worker_ready",
      manifestHash: claim.manifestHash ?? this.request.manifest.manifestHash,
      observedBranch: claim.observedBranch ?? this.request.branch,
      observedSha: claim.observedSha ?? this.request.baseSha,
    });
  }

  /** The worker's own environment check failed — it declines to start. */
  async refuse(reason: string, observed?: { branch?: string; sha?: string }): Promise<void> {
    await this.emit({ kind: "session_started" });
    await this.emit({ kind: "worker_refused", observed: { ...observed, reason } });
  }

  async turn(toolCalls = 3, tokens: TokenUsage = { input: 1200, output: 400 }): Promise<void> {
    this.turns += 1;
    this.toolCalls += toolCalls;
    this.tokens = {
      input: this.tokens.input + tokens.input,
      output: this.tokens.output + tokens.output,
    };
    await this.emit({ kind: "turn_completed", turn: this.turns, toolCalls, tokens });
  }

  async fileChange(path: string): Promise<void> {
    await this.emit({ kind: "file_change", path });
  }

  async checkpoint(sha?: string): Promise<void> {
    await this.emit({ kind: "checkpoint", sha: sha ?? this.onAbortSha() });
  }

  async stall(): Promise<void> {
    await this.emit({ kind: "stalled" });
  }

  async finish(signal: DoneSignal | null, opts: { error?: string; spendUsd?: number } = {}): Promise<void> {
    this.finishedEmitted = true;
    await this.emit({
      kind: "finished",
      signal,
      ...(opts.error !== undefined ? { error: opts.error } : {}),
      ...(opts.spendUsd !== undefined ? { spendUsd: opts.spendUsd } : {}),
    });
  }

  async complete(
    overrides: Partial<DoneSignal> & { spendUsd?: number } = {},
  ): Promise<void> {
    const { spendUsd, ...rest } = overrides;
    await this.finish(
      {
        status: "complete",
        summary: rest.summary ?? `completed ${this.request.node}`,
        filesChanged: rest.filesChanged ?? [],
        checksRun: rest.checksRun ?? null,
        blockedReason: null,
        ...(rest.data !== undefined ? { data: rest.data } : {}),
      },
      spendUsd !== undefined ? { spendUsd } : {},
    );
  }

  async blocked(reason: string, spendUsd?: number): Promise<void> {
    await this.finish(
      {
        status: "blocked",
        summary: `blocked: ${reason}`,
        filesChanged: [],
        checksRun: null,
        blockedReason: reason,
      },
      spendUsd !== undefined ? { spendUsd } : {},
    );
  }

  async partial(summary: string, spendUsd?: number): Promise<void> {
    await this.finish(
      {
        status: "partial",
        summary,
        filesChanged: [],
        checksRun: null,
        blockedReason: "partial",
      },
      spendUsd !== undefined ? { spendUsd } : {},
    );
  }

  /** The worker process dies without a done-signal (§1.6). */
  async crash(error: string, spendUsd?: number): Promise<void> {
    await this.finish(null, { error, ...(spendUsd !== undefined ? { spendUsd } : {}) });
  }
}

export type SeatScript = (seat: SimSeat) => Promise<void>;

export class SimulatedSpawnAdapter implements SpawnAdapter {
  readonly seats: SimSeat[] = [];
  private deliverFn: Deliver | null = null;
  private shaCounter = 0;
  private branchHeads = new Map<string, string>();
  private scripts = new Map<string, SeatScript>();
  private scriptQueue: Array<() => Promise<void>> = [];

  constructor(private readonly clock: Clock) {}

  /** Wire the engine's intake; must be called before any spawn. */
  connect(deliver: Deliver): void {
    this.deliverFn = deliver;
  }

  /** Auto-play seats at `node` with `script` (deployment simulations). */
  script(node: string, script: SeatScript): void {
    this.scripts.set(node, script);
  }

  /** Run queued seat scripts to quiescence, FIFO — deterministic. */
  async settle(): Promise<void> {
    while (this.scriptQueue.length > 0) {
      const job = this.scriptQueue.shift()!;
      await job();
    }
  }

  nextSha(seed = "sha"): string {
    this.shaCounter += 1;
    return fakeSha(`${seed}:${this.shaCounter}`);
  }

  taskBranch(ref: string): string {
    return `beckett/task-${refToSlug(ref)}`;
  }

  provision(id: {
    ref: string;
    node: string;
    visit: number;
    arm?: number;
    isolation?: "worktree-each" | "shared";
  }): { worktree: string; branch: string; baseSha: string } {
    const slug = refToSlug(id.ref);
    const isArm = id.arm != null && id.isolation !== "shared";
    // dot separator, matching the git adapter's ref-hierarchy constraint
    const branch = isArm ? `${this.taskBranch(id.ref)}.arm-${id.arm}` : this.taskBranch(id.ref);
    const worktree = isArm
      ? `/sim/worktrees/${slug}/arm-${id.arm}`
      : `/sim/worktrees/${slug}`;
    // Arms fork from the task branch's current head — the captured base
    // (§5.4); the task worktree just continues from its own head.
    const base = this.baseShaFor(id.ref);
    if (!this.branchHeads.has(branch)) this.branchHeads.set(branch, base);
    return { worktree, branch, baseSha: this.branchHeads.get(branch)! };
  }

  baseShaFor(ref: string): string {
    const branch = this.taskBranch(ref);
    if (!this.branchHeads.has(branch)) {
      this.branchHeads.set(branch, fakeSha(`base:${ref}`));
    }
    return this.branchHeads.get(branch)!;
  }

  /** Advance a branch head (simulating worker commits / merges). */
  advanceBranch(branch: string, seed?: string): string {
    const sha = this.nextSha(seed ?? branch);
    this.branchHeads.set(branch, sha);
    return sha;
  }

  spawn(request: SeatRequest): WorkerHandle {
    if (!this.deliverFn) throw new Error("SimulatedSpawnAdapter not connected to an engine");
    const seat = new SimSeat(request, this.deliverFn, this.clock, () => this.nextSha("wip"));
    this.seats.push(seat);
    const script = this.scripts.get(request.node);
    if (script) {
      this.scriptQueue.push(() => script(seat));
    }
    return seat.handle;
  }

  /** The latest seat spawned at a node (optionally a specific arm/attempt). */
  seat(node: string, opts: { arm?: number; attempt?: number; visit?: number } = {}): SimSeat {
    const matches = this.seats.filter(
      (s) =>
        s.request.node === node &&
        (opts.arm === undefined || s.request.arm === opts.arm) &&
        (opts.attempt === undefined || s.request.attempt === opts.attempt) &&
        (opts.visit === undefined || s.request.visit === opts.visit),
    );
    const seat = matches[matches.length - 1];
    if (!seat) {
      throw new Error(
        `no simulated seat at node "${node}" (${JSON.stringify(opts)}); spawned: ${this.seats
          .map((s) => s.request.seatKey)
          .join(", ")}`,
      );
    }
    return seat;
  }

  seatCount(node?: string): number {
    return node == null
      ? this.seats.length
      : this.seats.filter((s) => s.request.node === node).length;
  }
}

export class SimulatedMergeProvider implements MergeProvider {
  readonly merges: Array<{ ref: string; branch: string; sha: string }> = [];
  private readonly conflicts = new Map<string, string>();
  private shaCounter = 1000;

  /** Make merging `branch` conflict, once configured. */
  failOn(branch: string, conflict = `CONFLICT (content): ${branch}`): void {
    this.conflicts.set(branch, conflict);
  }

  mergeArm(ref: string, armBranch: string): MergeOutcome {
    const conflict = this.conflicts.get(armBranch);
    if (conflict) return { ok: false, conflict };
    this.shaCounter += 1;
    const sha = fakeSha(`merge:${ref}:${armBranch}:${this.shaCounter}`);
    this.merges.push({ ref, branch: armBranch, sha });
    return { ok: true, sha };
  }
}

/** An AnnounceSink that records everything, for asserting the §6 invariant. */
export class CollectingSink implements AnnounceSink {
  readonly announcements: Announcement[] = [];
  deliver(a: Announcement): void {
    this.announcements.push(a);
  }
  byType(eventType: string): Announcement[] {
    return this.announcements.filter((a) => a.eventType === eventType);
  }
  pages(): Announcement[] {
    return this.announcements.filter((a) => a.severity === "page");
  }
  statuses(): Announcement[] {
    return this.announcements.filter((a) => a.severity === "status");
  }
}
