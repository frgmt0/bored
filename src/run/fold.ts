/**
 * The fold — §5.1. Runs are event-sourced: the run record below is *just the
 * fold* of the append-only event log. Folding is pure and deterministic —
 * same log, same state, every time. Every engine decision is computed from
 * this folded state plus the frozen spec; there is no shadow state.
 */
import type { FlowSpec, HarnessSpec, NodeId } from "../spec/types.js";
import type {
  Alarm,
  ParkReason,
  RunEvent,
  SeatKey,
} from "./events.js";

export type RunStatus = "running" | "parked" | "done" | "cancelled";

export type CursorPhase =
  | "entered" // node_entered appended; no live seat yet (or between retries)
  | "seated" // a seat is spawning/live for this cursor
  | "awaiting_join" // an arm that has reached its join barrier
  | "gate_waiting"; // a human gate holding for a verdict

export interface Cursor {
  node: NodeId;
  visit: number;
  arm?: number;
  phase: CursorPhase;
  seatKey?: SeatKey;
  branch?: string;
  /** same-visit infra retries burned (crash / auth / rate-limit ladder) */
  retriesUsed: number;
}

export type SeatPhase = "spawning" | "live" | "finished" | "refused" | "aborted";

export interface SeatState {
  key: SeatKey;
  node: NodeId;
  visit: number;
  arm?: number;
  attempt: number;
  cast: HarnessSpec;
  phase: SeatPhase;
  worktree: string;
  branch: string;
  baseSha: string;
  manifestHash: string;
  spawnedAt: string;
  readyAt?: string;
  finishedAt?: string;
  lastSignalStatus?: string;
}

export interface LeaseState {
  renewedAt: string;
  state: "live" | "quiet" | "expired";
}

export interface JoinArmResult {
  status: "complete" | "failed";
  branch: string;
  summary?: string;
}

export interface JoinState {
  join: NodeId;
  fanout: NodeId;
  visit: number;
  expectedArms: number;
  arms: Record<number, JoinArmResult>;
  resolved?: "pass" | "fail";
}

export interface ParkedState {
  reason: ParkReason;
  node?: NodeId;
  since: string;
  pendingEdge?: { to: NodeId | "done" | "park"; arm?: number };
  detail?: string;
}

export interface Grants {
  /** extra visits granted on resume, per node */
  extraVisits: Record<NodeId, number>;
  extraUsd: number;
  extraWallClockS: number;
}

export interface FlowRun {
  taskRef: string;
  /** frozen copy at filing time (edits create a new rev) */
  spec: FlowSpec;
  originChannel?: string;
  body?: string;
  criteria?: string[];
  status: RunStatus;
  /** exactly 1, except between fanout and join */
  cursors: Cursor[];
  /** per-node re-entry counters (replaces reworkCount et al.) */
  visits: Record<NodeId, number>;
  /** per-gate fail bounces (maxFails counter) */
  gateFails: Record<NodeId, number>;
  parked?: ParkedState;
  spend: { usd: number; byNode: Record<NodeId, number> };
  /** rev 2 — §6.1 */
  leases: Record<SeatKey, LeaseState>;
  seats: Record<SeatKey, SeatState>;
  joins: Record<NodeId, JoinState>;
  grants: Grants;
  /**
   * buffered steering waiting for the next seat (§5.5), keyed by steer id.
   * `node` records the seat a steer was addressed to so it is only delivered
   * to that node's next seat; an undefined `node` folds into whatever seat
   * spawns next.
   */
  pendingSteers: Array<{ id: string; text: string; at: string; node?: NodeId }>;
  /** alarms currently standing (raised, not yet cleared) */
  activeAlarms: Alarm[];
  openedAt: string;
  closedAt?: string;
  outcome?: "success" | "cancelled";
  lastSeq: number;
}

function emptyRun(): FlowRun {
  return {
    taskRef: "",
    spec: { version: 1, entry: "", nodes: {} },
    status: "running",
    cursors: [],
    visits: {},
    gateFails: {},
    spend: { usd: 0, byNode: {} },
    leases: {},
    seats: {},
    joins: {},
    grants: { extraVisits: {}, extraUsd: 0, extraWallClockS: 0 },
    pendingSteers: [],
    activeAlarms: [],
    openedAt: "",
    lastSeq: 0,
  };
}

function cursorAt(
  run: FlowRun,
  node: NodeId,
  arm?: number | null,
): Cursor | undefined {
  return run.cursors.find((c) => c.node === node && (arm == null ? c.arm == null : c.arm === arm));
}

function removeCursor(run: FlowRun, node: NodeId, arm?: number | null): void {
  run.cursors = run.cursors.filter(
    (c) => !(c.node === node && (arm == null ? c.arm == null : c.arm === arm)),
  );
}

function renewLease(run: FlowRun, seatKey: SeatKey, at: string): void {
  const seat = run.seats[seatKey];
  if (!seat || seat.phase === "finished" || seat.phase === "aborted" || seat.phase === "refused") {
    return;
  }
  run.leases[seatKey] = { renewedAt: at, state: "live" };
}

/** Apply one event to the folded state. Mutates `run`; callers own copies. */
export function applyEvent(run: FlowRun, ev: RunEvent): FlowRun {
  run.lastSeq = ev.seq;
  switch (ev.type) {
    case "run_opened": {
      run.taskRef = ev.taskRef;
      run.spec = ev.spec;
      if (ev.originChannel !== undefined) run.originChannel = ev.originChannel;
      if (ev.body !== undefined) run.body = ev.body;
      if (ev.criteria !== undefined) run.criteria = ev.criteria;
      run.openedAt = ev.at;
      run.status = "running";
      break;
    }
    case "node_entered": {
      const node = run.spec.nodes[ev.node];
      run.visits[ev.node] = Math.max(run.visits[ev.node] ?? 0, ev.visit);
      if (node?.kind === "fanout") {
        // The fanout forks the cursor: one arm cursor per declared arm.
        for (let arm = 0; arm < node.arms.length; arm++) {
          run.cursors.push({ node: ev.node, visit: ev.visit, arm, phase: "entered", retriesUsed: 0 });
        }
        run.joins[node.join] = {
          join: node.join,
          fanout: ev.node,
          visit: ev.visit,
          expectedArms: node.arms.length,
          arms: {},
        };
      } else {
        run.cursors.push({
          node: ev.node,
          visit: ev.visit,
          ...(ev.arm != null ? { arm: ev.arm } : {}),
          phase: node?.kind === "gate" && node.by === "human" ? "gate_waiting" : "entered",
          retriesUsed: 0,
        });
      }
      break;
    }
    case "seat_spawned": {
      run.seats[ev.seatKey] = {
        key: ev.seatKey,
        node: ev.node,
        visit: ev.visit,
        ...(ev.arm != null ? { arm: ev.arm } : {}),
        attempt: ev.attempt,
        cast: ev.cast,
        phase: "spawning",
        worktree: ev.worktree,
        branch: ev.branch,
        baseSha: ev.baseSha,
        manifestHash: ev.manifestHash,
        spawnedAt: ev.at,
      };
      run.leases[ev.seatKey] = { renewedAt: ev.at, state: "live" };
      const cursor = cursorAt(run, ev.node, ev.arm);
      if (cursor) {
        cursor.phase = "seated";
        cursor.seatKey = ev.seatKey;
        cursor.branch = ev.branch;
      }
      // Buffered steering folds into the next worker's brief and is drained —
      // but only the steers addressed to this node (or to no node in
      // particular). A steer aimed at a different node stays buffered so it
      // reaches that node's seat, not this one (§5.5 routing).
      run.pendingSteers = run.pendingSteers.filter(
        (s) => s.node != null && s.node !== ev.node,
      );
      break;
    }
    case "worker_ready": {
      const seat = run.seats[ev.seatKey];
      if (seat) {
        seat.phase = "live";
        seat.readyAt = ev.at;
      }
      renewLease(run, ev.seatKey, ev.at);
      break;
    }
    case "worker_refused": {
      const seat = run.seats[ev.seatKey];
      if (seat) seat.phase = "refused";
      delete run.leases[ev.seatKey];
      break;
    }
    case "progress_noted": {
      renewLease(run, ev.seatKey, ev.at);
      break;
    }
    case "checkpoint_committed": {
      if (ev.seatKey) renewLease(run, ev.seatKey, ev.at);
      break;
    }
    case "seat_timeout":
    case "seat_aborted":
    case "error_recorded": {
      // Observability receipts do not alter the durable workflow projection.
      break;
    }
    case "signal_received": {
      const seat = run.seats[ev.seatKey];
      if (seat) {
        seat.phase = ev.subtype === "synthesized_abort" ? "aborted" : "finished";
        seat.finishedAt = ev.at;
        seat.lastSignalStatus = ev.signal.status;
      }
      delete run.leases[ev.seatKey];
      if (ev.spendUsd) {
        run.spend.usd += ev.spendUsd;
        run.spend.byNode[ev.node] = (run.spend.byNode[ev.node] ?? 0) + ev.spendUsd;
      }
      const cursor = cursorAt(run, ev.node, ev.arm);
      if (cursor) cursor.phase = "entered"; // seat gone; cursor awaits the engine's decision
      break;
    }
    case "edge_taken": {
      const cursor = cursorAt(run, ev.from, ev.arm);
      if (ev.why === "retry") {
        if (cursor) {
          cursor.retriesUsed += 1;
          cursor.phase = "entered";
          delete cursor.seatKey;
        }
        break;
      }
      removeCursor(run, ev.from, ev.arm);
      break;
    }
    case "gate_decided": {
      if (ev.verdict === "fail") {
        run.gateFails[ev.node] = (run.gateFails[ev.node] ?? 0) + 1;
      }
      break;
    }
    case "arm_joined": {
      const join = run.joins[ev.join];
      if (join) {
        join.arms[ev.arm] = {
          status: ev.status,
          branch: ev.branch,
          ...(ev.summary !== undefined ? { summary: ev.summary } : {}),
        };
      }
      const cursor = cursorAt(run, ev.fanout, ev.arm);
      if (cursor) cursor.phase = "awaiting_join";
      break;
    }
    case "join_resolved": {
      const join = run.joins[ev.join];
      if (join) {
        join.resolved = ev.outcome;
        // All arm cursors of the owning fanout stand down.
        run.cursors = run.cursors.filter((c) => !(c.node === join.fanout && c.arm != null));
      }
      break;
    }
    case "alarm_raised": {
      run.activeAlarms.push(ev.alarm);
      break;
    }
    case "alarm_cleared": {
      run.activeAlarms = run.activeAlarms.filter(
        (a) => !(a.type === ev.alarmType && a.seatKey === ev.seatKey),
      );
      break;
    }
    case "nudge_delivered": {
      // Every operator/concierge steer (one carrying a steerId) is durably
      // buffered — whether it was queued or handed live to a worker — so it is
      // guaranteed to reach the run: an ack drains it, otherwise it folds into
      // the next seat's brief. Dedup by id: one logical steer fanned out to
      // several live seats buffers once. `node` rides along so the steer is
      // only delivered to that node's next seat (§5.5 routing). Sentinel pokes
      // carry no id and are never buffered.
      if (ev.steerId != null && !run.pendingSteers.some((s) => s.id === ev.steerId)) {
        run.pendingSteers.push({
          id: ev.steerId,
          text: ev.text,
          at: ev.at,
          ...(ev.node != null ? { node: ev.node } : {}),
        });
      }
      break;
    }
    case "nudge_acked": {
      // A live worker confirmed it applied the steer — drop it from the buffer
      // so it does not also fold into a later seat's brief.
      run.pendingSteers = run.pendingSteers.filter((s) => s.id !== ev.steerId);
      break;
    }
    case "parked": {
      run.status = "parked";
      run.parked = {
        reason: ev.reason,
        ...(ev.node !== undefined ? { node: ev.node } : {}),
        since: ev.at,
        ...(ev.pendingEdge !== undefined ? { pendingEdge: ev.pendingEdge } : {}),
        ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
      };
      break;
    }
    case "resumed": {
      run.status = "running";
      const grant = ev.grant;
      if (grant?.extraVisits && run.parked?.node) {
        run.grants.extraVisits[run.parked.node] =
          (run.grants.extraVisits[run.parked.node] ?? 0) + grant.extraVisits;
      }
      if (grant?.extraUsd) run.grants.extraUsd += grant.extraUsd;
      if (grant?.extraWallClockS) run.grants.extraWallClockS += grant.extraWallClockS;
      delete run.parked;
      break;
    }
    case "budget_hit": {
      // The park that follows carries the state change; this is the receipt.
      break;
    }
    case "run_done": {
      run.status = "done";
      run.outcome = "success";
      run.closedAt = ev.at;
      run.cursors = [];
      break;
    }
    case "run_cancelled": {
      run.status = "cancelled";
      run.outcome = "cancelled";
      run.closedAt = ev.at;
      run.cursors = [];
      break;
    }
  }
  return run;
}

/** Fold a full log into a FlowRun. Pure: same log, same state, every time. */
export function foldRun(events: readonly RunEvent[]): FlowRun {
  const run = emptyRun();
  for (const ev of events) applyEvent(run, ev);
  return run;
}

/** Effective re-entry cap for a node: spec cap + any resume grants (§5.3). */
export function effectiveMaxVisits(run: FlowRun, node: NodeId, specCap: number): number {
  return specCap + (run.grants.extraVisits[node] ?? 0);
}
