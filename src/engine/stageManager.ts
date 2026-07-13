/**
 * The Stage Manager — §5. A per-task interpreter with one job: hold a
 * durable FlowRun record, advance cursors along edges when done-signals
 * arrive, and enforce budgets. It replaces the dispatcher's state-switch; it
 * deliberately does not replace the spawn path, the drivers, or any
 * durability machinery (those sit behind the SpawnAdapter / MergeProvider
 * ports).
 *
 * Every advance follows §4.3's exact order of operations:
 *   1. APPEND the triggering event to runs/<ref>.jsonl; fsync. If this
 *      write fails, nothing happened.
 *   2. FOLD the log into the FlowRun head — pure and deterministic.
 *   3. DECIDE the edge set the new state enables.
 *   4. GATE every intended spawn against budgets and caps *before* a seat
 *      is requested — a refusal becomes budget_hit + park.
 *   5. ACT — seats requested from the Scheduler keyed by (ref, node,
 *      visit, arm); replay-idempotent, deduped against live seats.
 *   6. ANNOUNCE — the Herald classifies the appended events and delivers.
 *      Announcement is after the fsync, so a page never refers to state
 *      that didn't commit.
 */
import {
  EDGE_DONE,
  EDGE_PARK,
  envelopeFor,
  maxFailsOf,
  maxVisitsOf,
  resolveSupervise,
  retriesOf,
  type FanoutNode,
  type FlowNode,
  type FlowSpec,
  type GateNode,
  type HarnessSpec,
  type JoinNode,
  type NodeId,
} from "../spec/types.js";
import { mustLint, type LintOptions } from "../spec/lint.js";
import {
  seatKeyOf,
  type DoneSignal,
  type EdgeWhy,
  type ParkReason,
  type RunEvent,
  type RunEventInput,
  type RunTotals,
  type SeatKey,
  type SignalSubtype,
} from "../run/events.js";
import { effectiveMaxVisits, type FlowRun } from "../run/fold.js";
import { RunStore } from "../run/store.js";
import { buildManifest, verifyReadiness, type StageManifest } from "./manifest.js";
import { SeatScheduler, type SeatIntent } from "./scheduler.js";
import { Sentinel, type SentinelAction } from "./sentinel.js";
import { Herald } from "./herald.js";
import type {
  ArtifactRef,
  Clock,
  MergeProvider,
  NudgeReceipt,
  SeatRequest,
  SpawnAdapter,
  WorkerEvent,
  WorkerHandle,
} from "./ports.js";

export interface OpenOptions {
  originChannel?: string;
  body?: string;
  criteria?: string[];
}

export interface ResumeGrant {
  extraVisits?: number;
  extraUsd?: number;
  extraWallClockS?: number;
  gate?: { node: NodeId; verdict: "pass" | "fail"; note?: string };
}

interface LiveSeat {
  ref: string;
  request: SeatRequest;
  handle: WorkerHandle;
}

export interface StageManagerOptions {
  clock: Clock;
  maxWorkers?: number;
  hardCapS?: number;
  blockedModels?: string[];
  ownerDM?: string;
  defaultChannel?: string;
  /**
   * Programmatic tap on the event stream, invoked synchronously after each
   * append + announce. The tracker layer projects ticket states and drives
   * cross-task promotion from this.
   */
  onEvent?: (ref: string, event: RunEvent, run: FlowRun) => void;
}

export class StageManager {
  readonly store: RunStore;
  readonly scheduler: SeatScheduler;
  readonly sentinel: Sentinel;
  readonly herald: Herald;
  private readonly clock: Clock;
  private readonly lintOpts: LintOptions;
  private readonly onEvent: StageManagerOptions["onEvent"];
  /** live worker handles, keyed ref::seatKey — in-memory only, rebuilt by recovery */
  private seats = new Map<string, LiveSeat>();
  /** runs mid-pause/cancel/fail-fast: signals append but do not advance */
  private suppressAdvance = new Set<string>();

  constructor(
    root: string,
    private readonly spawner: SpawnAdapter,
    private readonly merger: MergeProvider,
    announceSink: { deliver: (a: import("./ports.js").Announcement) => void },
    opts: StageManagerOptions,
  ) {
    this.clock = opts.clock;
    this.onEvent = opts.onEvent;
    this.store = new RunStore(root);
    this.scheduler = new SeatScheduler(opts.maxWorkers ?? 8);
    this.sentinel = new Sentinel(opts.hardCapS ?? 3600);
    this.herald = new Herald(this.store, announceSink, this.clock, {
      ownerDM: opts.ownerDM ?? "owner-dm",
      ...(opts.defaultChannel !== undefined ? { defaultChannel: opts.defaultChannel } : {}),
    });
    this.lintOpts = {
      maxWorkers: opts.maxWorkers ?? 8,
      ...(opts.blockedModels !== undefined ? { blockedModels: opts.blockedModels } : {}),
    };
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private now(): string {
    return this.clock.now().toISOString();
  }

  private nowMs(): number {
    return this.clock.now().getTime();
  }

  /** §4.3 steps 1, 2 and 6: append + fsync, fold, announce. */
  private append(ref: string, input: RunEventInput): { event: RunEvent; run: FlowRun } {
    const event = this.store.append(ref, this.now(), input);
    const run = this.store.fold(ref);
    this.herald.announce(ref, event, run);
    this.onEvent?.(ref, event, run);
    return { event, run };
  }

  fold(ref: string): FlowRun {
    return this.store.fold(ref);
  }

  status(ref: string): FlowRun {
    return this.fold(ref);
  }

  private liveSeat(ref: string, seatKey: SeatKey): LiveSeat | undefined {
    return this.seats.get(`${ref}::${seatKey}`);
  }

  private liveSeatsOf(ref: string): LiveSeat[] {
    return [...this.seats.values()].filter((s) => s.ref === ref);
  }

  private nodeOf(run: FlowRun, id: NodeId): FlowNode {
    const node = run.spec.nodes[id];
    if (!node) throw new Error(`run ${run.taskRef}: unknown node "${id}"`);
    return node;
  }

  private totals(run: FlowRun): RunTotals {
    return {
      spendUsd: run.spend.usd,
      seats: Object.keys(run.seats).length,
      wallClockS: (this.nowMs() - Date.parse(run.openedAt)) / 1000,
    };
  }

  // ── the concierge-facing verbs (§4.2 contract 1) ────────────────────────

  /** validate → run_opened → enter entry node. */
  async open(ref: string, specData: unknown, opts: OpenOptions = {}): Promise<FlowRun> {
    if (this.store.exists(ref)) throw new Error(`run ${ref} already exists`);
    const spec: FlowSpec = mustLint(specData, this.lintOpts);
    this.append(ref, {
      type: "run_opened",
      taskRef: ref,
      spec,
      ...(opts.originChannel !== undefined ? { originChannel: opts.originChannel } : {}),
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      ...(opts.criteria !== undefined ? { criteria: opts.criteria } : {}),
    });
    await this.enterNode(ref, spec.entry);
    return this.fold(ref);
  }

  /** Steering — a first-class verb (§5.5). */
  nudge(ref: string, text: string, node?: NodeId): NudgeReceipt {
    const run = this.fold(ref);
    const live = this.liveSeatsOf(ref).filter(
      (s) => node == null || s.request.node === node,
    );
    if (live.length === 0) {
      this.append(ref, { type: "nudge_delivered", receipt: "queued", text });
      return { receipt: "queued" };
    }
    let last: NudgeReceipt = { receipt: "dropped" };
    for (const seat of live) {
      last = seat.handle.nudge(text);
      this.append(ref, {
        type: "nudge_delivered",
        receipt: last.receipt,
        target: seat.request.seatKey,
        text,
      });
    }
    void run;
    return last;
  }

  async pause(ref: string): Promise<void> {
    const run = this.fold(ref);
    if (run.status !== "running") throw new Error(`run ${ref} is ${run.status}, not running`);
    this.append(ref, { type: "parked", reason: "operator_pause" });
    await this.abortAllSeats(ref, "operator pause");
    this.scheduler.evictRun(ref);
  }

  /**
   * Take a parked run back. The grant re-arms it: extra visits for
   * cap-exhaustion parks, extra budget for budget parks, a verdict for
   * human gates.
   */
  async resume(ref: string, grant?: ResumeGrant): Promise<void> {
    const run = this.fold(ref);
    if (run.status !== "parked" || !run.parked) {
      throw new Error(`run ${ref} is ${run.status}, not parked`);
    }
    const parked = run.parked;
    const gateCursor = run.cursors.find((c) => c.phase === "gate_waiting");
    if (parked.reason === "human_gate" && !grant?.gate) {
      throw new Error(
        `run ${ref} is parked at human gate "${parked.node}"; resume requires grant.gate with a verdict`,
      );
    }
    this.append(ref, { type: "resumed", ...(grant ? { grant } : {}) });
    if (grant?.gate) {
      const gateNode = this.nodeOf(run, grant.gate.node);
      if (gateNode.kind !== "gate") throw new Error(`node "${grant.gate.node}" is not a gate`);
      const visit = gateCursor?.visit ?? run.visits[grant.gate.node] ?? 1;
      await this.decideGate(ref, grant.gate.node, visit, "human", grant.gate.verdict, grant.gate.note);
      return;
    }
    if (parked.pendingEdge && parked.node) {
      // A cap-exhaustion park: re-attempt the pending edge under the grant.
      await this.attemptEnter(ref, parked.pendingEdge.to, parked.pendingEdge.arm);
      return;
    }
    await this.reconcile(ref);
  }

  /** Reap live seats during SIGINT/SIGTERM without leaving child groups behind. */
  async shutdown(reason = "tracker_shutdown"): Promise<void> {
    for (const ref of new Set([...this.seats.values()].map((seat) => seat.ref))) {
      await this.abortAllSeats(ref, reason);
      this.scheduler.evictRun(ref);
    }
  }

  async cancel(ref: string, reason?: string): Promise<void> {
    const run = this.fold(ref);
    if (run.status === "done" || run.status === "cancelled") {
      throw new Error(`run ${ref} is already ${run.status}`);
    }
    await this.abortAllSeats(ref, reason ?? "cancelled");
    this.scheduler.evictRun(ref);
    const folded = this.fold(ref);
    this.append(ref, {
      type: "run_cancelled",
      ...(reason !== undefined ? { reason } : {}),
      totals: this.totals(folded),
    });
    this.cleanupTerminalWorktrees(ref);
  }

  /** Human verdict on a gate without the resume ceremony (concierge sugar). */
  async decideHumanGate(
    ref: string,
    node: NodeId,
    verdict: "pass" | "fail",
    note?: string,
  ): Promise<void> {
    await this.resume(ref, { gate: { node, verdict, ...(note !== undefined ? { note } : {}) } });
  }

  // ── worker event intake (contract 3 → the ONLY workflow-advancing input) ─

  async deliverWorkerEvent(ref: string, seatKey: SeatKey, ev: WorkerEvent): Promise<void> {
    const run = this.fold(ref);
    const seatState = run.seats[seatKey];
    // Events for seats that already resolved (aborted, refused, finished)
    // are late deliveries from a killed process — drop them.
    if (!seatState || ["finished", "aborted", "refused"].includes(seatState.phase)) return;
    const live = this.liveSeat(ref, seatKey);
    this.sentinel.onWorkerEvent(ref, seatKey, ev, this.nowMs());

    switch (ev.kind) {
      case "session_started":
        return;
      case "worker_ready": {
        if (!live) return;
        const verdict = verifyReadiness(live.request.manifest, ev);
        if (verdict.ok) {
          this.append(ref, {
            type: "worker_ready",
            seatKey,
            manifestHash: ev.manifestHash,
            observedBranch: ev.observedBranch,
            observedSha: ev.observedSha,
          });
          return;
        }
        // The engine-side of the handshake failed: the worker is somewhere
        // it shouldn't be. Refuse the seat, kill it, run the retry ladder.
        this.append(ref, {
          type: "worker_refused",
          seatKey,
          expected: {
            branch: live.request.branch,
            baseSha: live.request.baseSha,
            manifestHash: live.request.manifest.manifestHash,
          },
          observed: {
            branch: ev.observedBranch,
            sha: ev.observedSha,
            manifestHash: ev.manifestHash,
            reason: `handshake mismatch: ${verdict.mismatch}`,
          },
        });
        await this.handleRefusal(ref, seatKey, "readiness handshake mismatch");
        return;
      }
      case "worker_refused": {
        if (!live) return;
        this.append(ref, {
          type: "worker_refused",
          seatKey,
          expected: {
            branch: live.request.branch,
            baseSha: live.request.baseSha,
            manifestHash: live.request.manifest.manifestHash,
          },
          observed: ev.observed,
        });
        await this.handleRefusal(ref, seatKey, ev.observed.reason ?? "worker declined to start");
        return;
      }
      case "turn_completed":
      case "file_change":
      case "stalled":
        return; // in-memory lease state; the Sentinel's sweep rolls it up
      case "error":
        this.append(ref, {
          type: "error_recorded",
          code: ev.code,
          message: ev.message,
          seatKey,
          operation: "worker_adapter",
        });
        return;
      case "timeout":
        this.append(ref, {
          type: "seat_timeout",
          seatKey,
          timeoutMs: ev.timeoutMs,
          reason: ev.reason,
        });
        await this.failSeat(ref, seatKey, "synthesized_wall_clock_cap", ev.reason);
        return;
      case "checkpoint": {
        this.append(ref, { type: "checkpoint_committed", seatKey, sha: ev.sha });
        return;
      }
      case "finished": {
        await this.finishSeat(ref, seatKey, ev);
        return;
      }
    }
  }

  /**
   * A refused seat (handshake mismatch, or the worker's own environment
   * check failing) is an infra failure: kill the process and run the
   * same-visit retry ladder. The worker_refused event, already appended,
   * is the durable record — no done-signal is synthesized for a worker
   * that never started.
   */
  private async handleRefusal(ref: string, seatKey: SeatKey, reason: string): Promise<void> {
    const live = this.liveSeat(ref, seatKey);
    if (live) {
      try {
        const sha = await live.handle.abort(reason);
        this.append(ref, {
          type: "seat_aborted",
          seatKey,
          reason,
          ...(sha ? { checkpointSha: sha } : {}),
        });
        if (sha) this.append(ref, {
          type: "checkpoint_committed",
          seatKey,
          sha,
          note: `WIP committed on refusal: ${reason}`,
        });
      } catch (err) {
        this.append(ref, {
          type: "error_recorded",
          code: "REFUSAL_ABORT_FAILED",
          message: err instanceof Error ? err.message : String(err),
          seatKey,
          operation: "refusal_abort",
        });
        this.append(ref, { type: "seat_aborted", seatKey, reason });
      }
    }
    this.releaseSeat(ref, seatKey);
    const run = this.fold(ref);
    const seat = run.seats[seatKey];
    if (!seat || this.suppressAdvance.has(ref) || run.status !== "running") return;
    await this.routeSignal(
      ref,
      seat.node,
      seat.visit,
      seat.arm,
      {
        status: "blocked",
        summary: `seat refused: ${reason}`,
        filesChanged: [],
        checksRun: null,
        blockedReason: reason,
      },
      "synthesized_process_exit",
    );
  }

  private async finishSeat(
    ref: string,
    seatKey: SeatKey,
    ev: Extract<WorkerEvent, { kind: "finished" }>,
  ): Promise<void> {
    const live = this.liveSeat(ref, seatKey);
    const run = this.fold(ref);
    const seatState = run.seats[seatKey];
    if (!seatState) return;
    const telemetry = live?.handle.telemetry();
    this.releaseSeat(ref, seatKey);

    let signal: DoneSignal;
    let subtype: SignalSubtype;
    if (ev.signal) {
      signal = ev.signal;
      subtype = "done_signal";
    } else {
      if (ev.error) {
        this.append(ref, {
          type: "error_recorded",
          code: "WORKER_EXIT_WITHOUT_SIGNAL",
          message: ev.error,
          seatKey,
          operation: "worker_exit",
        });
      }
      // Worker process died without a done-signal (§1.6): raise the alarm
      // and synthesize the finished event with the stderr tail.
      this.append(ref, {
        type: "alarm_raised",
        alarm: {
          type: "silent_exit",
          seatKey,
          node: seatState.node,
          evidence: ev.error ?? "process exited without a done-signal",
        },
      });
      signal = {
        status: "blocked",
        summary: `process exited without a done-signal: ${ev.error ?? "unknown"}`,
        filesChanged: [],
        checksRun: null,
        blockedReason: ev.error ?? "process_exit",
      };
      subtype = "synthesized_process_exit";
    }

    if (telemetry) {
      this.store.recordSpend({
        ref,
        seatKey,
        at: this.now(),
        usd: ev.spendUsd ?? 0,
        tokens: telemetry.tokens.input + telemetry.tokens.output,
        turns: telemetry.turns,
        wallClockS: telemetry.wallClockS,
        outcome: signal.status,
      });
    }

    this.append(ref, {
      type: "signal_received",
      seatKey,
      node: seatState.node,
      visit: seatState.visit,
      ...(seatState.arm != null ? { arm: seatState.arm } : {}),
      signal,
      subtype,
      ...(ev.spendUsd != null ? { spendUsd: ev.spendUsd } : {}),
    });

    if (this.suppressAdvance.has(ref)) return;
    const after = this.fold(ref);
    if (after.status !== "running") return;
    await this.routeSignal(ref, seatState.node, seatState.visit, seatState.arm, signal, subtype);
  }

  // ── the interpreter: nodes, edges, gates, joins ─────────────────────────

  private async enterNode(ref: string, node: NodeId, arm?: number): Promise<void> {
    const run = this.fold(ref);
    const def = this.nodeOf(run, node);
    const visit = (run.visits[node] ?? 0) + 1;
    this.append(ref, {
      type: "node_entered",
      node,
      visit,
      ...(arm != null ? { arm } : {}),
    });
    switch (def.kind) {
      case "worker":
        await this.requestSeat(ref, node, visit, undefined, 1);
        break;
      case "gate":
        if (def.by === "human") {
          // Human gates enter PARKED directly — no seat, no lease; the
          // Herald pings the origin channel and the run waits (§5.2).
          this.append(ref, {
            type: "parked",
            reason: "human_gate",
            node,
            detail: "awaiting a human verdict",
          });
          break;
        }
        await this.requestSeat(ref, node, visit, undefined, 1);
        break;
      case "fanout": {
        for (let arm = 0; arm < def.arms.length; arm++) {
          await this.requestSeat(ref, node, visit, arm, 1);
          const now = this.fold(ref);
          if (now.status !== "running") break; // budget park mid-fanout
        }
        break;
      }
      case "join":
        // Joins are entered only through their fanout's barrier logic
        // (checkJoin → enterJoinNode); the linter refuses direct edges.
        throw new Error(`join "${node}" cannot be entered directly`);
    }
  }

  /** Enter `target` if its re-entry cap (plus grants) allows; else park. */
  private async attemptEnter(
    ref: string,
    target: NodeId | "done" | "park",
    arm?: number,
    parkReason?: ParkReason,
    parkDetail?: string,
  ): Promise<void> {
    if (target === EDGE_DONE) {
      const run = this.fold(ref);
      this.append(ref, { type: "run_done", outcome: "success", totals: this.totals(run) });
      this.scheduler.evictRun(ref);
      this.cleanupTerminalWorktrees(ref);
      return;
    }
    if (target === EDGE_PARK) {
      this.append(ref, {
        type: "parked",
        reason: parkReason ?? "onfail_park",
        ...(parkDetail !== undefined ? { detail: parkDetail } : {}),
      });
      return;
    }
    const run = this.fold(ref);
    const def = this.nodeOf(run, target);
    const nextVisit = (run.visits[target] ?? 0) + 1;
    const cap = effectiveMaxVisits(run, target, maxVisitsOf(def));
    if (nextVisit > cap) {
      this.append(ref, {
        type: "parked",
        reason: "max_visits_exhausted",
        node: target,
        pendingEdge: { to: target, ...(arm != null ? { arm } : {}) },
        detail: `visit ${nextVisit} would exceed maxVisits=${cap}`,
      });
      return;
    }
    await this.enterNode(ref, target, arm);
  }

  private async takeEdge(
    ref: string,
    from: NodeId,
    why: EdgeWhy,
    to: NodeId | "done" | "park",
    opts: { arm?: number; parkReason?: ParkReason; parkDetail?: string } = {},
  ): Promise<void> {
    this.append(ref, {
      type: "edge_taken",
      from,
      to,
      why,
      ...(opts.arm != null ? { arm: opts.arm } : {}),
    });
    await this.attemptEnter(ref, to, opts.arm, opts.parkReason, opts.parkDetail);
  }

  private async routeSignal(
    ref: string,
    node: NodeId,
    visit: number,
    arm: number | undefined,
    signal: DoneSignal,
    subtype: SignalSubtype,
  ): Promise<void> {
    const run = this.fold(ref);
    const def = this.nodeOf(run, node);
    const infra = subtype !== "done_signal";

    if (def.kind === "fanout" && arm != null) {
      await this.routeArmSignal(ref, def, node, visit, arm, signal, infra);
      return;
    }

    if (def.kind === "gate") {
      if (def.by === "human") return; // human gates have no seats
      if (infra) {
        const retried = await this.tryRetry(ref, node, visit, undefined, def);
        if (!retried) {
          this.append(ref, {
            type: "parked",
            reason: "retries_exhausted",
            node,
            detail: `gate check kept failing to run: ${signal.summary}`,
          });
        }
        return;
      }
      const pass = (signal.data?.["pass"] as boolean | undefined) ?? signal.status === "complete";
      const score = signal.data?.["rubricScore"] as number | undefined;
      await this.decideGate(ref, node, visit, "model", pass ? "pass" : "fail", signal.summary, score);
      return;
    }

    if (def.kind === "join") {
      await this.resolveJudgeSignal(ref, def, node, signal, infra);
      return;
    }

    if (def.kind !== "worker") {
      throw new Error(`signal for ${def.kind} node "${node}" arrived without an arm`);
    }
    if (infra) {
      const retried = await this.tryRetry(ref, node, visit, undefined, def);
      if (retried) return;
      await this.takeEdge(ref, node, "fail", def.onFail, {
        parkReason: "retries_exhausted",
        parkDetail: `same-visit retries exhausted at ${node}: ${signal.summary}`,
      });
      return;
    }
    if (signal.status === "complete") {
      await this.takeEdge(ref, node, "pass", def.onPass);
    } else {
      await this.takeEdge(ref, node, "fail", def.onFail, {
        parkDetail: `${signal.status}: ${signal.blockedReason ?? signal.summary}`,
      });
    }
  }

  private async decideGate(
    ref: string,
    node: NodeId,
    visit: number,
    by: "human" | "model",
    verdict: "pass" | "fail",
    note?: string,
    rubricScore?: number,
  ): Promise<void> {
    const run = this.fold(ref);
    const def = this.nodeOf(run, node) as GateNode;
    this.append(ref, {
      type: "gate_decided",
      node,
      visit,
      by,
      verdict,
      ...(note !== undefined ? { note } : {}),
      ...(rubricScore !== undefined ? { rubricScore } : {}),
    });
    await this.takeGateEdge(ref, node, def, verdict);
  }

  /**
   * The edge a decided gate takes — separated from the deciding so crash
   * recovery can re-take a lost edge without double-counting the verdict.
   */
  private async takeGateEdge(
    ref: string,
    node: NodeId,
    def: GateNode,
    verdict: "pass" | "fail",
  ): Promise<void> {
    if (verdict === "pass") {
      await this.takeEdge(ref, node, "pass", def.onPass);
      return;
    }
    const after = this.fold(ref);
    const fails = after.gateFails[node] ?? 0;
    if (fails > maxFailsOf(def)) {
      this.append(ref, {
        type: "parked",
        reason: "gate_fails_exhausted",
        node,
        detail: `gate bounced ${fails} times (maxFails=${maxFailsOf(def)})`,
      });
      return;
    }
    await this.takeEdge(ref, node, "fail", def.onFail);
  }

  // ── fanout / join (§5.4) ────────────────────────────────────────────────

  private async routeArmSignal(
    ref: string,
    fanout: FanoutNode,
    node: NodeId,
    visit: number,
    arm: number,
    signal: DoneSignal,
    infra: boolean,
  ): Promise<void> {
    const run = this.fold(ref);
    if (infra) {
      // The silent arm (§5.4): the crash synthesizes a finished, the retry
      // ladder runs, and if retries exhaust the arm enters the join as
      // failed — a join can wait, but never quietly.
      const retried = await this.tryRetry(ref, node, visit, arm, fanout);
      if (retried) return;
    }
    const seat = Object.values(run.seats).find(
      (s) => s.node === node && s.visit === visit && s.arm === arm,
    );
    const failed = infra || signal.status !== "complete";
    // Replay guard: if this arm already reached the barrier (crash between
    // arm_joined and the join decision), don't append a duplicate.
    if (!run.joins[fanout.join]?.arms[arm]) {
      this.append(ref, {
        type: "arm_joined",
        join: fanout.join,
        fanout: node,
        arm,
        branch: seat?.branch ?? "",
        status: failed ? "failed" : "complete",
        summary: signal.summary,
      });
    }
    await this.checkJoin(ref, fanout, node, visit);
  }

  /**
   * Evaluate the join barrier after every arm arrival. Aborted siblings
   * (fail-fast, first-wins, quorum-met) enter the join as failed arms with
   * an explanatory summary.
   */
  private async checkJoin(ref: string, fanout: FanoutNode, fanoutId: NodeId, visit: number): Promise<void> {
    const run = this.fold(ref);
    if (run.status !== "running") return;
    const joinState = run.joins[fanout.join];
    if (!joinState || joinState.resolved) return;
    const joinDef = this.nodeOf(run, fanout.join) as JoinNode;
    const total = joinState.expectedArms;
    const arms = joinState.arms;
    const arrived = Object.keys(arms).length;
    const completeArms = Object.entries(arms)
      .filter(([, a]) => a.status === "complete")
      .map(([i]) => Number(i));
    const failedArms = Object.entries(arms)
      .filter(([, a]) => a.status === "failed")
      .map(([i]) => Number(i));
    const strategy = joinDef.strategy;

    const abortStragglers = async (why: string) => {
      // Arms queued but never spawned stand down first (they hold no seat).
      for (const dropped of this.scheduler.dropQueued(ref, fanoutId, visit)) {
        this.append(ref, {
          type: "arm_joined",
          join: fanout.join,
          fanout: fanoutId,
          arm: dropped.arm!,
          branch: "",
          status: "failed",
          summary: `never staffed: ${why}`,
        });
      }
      const stillLive = this.liveSeatsOf(ref).filter(
        (s) => s.request.node === fanoutId && s.request.visit === visit,
      );
      for (const seat of stillLive) {
        await this.abortSeat(ref, seat.request.seatKey, why);
        this.append(ref, {
          type: "arm_joined",
          join: fanout.join,
          fanout: fanoutId,
          arm: seat.request.arm!,
          branch: seat.request.branch,
          status: "failed",
          summary: `aborted: ${why}`,
        });
      }
    };

    if (strategy === "all-merge") {
      if (failedArms.length > 0) {
        // fail fast (§5.4)
        await this.abortStragglersAndResolve(ref, fanout, fanoutId, visit, joinDef, {
          outcome: "fail",
          reason: `arm ${failedArms[0]} failed: ${arms[failedArms[0]!]?.summary ?? ""}`,
          parkReason: "join_failed",
        });
        return;
      }
      if (arrived < total) return; // barrier holds
      await this.enterJoinNode(ref, fanout.join);
      // Merge every arm's branch into the task branch in arm order; each
      // merge is its own recorded event. Conflict → the half-merged join.
      const order = Object.keys(arms).map(Number).sort((a, b) => a - b);
      const merged: number[] = [];
      for (const armIdx of order) {
        const branch = arms[armIdx]!.branch;
        const outcome = this.merger.mergeArm(ref, branch);
        if (outcome.ok) {
          this.append(ref, {
            type: "checkpoint_committed",
            sha: outcome.sha,
            note: `merged arm ${armIdx} (${branch})`,
          });
          merged.push(armIdx);
        } else {
          this.append(ref, {
            type: "join_resolved",
            join: fanout.join,
            strategy: "all-merge",
            outcome: "fail",
            mergeOrder: merged,
            reason: `conflict merging arm ${armIdx} (${branch}): ${outcome.conflict}`,
          });
          // The task branch stays at the last clean merge; the conflicting
          // arm is named in the park reason. Nothing is force-pushed (§5.4).
          await this.takeEdge(ref, fanout.join, "fail", joinDef.onFail, {
            parkReason: "join_conflict",
            parkDetail: `arm ${armIdx} (${branch}) conflicts: ${outcome.conflict}`,
          });
          return;
        }
      }
      this.append(ref, {
        type: "join_resolved",
        join: fanout.join,
        strategy: "all-merge",
        outcome: "pass",
        mergeOrder: merged,
      });
      await this.takeEdge(ref, fanout.join, "pass", joinDef.onPass);
      return;
    }

    if (strategy === "first") {
      if (completeArms.length >= 1) {
        const winner = completeArms[0]!;
        await abortStragglers(`arm ${winner} finished first`);
        await this.enterJoinNode(ref, fanout.join);
        const outcome = this.merger.mergeArm(ref, arms[winner]!.branch);
        if (!outcome.ok) {
          this.append(ref, {
            type: "join_resolved",
            join: fanout.join,
            strategy: "first",
            outcome: "fail",
            winner,
            reason: `winner arm ${winner} failed to merge: ${outcome.conflict}`,
          });
          await this.takeEdge(ref, fanout.join, "fail", joinDef.onFail, {
            parkReason: "join_conflict",
            parkDetail: `winner arm ${winner} conflicts: ${outcome.conflict}`,
          });
          return;
        }
        this.append(ref, {
          type: "checkpoint_committed",
          sha: outcome.sha,
          note: `merged winning arm ${winner}`,
        });
        this.append(ref, {
          type: "join_resolved",
          join: fanout.join,
          strategy: "first",
          outcome: "pass",
          winner,
        });
        await this.takeEdge(ref, fanout.join, "pass", joinDef.onPass);
        return;
      }
      if (arrived >= total) {
        // every arm failed
        await this.enterJoinNode(ref, fanout.join);
        this.append(ref, {
          type: "join_resolved",
          join: fanout.join,
          strategy: "first",
          outcome: "fail",
          reason: "all arms failed",
        });
        await this.takeEdge(ref, fanout.join, "fail", joinDef.onFail, {
          parkReason: "join_failed",
          parkDetail: "all arms failed",
        });
      }
      return;
    }

    if (strategy === "quorum") {
      const k = joinDef.quorumK!;
      const votes = Object.entries(arms).map(([i, a]) => ({
        arm: Number(i),
        verdict: (a.status === "complete" ? "pass" : "fail") as "pass" | "fail",
      }));
      if (completeArms.length >= k) {
        await abortStragglers(`quorum of ${k} reached`);
        await this.enterJoinNode(ref, fanout.join);
        this.append(ref, {
          type: "join_resolved",
          join: fanout.join,
          strategy: "quorum",
          outcome: "pass",
          votes,
        });
        await this.takeEdge(ref, fanout.join, "pass", joinDef.onPass);
        return;
      }
      if (failedArms.length > total - k) {
        await abortStragglers(`quorum of ${k} impossible`);
        await this.enterJoinNode(ref, fanout.join);
        this.append(ref, {
          type: "join_resolved",
          join: fanout.join,
          strategy: "quorum",
          outcome: "fail",
          votes,
          reason: `${failedArms.length} of ${total} arms failed; quorum ${k} impossible`,
        });
        await this.takeEdge(ref, fanout.join, "fail", joinDef.onFail, {
          parkReason: "join_failed",
          parkDetail: `quorum ${k} impossible`,
        });
      }
      return;
    }

    // judge strategy: the barrier is every arm terminal; then a cast seat
    // reads all arms' diffs and picks or synthesises.
    if (arrived >= total) {
      await this.enterJoinNode(ref, fanout.join);
      const joinVisit = this.fold(ref).visits[fanout.join] ?? 1;
      await this.requestSeat(ref, fanout.join, joinVisit, undefined, 1);
    }
  }

  private async abortStragglersAndResolve(
    ref: string,
    fanout: FanoutNode,
    fanoutId: NodeId,
    visit: number,
    joinDef: JoinNode,
    res: { outcome: "fail"; reason: string; parkReason: ParkReason },
  ): Promise<void> {
    for (const dropped of this.scheduler.dropQueued(ref, fanoutId, visit)) {
      this.append(ref, {
        type: "arm_joined",
        join: fanout.join,
        fanout: fanoutId,
        arm: dropped.arm!,
        branch: "",
        status: "failed",
        summary: `never staffed: ${res.reason}`,
      });
    }
    const stillLive = this.liveSeatsOf(ref).filter(
      (s) => s.request.node === fanoutId && s.request.visit === visit,
    );
    for (const seat of stillLive) {
      await this.abortSeat(ref, seat.request.seatKey, res.reason);
      this.append(ref, {
        type: "arm_joined",
        join: fanout.join,
        fanout: fanoutId,
        arm: seat.request.arm!,
        branch: seat.request.branch,
        status: "failed",
        summary: `aborted: ${res.reason}`,
      });
    }
    await this.enterJoinNode(ref, fanout.join);
    this.append(ref, {
      type: "join_resolved",
      join: fanout.join,
      strategy: typeof joinDef.strategy === "string" ? joinDef.strategy : "judge",
      outcome: res.outcome,
      reason: res.reason,
    });
    await this.takeEdge(ref, fanout.join, "fail", joinDef.onFail, {
      parkReason: res.parkReason,
      parkDetail: res.reason,
    });
  }

  private async enterJoinNode(ref: string, join: NodeId): Promise<void> {
    const run = this.fold(ref);
    // Replay guard: entering a join is idempotent per barrier resolution.
    if (run.cursors.some((c) => c.node === join)) return;
    const visit = (run.visits[join] ?? 0) + 1;
    this.append(ref, { type: "node_entered", node: join, visit });
  }

  private async resolveJudgeSignal(
    ref: string,
    joinDef: JoinNode,
    join: NodeId,
    signal: DoneSignal,
    infra: boolean,
  ): Promise<void> {
    const run = this.fold(ref);
    const joinState = run.joins[join];
    const visit = run.visits[join] ?? 1;
    if (infra) {
      const retried = await this.tryRetry(ref, join, visit, undefined, joinDef);
      if (retried) return;
      this.append(ref, {
        type: "join_resolved",
        join,
        strategy: "judge",
        outcome: "fail",
        reason: `judge seat kept failing: ${signal.summary}`,
      });
      await this.takeEdge(ref, join, "fail", joinDef.onFail, {
        parkReason: "join_failed",
        parkDetail: "judge seat kept failing",
      });
      return;
    }
    const winner = signal.data?.["winner"] as number | undefined;
    const wantsSynthesis = signal.data?.["synthesis"] === true;
    if (signal.status === "complete" && winner != null && joinState?.arms[winner]) {
      const outcome = this.merger.mergeArm(ref, joinState.arms[winner]!.branch);
      if (!outcome.ok) {
        this.append(ref, {
          type: "join_resolved",
          join,
          strategy: "judge",
          outcome: "fail",
          winner,
          reason: `winning arm ${winner} failed to merge: ${outcome.conflict}`,
        });
        await this.takeEdge(ref, join, "fail", joinDef.onFail, {
          parkReason: "join_conflict",
          parkDetail: `winning arm ${winner} conflicts: ${outcome.conflict}`,
        });
        return;
      }
      this.append(ref, {
        type: "checkpoint_committed",
        sha: outcome.sha,
        note: `merged judged winner arm ${winner}`,
      });
      this.append(ref, {
        type: "join_resolved",
        join,
        strategy: "judge",
        outcome: "pass",
        winner,
      });
      await this.takeEdge(ref, join, "pass", joinDef.onPass);
      return;
    }
    this.append(ref, {
      type: "join_resolved",
      join,
      strategy: "judge",
      outcome: "fail",
      reason: wantsSynthesis
        ? `judge requested a synthesis pass: ${signal.summary}`
        : `judge named no winner: ${signal.summary}`,
    });
    await this.takeEdge(ref, join, "fail", joinDef.onFail, {
      parkReason: "join_failed",
      parkDetail: signal.summary,
    });
  }

  // ── seats: budgets, spawn, retry ladder, aborts (§4.3 steps 4–5) ────────

  /** Same-visit infra retry. Returns false when the ladder is exhausted. */
  private async tryRetry(
    ref: string,
    node: NodeId,
    visit: number,
    arm: number | undefined,
    def: FlowNode,
  ): Promise<boolean> {
    const run = this.fold(ref);
    const cursor = run.cursors.find(
      (c) => c.node === node && (arm == null ? c.arm == null : c.arm === arm),
    );
    const used = cursor?.retriesUsed ?? 0;
    if (used >= retriesOf(def)) return false;
    this.append(ref, {
      type: "edge_taken",
      from: node,
      to: node,
      why: "retry",
      ...(arm != null ? { arm } : {}),
    });
    const attempt = this.maxAttempt(ref, node, visit, arm) + 1;
    await this.requestSeat(ref, node, visit, arm, attempt);
    return true;
  }

  private maxAttempt(ref: string, node: NodeId, visit: number, arm?: number): number {
    const run = this.fold(ref);
    const seat = run.seats[seatKeyOf(node, visit, arm)];
    return seat?.attempt ?? 0;
  }

  /** §4.3 step 4 (budget gate) + step 5 (act). */
  private async requestSeat(
    ref: string,
    node: NodeId,
    visit: number,
    arm: number | undefined,
    attempt: number,
  ): Promise<void> {
    const run = this.fold(ref);
    // GATE: every intended spawn checks budgets *before* a seat is
    // requested — a refusal becomes budget_hit + park, not a queued surprise.
    const budget = run.spec.budget;
    if (budget?.usd != null) {
      const limit = budget.usd + run.grants.extraUsd;
      if (run.spend.usd >= limit) {
        this.append(ref, {
          type: "alarm_raised",
          alarm: {
            type: "budget",
            node,
            evidence: `spend $${run.spend.usd.toFixed(2)} ≥ cap $${limit.toFixed(2)}`,
          },
        });
        this.append(ref, { type: "budget_hit", ceiling: "usd", limit, spent: run.spend.usd });
        this.append(ref, {
          type: "parked",
          reason: "budget_usd",
          node,
          detail: `spend cap $${limit.toFixed(2)} reached before staffing ${node}`,
        });
        this.scheduler.evictRun(ref);
        return;
      }
    }
    if (budget?.wallClockS != null) {
      const limit = budget.wallClockS + run.grants.extraWallClockS;
      const elapsed = (this.nowMs() - Date.parse(run.openedAt)) / 1000;
      if (elapsed >= limit) {
        this.append(ref, {
          type: "alarm_raised",
          alarm: {
            type: "budget",
            node,
            evidence: `run wall-clock ${Math.round(elapsed)}s ≥ cap ${limit}s`,
          },
        });
        this.append(ref, { type: "budget_hit", ceiling: "wall_clock", limit, spent: elapsed });
        this.append(ref, {
          type: "parked",
          reason: "budget_wall_clock",
          node,
          detail: `wall-clock cap ${limit}s reached before staffing ${node}`,
        });
        this.scheduler.evictRun(ref);
        return;
      }
    }

    const intent: SeatIntent = {
      ref,
      node,
      visit,
      ...(arm != null ? { arm } : {}),
      attempt,
      ...(budget?.maxConcurrent != null ? { runCap: budget.maxConcurrent } : {}),
    };
    const admitted = this.scheduler.request(intent);
    if (admitted === "admitted") {
      await this.spawnSeat(intent);
    }
    // "queued" waits for a release; "dedup" is a replay and a no-op.
  }

  private castFor(def: FlowNode, arm?: number): HarnessSpec {
    switch (def.kind) {
      case "worker":
        return def.cast;
      case "gate":
        if (def.by === "human") throw new Error("human gates have no cast");
        return def.by.cast;
      case "fanout":
        return def.arms[arm ?? 0]!.cast;
      case "join":
        if (typeof def.strategy !== "object") throw new Error("only judge joins have a cast");
        return def.strategy.judge;
    }
  }

  private async spawnSeat(intent: SeatIntent): Promise<void> {
    const { ref, node, visit, arm, attempt } = intent;
    const run = this.fold(ref);
    const def = this.nodeOf(run, node);
    const cast = this.castFor(def, arm);
    const seatKey = seatKeyOf(node, visit, arm);
    const isolation = def.kind === "fanout" ? def.isolation : undefined;
    const place = this.spawner.provision({
      ref,
      node,
      visit,
      ...(arm != null ? { arm } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
    });

    const envelope = envelopeFor(cast);
    const supervise = resolveSupervise(run.spec);
    const budget = run.spec.budget;
    const elapsedS = (this.nowMs() - Date.parse(run.openedAt)) / 1000;
    const manifest: StageManifest = buildManifest({
      taskRef: ref,
      seatKey,
      node,
      nodeKind: def.kind,
      visit,
      ...(arm != null ? { arm } : {}),
      attempt,
      worktree: place.worktree,
      branch: place.branch,
      baseSha: place.baseSha,
      flow: {
        entry: run.spec.entry,
        position: node,
        ...("onPass" in def ? { onPass: def.onPass } : {}),
        ...("onFail" in def ? { onFail: def.onFail } : {}),
      },
      budget: {
        ...(budget?.usd != null
          ? { remainingUsd: budget.usd + run.grants.extraUsd - run.spend.usd }
          : {}),
        ...(budget?.wallClockS != null
          ? { remainingWallClockS: budget.wallClockS + run.grants.extraWallClockS - elapsedS }
          : {}),
      },
      envelope,
      supervise,
    });

    const nodeBrief =
      def.kind === "worker"
        ? def.brief
        : def.kind === "fanout"
          ? def.arms[arm ?? 0]!.brief
          : undefined;
    const rubric = def.kind === "gate" && def.by !== "human" ? def.by.rubric : undefined;
    const priorArtifacts: ArtifactRef[] = Object.entries(run.spec.nodes)
      .filter(
        ([id, n]) =>
          n.kind === "worker" &&
          n.artifact != null &&
          id !== node &&
          (run.visits[id] ?? 0) >= 1,
      )
      .map(([id, n]) => ({ path: (n as { artifact?: string }).artifact!, fromNode: id }));

    const request: SeatRequest = {
      ref,
      node,
      visit,
      ...(arm != null ? { arm } : {}),
      attempt,
      seatKey,
      cast,
      worktree: place.worktree,
      branch: place.branch,
      baseSha: place.baseSha,
      briefParts: {
        body: run.body ?? "",
        criteria: run.criteria ?? [],
        ...(nodeBrief !== undefined ? { nodeBrief } : {}),
        ...(rubric !== undefined ? { rubric } : {}),
        priorArtifacts,
        steers: run.pendingSteers.map((s) => ({ text: s.text, at: s.at })),
      },
      manifest,
      envelope,
    };

    // APPEND before ACT: a crash between the append and the spawn re-derives
    // the same request on recovery and dedups against any seat that started.
    this.append(ref, {
      type: "seat_spawned",
      seatKey,
      node,
      visit,
      ...(arm != null ? { arm } : {}),
      attempt,
      cast,
      worktree: place.worktree,
      branch: place.branch,
      baseSha: place.baseSha,
      manifestHash: manifest.manifestHash,
    });

    let handle: WorkerHandle;
    try {
      handle = this.spawner.spawn(request);
    } catch (err) {
      this.releaseSeat(ref, seatKey);
      this.append(ref, {
        type: "error_recorded",
        code: "SPAWN_FAILED",
        message: err instanceof Error ? err.message : String(err),
        seatKey,
        operation: "spawn",
      });
      this.append(ref, {
        type: "signal_received",
        seatKey,
        node,
        visit,
        ...(arm != null ? { arm } : {}),
        signal: {
          status: "blocked",
          summary: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
          filesChanged: [],
          checksRun: null,
          blockedReason: "spawn_failure",
        },
        subtype: "synthesized_process_exit",
      });
      if (!this.suppressAdvance.has(ref)) {
        await this.routeSignal(
          ref,
          node,
          visit,
          arm,
          {
            status: "blocked",
            summary: "spawn failed",
            filesChanged: [],
            checksRun: null,
            blockedReason: "spawn_failure",
          },
          "synthesized_process_exit",
        );
      }
      return;
    }
    this.seats.set(`${ref}::${seatKey}`, { ref, request, handle });
    this.sentinel.track({
      ref,
      seatKey,
      at: this.nowMs(),
      envelopeWallClockS: envelope.wallClockS,
      supervise,
    });
  }

  /** Reap terminal isolated worktrees; the task branch remains inspectable. */
  private cleanupTerminalWorktrees(ref: string): void {
    for (const seat of Object.values(this.fold(ref).seats)) {
      try {
        this.spawner.reap?.(ref, seat.branch);
      } catch (err) {
        this.append(ref, {
          type: "error_recorded",
          code: "WORKTREE_REAP_FAILED",
          message: err instanceof Error ? err.message : String(err),
          seatKey: seat.key,
          operation: "worktree_reap",
        });
      }
    }
  }

  private releaseSeat(ref: string, seatKey: SeatKey): void {
    this.seats.delete(`${ref}::${seatKey}`);
    this.sentinel.untrack(ref, seatKey);
    const admitted = this.scheduler.release(ref, seatKey);
    for (const intent of admitted) {
      // Freed capacity staffs the FIFO head. Spawn failures surface through
      // the normal synthesized-signal path inside spawnSeat.
      void this.spawnSeat(intent);
    }
  }

  /** Abort one seat: commit WIP, kill the process, synthesize the signal. */
  private async abortSeat(ref: string, seatKey: SeatKey, reason: string): Promise<void> {
    await this.failSeat(ref, seatKey, "synthesized_abort", reason);
  }

  private async failSeat(
    ref: string,
    seatKey: SeatKey,
    subtype: SignalSubtype,
    reason: string,
  ): Promise<void> {
    const live = this.liveSeat(ref, seatKey);
    let checkpointSha: string | undefined;
    if (live) {
      try {
        checkpointSha = await live.handle.abort(reason);
        if (checkpointSha) {
          this.append(ref, {
            type: "checkpoint_committed",
            seatKey,
            sha: checkpointSha,
            note: `WIP committed on abort: ${reason}`,
          });
        }
      } catch (err) {
        // Never swallow an abort failure: the following abort receipt still
        // makes the state machine recoverable and visible to the operator.
        this.append(ref, {
          type: "error_recorded",
          code: "ABORT_WIP_OR_REAP_FAILED",
          message: err instanceof Error ? err.message : String(err),
          seatKey,
          operation: "abort",
        });
      }
    }
    this.append(ref, {
      type: "seat_aborted",
      seatKey,
      reason,
      ...(checkpointSha ? { checkpointSha } : {}),
    });
    this.releaseSeat(ref, seatKey);
    const run = this.fold(ref);
    const seatState = run.seats[seatKey];
    if (!seatState || ["finished", "aborted", "refused"].includes(seatState.phase)) return;
    this.append(ref, {
      type: "signal_received",
      seatKey,
      node: seatState.node,
      visit: seatState.visit,
      ...(seatState.arm != null ? { arm: seatState.arm } : {}),
      signal: {
        status: "blocked",
        summary: reason,
        filesChanged: [],
        checksRun: null,
        blockedReason: reason,
      },
      subtype,
    });
    if (this.suppressAdvance.has(ref)) return;
    const after = this.fold(ref);
    if (after.status !== "running") return;
    if (subtype === "synthesized_abort") return; // deliberate abort: the caller decides what happens next
    await this.routeSignal(
      ref,
      seatState.node,
      seatState.visit,
      seatState.arm,
      {
        status: "blocked",
        summary: reason,
        filesChanged: [],
        checksRun: null,
        blockedReason: reason,
      },
      subtype,
    );
  }

  private async abortAllSeats(ref: string, reason: string): Promise<void> {
    this.suppressAdvance.add(ref);
    try {
      for (const seat of this.liveSeatsOf(ref)) {
        await this.abortSeat(ref, seat.request.seatKey, reason);
      }
    } finally {
      this.suppressAdvance.delete(ref);
    }
  }

  // ── the Sentinel's escalation ladder (§6.2) ─────────────────────────────

  /**
   * Sweep every lease and act on the verdicts. Call on a cadence of ≤30s
   * (wall-clock) so the "announced within one minute" invariant holds
   * end-to-end.
   */
  async tick(): Promise<void> {
    const actions = this.sentinel.sweep(this.nowMs());
    for (const action of actions) {
      await this.onSentinelAction(action);
    }
    // Run-level wall-clock ceilings are watched here too: a run that blows
    // its budget mid-seat parks at the next enforcement point.
    for (const live of [...this.seats.values()]) {
      const run = this.fold(live.ref);
      if (run.status !== "running") continue;
      const budget = run.spec.budget;
      if (budget?.wallClockS == null) continue;
      const limit = budget.wallClockS + run.grants.extraWallClockS;
      const elapsed = (this.nowMs() - Date.parse(run.openedAt)) / 1000;
      if (elapsed >= limit) {
        this.append(live.ref, {
          type: "alarm_raised",
          alarm: {
            type: "budget",
            evidence: `run wall-clock ${Math.round(elapsed)}s ≥ cap ${limit}s`,
          },
        });
        this.append(live.ref, {
          type: "budget_hit",
          ceiling: "wall_clock",
          limit,
          spent: elapsed,
        });
        this.append(live.ref, {
          type: "parked",
          reason: "budget_wall_clock",
          detail: `wall-clock cap ${limit}s reached mid-run`,
        });
        await this.abortAllSeats(live.ref, "run wall-clock budget exhausted");
        this.scheduler.evictRun(live.ref);
      }
    }
  }

  private async onSentinelAction(action: SentinelAction): Promise<void> {
    const { ref } = action;
    const run = this.fold(ref);
    if (run.status === "done" || run.status === "cancelled") return;
    switch (action.kind) {
      case "progress_noted": {
        this.append(ref, {
          type: "progress_noted",
          seatKey: action.seatKey,
          turns: action.turns,
          filesTouched: action.filesTouched,
          tokens: action.tokens,
        });
        return;
      }
      case "status_nudge": {
        // Strike 1 — a status-check nudge, kept from today (§6.1).
        const live = this.liveSeat(ref, action.seatKey);
        if (!live) return;
        const receipt = live.handle.nudge(
          `status check: no progress events for ${Math.round(action.quietForS)}s — please emit a progress update or a done-signal`,
        );
        this.append(ref, {
          type: "nudge_delivered",
          receipt: receipt.receipt,
          target: action.seatKey,
          text: "sentinel status check",
        });
        return;
      }
      case "alarm": {
        this.append(ref, {
          type: "alarm_raised",
          alarm: {
            type: action.type,
            seatKey: action.seatKey,
            evidence: action.evidence,
          },
        });
        if (action.type === "overrun") return; // advisory: announce, never kill (§6.1)
        // stall / ready_timeout: abort the seat and run the retry ladder —
        // strike 2 generalised (§1.6 → §6.2).
        const subtype: SignalSubtype =
          action.type === "stall" ? "synthesized_stall" : "synthesized_ready_timeout";
        await this.failSeat(ref, action.seatKey, subtype, `sentinel ${action.type}: ${action.evidence}`);
        return;
      }
      case "hard_cap_kill": {
        // Every softer layer failed — the kill pages (§6.1).
        await this.failSeat(
          ref,
          action.seatKey,
          "synthesized_wall_clock_cap",
          `hard wall-clock backstop after ${Math.round(action.liveForS)}s`,
        );
        return;
      }
    }
  }

  // ── crash recovery (§5.6) ───────────────────────────────────────────────

  /**
   * On boot the engine replays each run's event log: PARKED cursors stay
   * parked; LIVE cursors re-staff from their checkpointed worktrees;
   * decisions that were appended but not acted on are re-derived — the
   * (ref, node, visit, arm) key makes replay idempotent (§4.3 step 5).
   */
  async recoverAll(): Promise<string[]> {
    const recovered: string[] = [];
    for (const slug of this.store.listRuns()) {
      const events = this.store.readEvents(slug);
      const opened = events.find((e) => e.type === "run_opened");
      if (!opened) continue;
      const ref = (opened as Extract<RunEvent, { type: "run_opened" }>).taskRef;
      await this.recover(ref);
      recovered.push(ref);
    }
    return recovered;
  }

  async recover(ref: string): Promise<void> {
    const run = this.fold(ref);
    if (run.status !== "running") return; // parked stays parked; terminal stays terminal
    await this.reconcile(ref);
  }

  /**
   * Re-derive the actions the folded state calls for. Used by crash
   * recovery and resume. Idempotent: live seats dedup, decided edges are
   * already in the log.
   */
  private async reconcile(ref: string): Promise<void> {
    const events = this.store.readEvents(ref);
    let run = this.fold(ref);
    if (run.status !== "running") return;

    // A running run with no cursors lost an event between an edge and the
    // node entry (or between run_opened and the entry node): re-derive.
    if (run.cursors.length === 0) {
      const lastEdge = [...events]
        .reverse()
        .find((e): e is Extract<RunEvent, { type: "edge_taken" }> => e.type === "edge_taken" && e.why !== "retry");
      if (lastEdge) {
        await this.attemptEnter(ref, lastEdge.to, lastEdge.arm);
      } else {
        await this.enterNode(ref, run.spec.entry);
      }
      return;
    }

    for (const cursor of [...run.cursors]) {
      run = this.fold(ref);
      if (run.status !== "running") return;
      const def = this.nodeOf(run, cursor.node);
      const stillThere = run.cursors.some(
        (c) => c.node === cursor.node && c.arm === cursor.arm && c.visit === cursor.visit,
      );
      if (!stillThere) continue;

      if (cursor.phase === "gate_waiting") {
        // A human gate that somehow lost its park (crash between events):
        // re-park so a human owns the next move.
        if (!run.parked) {
          this.append(ref, {
            type: "parked",
            reason: "human_gate",
            node: cursor.node,
            detail: "awaiting a human verdict (recovered)",
          });
        }
        continue;
      }

      const seatKey = seatKeyOf(cursor.node, cursor.visit, cursor.arm);
      const lastSignal = [...events]
        .reverse()
        .find(
          (e): e is Extract<RunEvent, { type: "signal_received" }> =>
            e.type === "signal_received" &&
            e.node === cursor.node &&
            e.visit === cursor.visit &&
            (cursor.arm == null ? e.arm == null : e.arm === cursor.arm),
        );
      const seat = run.seats[seatKey];

      if (def.kind === "join") {
        const joinState = run.joins[cursor.node];
        if (joinState?.resolved) {
          // The join concluded but the crash ate its edge: re-take it.
          await this.takeEdge(
            ref,
            cursor.node,
            joinState.resolved,
            joinState.resolved === "pass" ? def.onPass : def.onFail,
            joinState.resolved === "pass" ? {} : { parkReason: "join_failed" },
          );
          continue;
        }
        if (typeof def.strategy !== "object") {
          // A merge-strategy join caught mid-resolution: the joins scan
          // below re-runs checkJoin (merges are idempotent for git).
          continue;
        }
        // judge joins fall through to the seat logic below
      }

      if (def.kind === "gate" && def.by !== "human" && lastSignal) {
        const decided = [...events]
          .reverse()
          .find(
            (e): e is Extract<RunEvent, { type: "gate_decided" }> =>
              e.type === "gate_decided" &&
              e.node === cursor.node &&
              e.visit === cursor.visit &&
              e.seq > lastSignal.seq,
          );
        if (decided) {
          // Verdict recorded, edge lost: re-take without re-deciding, so
          // gateFails is never double-counted.
          await this.takeGateEdge(ref, cursor.node, def, decided.verdict);
          continue;
        }
      }

      if (cursor.phase === "seated" || (seat && (seat.phase === "spawning" || seat.phase === "live"))) {
        if (!this.liveSeat(ref, seatKey)) {
          // The engine died under a live worker: re-staff from the
          // checkpointed worktree, same visit, next attempt — no retry burned.
          this.append(ref, {
            type: "signal_received",
            seatKey,
            node: cursor.node,
            visit: cursor.visit,
            ...(cursor.arm != null ? { arm: cursor.arm } : {}),
            signal: {
              status: "blocked",
              summary: "engine restarted; re-staffing from checkpointed worktree",
              filesChanged: [],
              checksRun: null,
              blockedReason: "engine_restart",
            },
            subtype: "synthesized_abort",
          });
          await this.requestSeat(ref, cursor.node, cursor.visit, cursor.arm, (seat?.attempt ?? 0) + 1);
        }
        continue;
      }

      // phase "entered": either a signal arrived and the decision was lost
      // in the crash, or the seat was never spawned at all.
      if (lastSignal && seat && ["finished", "refused"].includes(seat.phase)) {
        if (lastSignal.subtype === "synthesized_abort") {
          await this.requestSeat(ref, cursor.node, cursor.visit, cursor.arm, seat.attempt + 1);
        } else {
          await this.routeSignal(
            ref,
            cursor.node,
            cursor.visit,
            cursor.arm,
            lastSignal.signal,
            lastSignal.subtype,
          );
        }
      } else if (seat && seat.phase === "aborted") {
        await this.requestSeat(ref, cursor.node, cursor.visit, cursor.arm, seat.attempt + 1);
      } else if (!seat) {
        await this.requestSeat(
          ref,
          cursor.node,
          cursor.visit,
          cursor.arm,
          this.maxAttempt(ref, cursor.node, cursor.visit, cursor.arm) + 1,
        );
      }
    }

    // Joins whose barrier was already met but whose resolution was lost.
    run = this.fold(ref);
    if (run.status !== "running") return;
    for (const joinState of Object.values(run.joins)) {
      if (joinState.resolved) continue;
      if (Object.keys(joinState.arms).length === 0) continue;
      const fanoutDef = this.nodeOf(run, joinState.fanout);
      if (fanoutDef.kind !== "fanout") continue;
      const armsLive = run.cursors.some((c) => c.node === joinState.fanout && c.arm != null && c.phase !== "awaiting_join");
      if (!armsLive) {
        await this.checkJoin(ref, fanoutDef, joinState.fanout, joinState.visit);
      }
    }
  }
}
