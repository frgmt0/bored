/**
 * The Herald — §6.3. Announcement routing: every run event is classified
 * trace / status / page and delivered to the journal, the task's origin
 * channel, or the owner's DM. Owns the "a human hears within one minute"
 * invariant (§6): announcement happens synchronously after the fsync'd
 * append, so a page never refers to state that didn't commit (§4.3 step 6)
 * and delivery latency is bounded by the append-to-announce path, not a
 * poll loop.
 *
 * Routing rules (reconstructed from §1.6's gap table, §4.4 and §6.1):
 *  - trace: the run narrating itself — journal only.
 *  - status: state changes a human following the task should see, delivered
 *    to the origin channel (run opened/done/cancelled, gates, joins,
 *    resumes, human-gate parks, alarms raised/cleared, synthesized signals).
 *  - page: abnormal events where the run stopped making progress without a
 *    human asking — owner DM (non-gate parks, budget refusals, worker
 *    refusals, hard-backstop kills).
 */
import type { FlowRun } from "../run/fold.js";
import type { RunEvent } from "../run/events.js";
import type { AnnounceSink, Announcement, Clock } from "./ports.js";
import { RunStore } from "../run/store.js";

export type HeraldClass = "trace" | "status" | "page";

export function classifyEvent(ev: RunEvent): HeraldClass {
  switch (ev.type) {
    case "run_opened":
    case "gate_decided":
    case "join_resolved":
    case "resumed":
    case "alarm_raised":
    case "alarm_cleared":
    case "run_done":
      return "status";
    case "run_cancelled":
      return "status";
    case "parked":
      return ev.reason === "human_gate" ? "status" : "page";
    case "budget_hit":
    case "worker_refused":
      return "page";
    case "signal_received":
      if (ev.subtype === "synthesized_wall_clock_cap") return "page";
      if (ev.subtype !== "done_signal" && ev.subtype !== "synthesized_abort") return "status";
      return "trace";
    default:
      return "trace";
  }
}

/** One journal line per event — the narrative, with node context (§5.5). */
export function traceLine(ev: RunEvent): string {
  switch (ev.type) {
    case "run_opened":
      return `run opened (entry=${ev.spec.entry})`;
    case "node_entered":
      return `entered ${ev.node} (visit ${ev.visit}${ev.arm != null ? `, arm ${ev.arm}` : ""})`;
    case "seat_spawned":
      return `[${ev.node}] seat ${ev.seatKey} spawned (attempt ${ev.attempt}, ${ev.cast.harness}${ev.cast.model ? `/${ev.cast.model}` : ""}, ${ev.cast.effort ?? "medium"}) on ${ev.branch} @ ${ev.baseSha.slice(0, 8)}`;
    case "worker_ready":
      return `seat ${ev.seatKey} ready (manifest ${ev.manifestHash.slice(0, 8)}, ${ev.observedBranch} @ ${ev.observedSha.slice(0, 8)})`;
    case "worker_refused":
      return `seat ${ev.seatKey} REFUSED to start: expected ${ev.expected.branch}@${ev.expected.baseSha.slice(0, 8)}, observed ${ev.observed.branch ?? "?"}@${(ev.observed.sha ?? "?").slice(0, 8)}${ev.observed.reason ? ` (${ev.observed.reason})` : ""}`;
    case "progress_noted":
      return `seat ${ev.seatKey}: ${ev.turns} turns, ${ev.filesTouched} files, ${ev.tokens} tokens`;
    case "checkpoint_committed":
      return `checkpoint ${ev.sha.slice(0, 8)}${ev.note ? ` (${ev.note})` : ""}`;
    case "seat_timeout":
      return `seat ${ev.seatKey} timed out after ${ev.timeoutMs}ms: ${ev.reason}`;
    case "seat_aborted":
      return `seat ${ev.seatKey} aborted: ${ev.reason}${ev.checkpointSha ? ` (WIP ${ev.checkpointSha.slice(0, 8)})` : ""}`;
    case "error_recorded":
      return `ERROR [${ev.code}] ${ev.operation}${ev.seatKey ? ` on ${ev.seatKey}` : ""}: ${ev.message}`;
    case "signal_received":
      return `[${ev.node}] signal: ${ev.signal.status} (${ev.subtype}) — ${ev.signal.summary}`;
    case "edge_taken":
      return `edge ${ev.from} → ${ev.to} (${ev.why}${ev.arm != null ? `, arm ${ev.arm}` : ""})`;
    case "gate_decided":
      return `gate ${ev.node}: ${ev.verdict} by ${ev.by}${ev.note ? ` — ${ev.note}` : ""}`;
    case "arm_joined":
      return `arm ${ev.arm} reached join ${ev.join}: ${ev.status} (${ev.branch})`;
    case "join_resolved":
      return `join ${ev.join} resolved ${ev.outcome} (${ev.strategy}${ev.winner != null ? `, winner arm ${ev.winner}` : ""}${ev.reason ? ` — ${ev.reason}` : ""})`;
    case "alarm_raised":
      return `ALARM ${ev.alarm.type}${ev.alarm.seatKey ? ` on ${ev.alarm.seatKey}` : ""}: ${ev.alarm.evidence}`;
    case "alarm_cleared":
      return `alarm ${ev.alarmType} cleared${ev.seatKey ? ` on ${ev.seatKey}` : ""}`;
    case "nudge_delivered":
      return `nudge ${ev.receipt}${ev.target ? ` to ${ev.target}` : ""}: ${ev.text}`;
    case "parked":
      return `PARKED (${ev.reason}${ev.node ? ` at ${ev.node}` : ""})${ev.detail ? ` — ${ev.detail}` : ""}`;
    case "resumed":
      return `resumed${ev.grant ? ` with grant ${JSON.stringify(ev.grant)}` : ""}`;
    case "budget_hit":
      return `BUDGET HIT: ${ev.ceiling} limit ${ev.limit}, spent ${ev.spent}`;
    case "run_done":
      return `run done: ${ev.outcome} ($${ev.totals.spendUsd.toFixed(2)}, ${ev.totals.seats} seats, ${Math.round(ev.totals.wallClockS)}s)`;
    case "run_cancelled":
      return `run cancelled${ev.reason ? `: ${ev.reason}` : ""} ($${ev.totals.spendUsd.toFixed(2)}, ${ev.totals.seats} seats)`;
  }
}

export interface HeraldOptions {
  /** where pages go when a run has no origin channel */
  ownerDM: string;
  /** fallback origin channel */
  defaultChannel?: string;
}

export class Herald {
  /** every announcement delivered, for the ≤60s invariant to be auditable */
  readonly delivered: Announcement[] = [];

  constructor(
    private readonly store: RunStore,
    private readonly sink: AnnounceSink,
    private readonly clock: Clock,
    private readonly opts: HeraldOptions,
  ) {}

  /**
   * Classify and deliver one appended event. Called synchronously after the
   * fsync (§4.3 step 6) — the ≤60s invariant is held by construction.
   */
  announce(ref: string, ev: RunEvent, run: FlowRun): void {
    const line = traceLine(ev);
    // The journal hears everything — it is the narrative.
    this.store.journal(ref, ev.at, line);

    const cls = classifyEvent(ev);
    if (cls === "trace") return;

    const target =
      cls === "page"
        ? this.opts.ownerDM
        : (run.originChannel ?? this.opts.defaultChannel ?? this.opts.ownerDM);
    const announcement: Announcement = {
      severity: cls,
      target,
      ref,
      eventType: ev.type,
      eventSeq: ev.seq,
      eventAt: ev.at,
      deliveredAt: this.clock.now().toISOString(),
      text: `[${ref}] ${line}`,
    };
    this.delivered.push(announcement);
    this.sink.deliver(announcement);
  }
}
