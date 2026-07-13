/**
 * The Flow Linter — §3.3 / §4 ("validate a FlowSpec at filing time: schema,
 * graph shape, bounded cycles, budgets, cast doctrine. Pure function; no I/O").
 *
 * What the linter refuses at filing time:
 *  - unknown edge targets; unreachable nodes; an entry that isn't a node;
 *    fanout arms whose edges escape their join;
 *  - unbounded cycles: every cycle in the graph must pass through a node
 *    whose maxVisits / maxFails is finite (all default finite; Infinity is
 *    not representable at the schema layer);
 *  - budget sanity: maxConcurrent ≤ global max_workers; a confirm-gated
 *    model seat anywhere in the spec triggers the confirm-before-cast
 *    handshake (reported, not refused);
 *  - cast validation per seat (blocked models, malformed efforts);
 *  - supervision sanity: thresholds may be relaxed but not disabled —
 *    floors are enforced.
 */
import { flowSpecSchema } from "./schema.js";
import {
  DEFAULT_MAX_FAILS,
  DEFAULT_MAX_VISITS,
  EDGE_DONE,
  EDGE_PARK,
  SUPERVISE_FLOORS,
  type FlowNode,
  type FlowSpec,
  type HarnessSpec,
  type NodeId,
} from "./types.js";

export interface LintIssue {
  code:
    | "schema"
    | "reserved_node_id"
    | "unknown_edge_target"
    | "bad_entry"
    | "unreachable_node"
    | "fanout_join_invalid"
    | "join_orphaned"
    | "join_shared"
    | "join_entered_directly"
    | "quorum_invalid"
    | "unbounded_cycle"
    | "budget_insane"
    | "cast_blocked"
    | "supervision_below_floor";
  message: string;
  /** Node the issue is anchored to, when there is one. */
  node?: NodeId;
}

export interface LintOptions {
  /** Global max_workers cap; per-run maxConcurrent must not exceed it. */
  maxWorkers?: number;
  /** Models the cast doctrine refuses outright. */
  blockedModels?: string[];
  /** Models that require the confirm-before-cast handshake (default: /fable/i). */
  confirmModels?: RegExp;
}

export interface LintResult {
  ok: boolean;
  errors: LintIssue[];
  /** Spec parses and validates but a seat needs the confirm-before-cast handshake. */
  requiresConfirm: boolean;
  /** The parsed spec, when the schema at least was valid. */
  spec?: FlowSpec;
}

const DEFAULT_CONFIRM = /fable/i;

function castsOf(node: FlowNode): HarnessSpec[] {
  switch (node.kind) {
    case "worker":
      return [node.cast];
    case "gate":
      return node.by === "human" ? [] : [node.by.cast];
    case "fanout":
      return node.arms.map((a) => a.cast);
    case "join":
      return typeof node.strategy === "object" ? [node.strategy.judge] : [];
  }
}

/**
 * The effective loop-cutting cap of a node: finite means any cycle through
 * this node terminates by construction (§5.3).
 */
function loopCapOf(node: FlowNode): number {
  const visits = node.maxVisits ?? DEFAULT_MAX_VISITS;
  if (node.kind === "gate") {
    return Math.min(visits, node.maxFails ?? DEFAULT_MAX_FAILS);
  }
  return visits;
}

export function lintFlowSpec(data: unknown, opts: LintOptions = {}): LintResult {
  const errors: LintIssue[] = [];
  let requiresConfirm = false;

  const parsed = flowSpecSchema.safeParse(data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        code: "schema",
        message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      });
    }
    return { ok: false, errors, requiresConfirm };
  }
  const spec = parsed.data as FlowSpec;
  const nodes = spec.nodes;
  const ids = Object.keys(nodes);

  // Reserved ids — "done" / "park" are edge targets, never nodes.
  for (const id of ids) {
    if (id === EDGE_DONE || id === EDGE_PARK) {
      errors.push({
        code: "reserved_node_id",
        node: id,
        message: `"${id}" is a reserved edge target and cannot be a node id`,
      });
    }
  }

  // Entry must be a node.
  if (!(spec.entry in nodes)) {
    errors.push({ code: "bad_entry", message: `entry "${spec.entry}" is not a node` });
  }

  // Edge targets must exist ("done" only valid on onPass, "park" only on onFail).
  const edgeList: Array<{ from: NodeId; to: NodeId }> = [];
  for (const [id, node] of Object.entries(nodes)) {
    const check = (target: string, kind: "pass" | "fail" | "join") => {
      const reserved = kind === "pass" ? EDGE_DONE : kind === "fail" ? EDGE_PARK : null;
      if (target === reserved) return;
      if (!(target in nodes)) {
        errors.push({
          code: "unknown_edge_target",
          node: id,
          message: `node "${id}" ${kind}-edge targets unknown node "${target}"`,
        });
        return;
      }
      edgeList.push({ from: id, to: target });
    };
    switch (node.kind) {
      case "worker":
      case "gate":
        check(node.onPass, "pass");
        check(node.onFail, "fail");
        break;
      case "join":
        check(node.onPass, "pass");
        check(node.onFail, "fail");
        break;
      case "fanout":
        check(node.join, "join");
        break;
    }
  }

  // Fanout / join pairing: every fanout's join is a JoinNode; every join
  // belongs to exactly one fanout; joins are entered only through their
  // fanout (arm edges may not escape the join, and nothing may jump into
  // a join from the side).
  const joinOwners = new Map<NodeId, NodeId[]>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.kind !== "fanout") continue;
    const target = nodes[node.join];
    if (!target) continue; // already reported as unknown_edge_target
    if (target.kind !== "join") {
      errors.push({
        code: "fanout_join_invalid",
        node: id,
        message: `fanout "${id}" joins on "${node.join}" which is a ${target.kind}, not a join`,
      });
      continue;
    }
    joinOwners.set(node.join, [...(joinOwners.get(node.join) ?? []), id]);
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.kind !== "join") continue;
    const owners = joinOwners.get(id) ?? [];
    if (owners.length === 0) {
      errors.push({
        code: "join_orphaned",
        node: id,
        message: `join "${id}" is not the join of any fanout`,
      });
    } else if (owners.length > 1) {
      errors.push({
        code: "join_shared",
        node: id,
        message: `join "${id}" is claimed by more than one fanout (${owners.join(", ")})`,
      });
    }
    // Quorum sanity.
    if (node.strategy === "quorum") {
      const owner = owners[0];
      const armCount =
        owner && nodes[owner]?.kind === "fanout"
          ? (nodes[owner] as Extract<FlowNode, { kind: "fanout" }>).arms.length
          : undefined;
      if (node.quorumK == null) {
        errors.push({
          code: "quorum_invalid",
          node: id,
          message: `join "${id}" uses strategy "quorum" but has no quorumK`,
        });
      } else if (armCount != null && node.quorumK > armCount) {
        errors.push({
          code: "quorum_invalid",
          node: id,
          message: `join "${id}" needs quorumK=${node.quorumK} but its fanout only has ${armCount} arms`,
        });
      }
    } else if (node.quorumK != null) {
      errors.push({
        code: "quorum_invalid",
        node: id,
        message: `join "${id}" sets quorumK but its strategy is not "quorum"`,
      });
    }
  }
  // Nothing but a fanout may lead into a join.
  for (const { from, to } of edgeList) {
    const target = nodes[to];
    const source = nodes[from];
    if (target?.kind === "join" && source?.kind !== "fanout") {
      errors.push({
        code: "join_entered_directly",
        node: from,
        message: `node "${from}" edges directly into join "${to}"; joins are entered only through their fanout`,
      });
    }
  }

  // Reachability from entry.
  if (spec.entry in nodes) {
    const seen = new Set<NodeId>([spec.entry]);
    const queue = [spec.entry];
    while (queue.length) {
      const id = queue.shift()!;
      for (const { from, to } of edgeList) {
        if (from === id && !seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    for (const id of ids) {
      if (!seen.has(id)) {
        errors.push({
          code: "unreachable_node",
          node: id,
          message: `node "${id}" is unreachable from entry "${spec.entry}"`,
        });
      }
    }
  }

  // Bounded cycles: every cycle must pass through a node with a finite
  // loop-cutting cap. The schema layer already makes every cap finite, so
  // this can only fire if that invariant is ever loosened — it is the
  // proof, the dynamic checks in §5.3 are enforcement.
  const adj = new Map<NodeId, NodeId[]>();
  for (const { from, to } of edgeList) {
    adj.set(from, [...(adj.get(from) ?? []), to]);
  }
  const cycles = findCycles(ids, adj);
  for (const cycle of cycles) {
    const cut = cycle.some((id) => Number.isFinite(loopCapOf(nodes[id]!)));
    if (!cut) {
      errors.push({
        code: "unbounded_cycle",
        message: `cycle ${cycle.join(" → ")} has no node with a finite maxVisits/maxFails`,
      });
    }
  }

  // Budget sanity.
  if (
    spec.budget?.maxConcurrent != null &&
    opts.maxWorkers != null &&
    spec.budget.maxConcurrent > opts.maxWorkers
  ) {
    errors.push({
      code: "budget_insane",
      message: `budget.maxConcurrent=${spec.budget.maxConcurrent} exceeds global max_workers=${opts.maxWorkers}`,
    });
  }

  // Cast doctrine per seat.
  const confirmRe = opts.confirmModels ?? DEFAULT_CONFIRM;
  for (const [id, node] of Object.entries(nodes)) {
    for (const cast of castsOf(node)) {
      if (cast.model && (opts.blockedModels ?? []).includes(cast.model)) {
        errors.push({
          code: "cast_blocked",
          node: id,
          message: `node "${id}" casts blocked model "${cast.model}"`,
        });
      }
      if (cast.model && confirmRe.test(cast.model)) requiresConfirm = true;
    }
  }

  // Supervision sanity: floors, not clamps — relaxing is allowed, disabling is not.
  if (spec.supervise) {
    for (const key of Object.keys(SUPERVISE_FLOORS) as Array<keyof typeof SUPERVISE_FLOORS>) {
      const value = spec.supervise[key];
      if (value != null && value < SUPERVISE_FLOORS[key]) {
        errors.push({
          code: "supervision_below_floor",
          message: `supervise.${key}=${value} is below the floor ${SUPERVISE_FLOORS[key]}`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, requiresConfirm, spec };
}

/** Lint and throw on any error; returns the parsed spec. */
export function mustLint(data: unknown, opts: LintOptions = {}): FlowSpec {
  const result = lintFlowSpec(data, opts);
  if (!result.ok || !result.spec) {
    const detail = result.errors.map((e) => `  - [${e.code}] ${e.message}`).join("\n");
    throw new Error(`flow spec failed lint:\n${detail}`);
  }
  return result.spec;
}

/**
 * Enumerate elementary cycles (Johnson-lite via DFS; specs are tiny so
 * exhaustive enumeration is fine).
 */
function findCycles(ids: NodeId[], adj: Map<NodeId, NodeId[]>): NodeId[][] {
  const cycles: NodeId[][] = [];
  const seenKeys = new Set<string>();
  for (const start of ids) {
    const stack: NodeId[] = [];
    const onStack = new Set<NodeId>();
    const visit = (id: NodeId) => {
      stack.push(id);
      onStack.add(id);
      for (const next of adj.get(id) ?? []) {
        if (next === start) {
          const cycle = [...stack];
          // canonical key: rotate so the smallest id leads
          const min = [...cycle].sort()[0]!;
          const idx = cycle.indexOf(min);
          const canon = [...cycle.slice(idx), ...cycle.slice(0, idx)].join("→");
          if (!seenKeys.has(canon)) {
            seenKeys.add(canon);
            cycles.push(cycle);
          }
        } else if (!onStack.has(next) && next >= start) {
          visit(next);
        }
      }
      stack.pop();
      onStack.delete(id);
    };
    visit(start);
  }
  return cycles;
}
