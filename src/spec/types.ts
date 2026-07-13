/**
 * The flow-spec data model — §3.2 of the OPS-152 design (rev 2).
 *
 * A FlowSpec is the "run of show": a small, validated, per-task DAG the
 * concierge writes at filing time. Exactly four node kinds — worker, gate,
 * fanout, join — no expressions, no conditionals beyond pass/fail edges,
 * no user-defined node types.
 */

export type NodeId = string;

/** Reserved edge targets. Not nodes. */
export const EDGE_DONE = "done" as const;
export const EDGE_PARK = "park" as const;

export type PassTarget = NodeId | typeof EDGE_DONE;
export type FailTarget = NodeId | typeof EDGE_PARK;

export type Effort = "low" | "medium" | "high" | "xhigh";

/** Existing casting record — {harness, model, effort} — unchanged (§1.2). */
export interface HarnessSpec {
  harness: string;
  model?: string;
  effort?: Effort;
}

/**
 * Advisory turn / wall-clock supervision estimates per effort tier (§1.2).
 * These are supervision *estimates*, never hard kills; §6 covers overruns.
 */
export const ENVELOPE_BY_EFFORT: Record<Effort, { turnCap: number; wallClockS: number }> = {
  low: { turnCap: 15, wallClockS: 600 },
  medium: { turnCap: 30, wallClockS: 1200 },
  high: { turnCap: 60, wallClockS: 2400 },
  xhigh: { turnCap: 100, wallClockS: 3600 },
};

export const DEFAULT_EFFORT: Effort = "medium";

/** Per-node defaults (§3.2 comments). */
export const DEFAULT_MAX_VISITS = 3;
export const DEFAULT_RETRIES = 3;
export const DEFAULT_MAX_FAILS = 2;

/**
 * Per-run alarm thresholds — §6.1/§6.2. All optional; engine defaults shown.
 * Floors are enforced by the linter: a spec may relax thresholds but not
 * disable them ("alarms: off is, like Infinity, not representable" — §3.3).
 */
export interface SuperviseSpec {
  /** Silence longer than this marks a seat "quiet". Default 90, floor 30. */
  leaseS?: number;
  /** Quiet windows before the stall alarm. Default 2, floor 1. */
  quietStrikes?: number;
  /** × the cast's envelope wallClockS → overrun alarm. Default 1.5, floor 1.1. */
  overrunFactor?: number;
  /** WIP checkpoint cadence, seconds (OPS-125, now per-run). Default 300, floor 60. */
  checkpointS?: number;
  /** spawn → worker_ready deadline, seconds. Default 60, floor 10. */
  readyS?: number;
}

export const SUPERVISE_DEFAULTS: Required<SuperviseSpec> = {
  leaseS: 90,
  quietStrikes: 2,
  overrunFactor: 1.5,
  checkpointS: 300,
  readyS: 60,
};

export const SUPERVISE_FLOORS: Required<SuperviseSpec> = {
  leaseS: 30,
  quietStrikes: 1,
  overrunFactor: 1.1,
  checkpointS: 60,
  readyS: 10,
};

/** Spawn one cast seat in the task worktree. */
export interface WorkerNode {
  kind: "worker";
  /** Who sits down — existing {harness, model, effort}. */
  cast: HarnessSpec;
  /** Stage instruction appended to the ticket body. */
  brief?: string;
  /** Expected output path, e.g. "docs/design/<id>.md". */
  artifact?: string;
  /** Edge taken on done-signal "complete". */
  onPass: PassTarget;
  /** Edge on "blocked"/"partial"/error; park = hand to human. */
  onFail: FailTarget;
  /** Re-entry cap for THIS node (default 3; rework generalised). */
  maxVisits?: number;
  /** Same-visit crash/timeout retries (default 3). */
  retries?: number;
}

/** A decision point: human, or a cheap model check (generalises design_check). */
export interface GateNode {
  kind: "gate";
  by:
    | "human" // PARKED: no worker, zero tokens, concierge pings channel
    | { cast: HarnessSpec; rubric: string }; // LIVE: cheap check
  onPass: PassTarget;
  onFail: FailTarget;
  /** Bounces before it parks anyway (default 2, per node). */
  maxFails?: number;
  /** Re-entry cap for THIS node (default 3). */
  maxVisits?: number;
}

export interface FanoutArm {
  cast: HarnessSpec;
  brief?: string;
}

/** N parallel branches of THIS task. */
export interface FanoutNode {
  kind: "fanout";
  /** Explicit arms; or {template, n} sugar. */
  arms: FanoutArm[];
  /** Writers isolate; read-only scouts may share. */
  isolation: "worktree-each" | "shared";
  /** Every arm's edges converge on one JoinNode. */
  join: NodeId;
  /** Re-entry cap for THIS node (default 3). */
  maxVisits?: number;
  /** Same-visit crash/timeout retries per arm (default 3). */
  retries?: number;
}

export type JoinStrategy =
  | "all-merge" // merge every arm's branch (deps-merge machinery reused)
  | "first" // first complete wins; engine aborts the rest
  | "quorum" // k-of-n verdict nodes agree (k in quorumK)
  | { judge: HarnessSpec }; // a cast seat reads all arms' diffs, picks/synthesises

/** How parallel arms become one line again. */
export interface JoinNode {
  kind: "join";
  strategy: JoinStrategy;
  quorumK?: number;
  onPass: PassTarget;
  onFail: FailTarget;
  /** Re-entry cap for THIS node (default 3). */
  maxVisits?: number;
}

export type FlowNode = WorkerNode | GateNode | FanoutNode | JoinNode;

/** Hard ceilings for the whole run. */
export interface FlowBudget {
  /** This task's worker slots (≤ global max_workers). */
  maxConcurrent?: number;
  /** Spend cap across all seats. */
  usd?: number;
  wallClockS?: number;
}

export interface FlowSpec {
  version: 1;
  /** Where the run starts. */
  entry: NodeId;
  nodes: Record<NodeId, FlowNode>;
  budget?: FlowBudget;
  /** Rev 2: per-run alarm thresholds — §6.2, defaults apply. */
  supervise?: SuperviseSpec;
}

/** Resolved supervision thresholds for a spec (defaults applied). */
export function resolveSupervise(spec: FlowSpec): Required<SuperviseSpec> {
  return { ...SUPERVISE_DEFAULTS, ...(spec.supervise ?? {}) };
}

export function envelopeFor(cast: HarnessSpec): { turnCap: number; wallClockS: number } {
  return ENVELOPE_BY_EFFORT[cast.effort ?? DEFAULT_EFFORT];
}

export function maxVisitsOf(node: FlowNode): number {
  return node.maxVisits ?? DEFAULT_MAX_VISITS;
}

export function retriesOf(node: FlowNode): number {
  if (node.kind === "worker" || node.kind === "fanout") return node.retries ?? DEFAULT_RETRIES;
  return DEFAULT_RETRIES;
}

export function maxFailsOf(node: GateNode): number {
  return node.maxFails ?? DEFAULT_MAX_FAILS;
}

/** The edges leaving a node (targets that are NodeIds, not done/park). */
export function nodeEdgeTargets(node: FlowNode): NodeId[] {
  const out: NodeId[] = [];
  switch (node.kind) {
    case "worker":
    case "gate":
    case "join":
      if (node.onPass !== EDGE_DONE) out.push(node.onPass);
      if (node.onFail !== EDGE_PARK) out.push(node.onFail);
      break;
    case "fanout":
      out.push(node.join);
      break;
  }
  return out;
}
