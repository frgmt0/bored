/**
 * The run-event vocabulary — §4.4. Closed, like the node algebra: every
 * durable fact about a run is one of these twenty events. The fold (§5.1),
 * the Herald's routing (§6.3), `status`, and the simulated deployments in §7
 * all read from this single vocabulary — there is no second, informal channel.
 */
import type { FlowSpec, HarnessSpec, NodeId } from "../spec/types.js";

/** Identity of a seat: (run, node, visit, arm) — also the dedup key (§4.3). */
export type SeatKey = string;

export function seatKeyOf(node: NodeId, visit: number, arm?: number | null): SeatKey {
  return arm == null ? `${node}#v${visit}` : `${node}#v${visit}#a${arm}`;
}

/**
 * The done-signal — the single edge the state machine branches on (§1.4).
 * `data` carries harness-native structured output for verdict-shaped seats:
 * gates set {pass}, judges set {winner} or {synthesis: true}.
 */
export interface DoneSignal {
  status: "complete" | "blocked" | "partial";
  summary: string;
  filesChanged: string[];
  checksRun: string[] | null;
  blockedReason: string | null;
  data?: Record<string, unknown>;
}

export type SignalSubtype =
  | "done_signal" // the worker really emitted it
  | "synthesized_process_exit" // worker died without a signal (§1.6)
  | "synthesized_wall_clock_cap" // hard backstop kill
  | "synthesized_stall" // stall-ladder abort
  | "synthesized_ready_timeout" // never completed the §6.4 handshake
  | "synthesized_abort"; // operator/engine abort (pause, cancel, first-join)

export type AlarmType = "stall" | "overrun" | "ready_timeout" | "silent_exit" | "budget" | "timeout";

export interface Alarm {
  type: AlarmType;
  seatKey?: SeatKey;
  node?: NodeId;
  evidence: string;
}

export type EdgeWhy = "pass" | "fail" | "retry";

export interface RunTotals {
  spendUsd: number;
  seats: number;
  wallClockS: number;
}

export type ParkReason =
  | "human_gate" // a human gate was entered; the run waits for a verdict
  | "max_visits_exhausted"
  | "gate_fails_exhausted"
  | "retries_exhausted"
  | "onfail_park" // a fail edge whose target is "park"
  | "join_conflict" // the half-merged join (§5.4)
  | "join_failed"
  | "budget_usd"
  | "budget_wall_clock"
  | "operator_pause";

/** Payloads, keyed by event type. Envelope fields (seq, at) are added on append. */
export interface RunEventPayloads {
  /** spec validated, run created */
  run_opened: {
    taskRef: string;
    spec: FlowSpec;
    originChannel?: string;
    /** ticket body + acceptance criteria — the raw material of every brief */
    body?: string;
    criteria?: string[];
  };
  /** a cursor arrives at a node (visit N) */
  node_entered: { node: NodeId; visit: number; arm?: number };
  /** Spawn Adapter launched a worker */
  seat_spawned: {
    seatKey: SeatKey;
    node: NodeId;
    visit: number;
    arm?: number;
    attempt: number;
    cast: HarnessSpec;
    worktree: string;
    branch: string;
    baseSha: string;
    manifestHash: string;
  };
  /** worker completed the §6.4 readiness handshake */
  worker_ready: {
    seatKey: SeatKey;
    manifestHash: string;
    observedBranch: string;
    observedSha: string;
  };
  /** worker's environment check failed — it declined to start */
  worker_refused: {
    seatKey: SeatKey;
    expected: { branch: string; baseSha: string; manifestHash: string };
    observed: { branch?: string; sha?: string; manifestHash?: string; reason?: string };
  };
  /** lease renewal rollup — at most one per minute per seat */
  progress_noted: { seatKey: SeatKey; turns: number; filesTouched: number; tokens: number };
  /** periodic WIP checkpoint (OPS-125 cadence) */
  checkpoint_committed: { seatKey?: SeatKey; sha: string; note?: string };
  /** Adapter-enforced per-seat execution deadline fired. */
  seat_timeout: { seatKey: SeatKey; timeoutMs: number; reason: string };
  /** A seat was deliberately stopped after its WIP checkpoint was secured. */
  seat_aborted: { seatKey: SeatKey; reason: string; checkpointSha?: string };
  /** Categorised failure receipt. Codes are stable machine-facing identifiers. */
  error_recorded: { code: string; message: string; seatKey?: SeatKey; operation: string };
  /** done-signal arrived (or was synthesized on crash) */
  signal_received: {
    seatKey: SeatKey;
    node: NodeId;
    visit: number;
    arm?: number;
    signal: DoneSignal;
    subtype: SignalSubtype;
    spendUsd?: number;
  };
  /** Stage Manager moved a cursor */
  edge_taken: { from: NodeId; to: NodeId | "done" | "park"; why: EdgeWhy; arm?: number };
  /** a gate resolved */
  gate_decided: {
    node: NodeId;
    visit: number;
    by: "human" | "model";
    verdict: "pass" | "fail";
    rubricScore?: number;
    note?: string;
  };
  /** an arm reached its join barrier */
  arm_joined: {
    join: NodeId;
    fanout: NodeId;
    arm: number;
    branch: string;
    status: "complete" | "failed";
    summary?: string;
  };
  /** join strategy concluded */
  join_resolved: {
    join: NodeId;
    strategy: string;
    outcome: "pass" | "fail";
    winner?: number;
    mergeOrder?: number[];
    votes?: Array<{ arm: number; verdict: "pass" | "fail" }>;
    reason?: string;
  };
  /** Sentinel verdicts (§6.2) */
  alarm_raised: { alarm: Alarm };
  alarm_cleared: { alarmType: AlarmType; seatKey?: SeatKey };
  /** steering reached a seat (or its buffer) */
  nudge_delivered: {
    receipt: "delivered" | "queued" | "will-restart" | "dropped";
    target?: SeatKey;
    /** the node the steer was addressed to; undefined = any live seat */
    node?: NodeId;
    text: string;
    /**
     * The steer's stable id. Present for operator/concierge steers (which are
     * durably buffered and tracked to an ack); absent for the Sentinel's
     * ephemeral liveness pokes, which must never fold into a brief.
     */
    steerId?: string;
  };
  /** a live worker confirmed it applied a buffered steer — drains the buffer */
  nudge_acked: { steerId: string; seatKey?: SeatKey };
  /** run handed to a human */
  parked: {
    reason: ParkReason;
    node?: NodeId;
    /** the edge the run would take when resumed (cap-exhaustion parks) */
    pendingEdge?: { to: NodeId | "done" | "park"; arm?: number };
    detail?: string;
  };
  /** run taken back from a human; grant used */
  resumed: {
    grant?: {
      extraVisits?: number;
      extraUsd?: number;
      extraWallClockS?: number;
      gate?: { node: NodeId; verdict: "pass" | "fail"; note?: string };
    };
  };
  /** a pre-spawn gate refused (§4.3 step 4) */
  budget_hit: { ceiling: "usd" | "wall_clock" | "max_concurrent"; limit: number; spent: number };
  /** terminal */
  run_done: { outcome: "success"; totals: RunTotals };
  run_cancelled: { reason?: string; totals: RunTotals };
}

export type RunEventType = keyof RunEventPayloads;

/**
 * Every persisted line carries this machine-facing envelope. `at` remains for
 * backwards compatibility; `timestamp` is the explicit JSONL feed field.
 */
export type RunEvent = {
  [T in RunEventType]: {
    seq: number;
    at: string;
    timestamp: string;
    ticketRef: string;
    runId: string;
    type: T;
    reason: string;
  } & RunEventPayloads[T];
}[RunEventType];

export type RunEventInput = {
  [T in RunEventType]: { type: T } & RunEventPayloads[T];
}[RunEventType];

export const RUN_EVENT_TYPES: readonly RunEventType[] = [
  "run_opened",
  "node_entered",
  "seat_spawned",
  "worker_ready",
  "worker_refused",
  "progress_noted",
  "checkpoint_committed",
  "seat_timeout",
  "seat_aborted",
  "error_recorded",
  "signal_received",
  "edge_taken",
  "gate_decided",
  "arm_joined",
  "join_resolved",
  "alarm_raised",
  "alarm_cleared",
  "nudge_delivered",
  "nudge_acked",
  "parked",
  "resumed",
  "budget_hit",
  "run_done",
  "run_cancelled",
] as const;
