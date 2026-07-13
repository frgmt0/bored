/**
 * The flow builder — scripted authoring for the run of show. Instead of
 * hand-writing JSON, a script (or any TypeScript caller) composes the DAG
 * fluently and gets a linted FlowSpec back. The output is exactly the same
 * closed algebra the engine executes — scripting controls the *shape* per
 * task; execution semantics stay bounded and deterministic (§3.1's fence
 * against the workflow-engine tarpit is preserved: build() runs the full
 * linter, so an unbounded or malformed graph never leaves the builder).
 */
import { mustLint, type LintOptions } from "../spec/lint.js";
import type {
  FanoutArm,
  FlowBudget,
  FlowNode,
  FlowSpec,
  HarnessSpec,
  JoinStrategy,
  NodeId,
  SuperviseSpec,
} from "../spec/types.js";

export interface WorkerOpts {
  cast: HarnessSpec;
  brief?: string;
  artifact?: string;
  onPass: NodeId | "done";
  /** defaults to "park" — hand to a human */
  onFail?: NodeId | "park";
  maxVisits?: number;
  retries?: number;
}

export interface GateOpts {
  by: "human" | { cast: HarnessSpec; rubric: string };
  onPass: NodeId | "done";
  onFail?: NodeId | "park";
  maxFails?: number;
  maxVisits?: number;
}

export interface FanoutOpts {
  arms: FanoutArm[];
  /** defaults to "worktree-each" — writers isolate */
  isolation?: "worktree-each" | "shared";
  join: NodeId;
  maxVisits?: number;
  retries?: number;
}

export interface JoinOpts {
  strategy: JoinStrategy;
  quorumK?: number;
  onPass: NodeId | "done";
  onFail?: NodeId | "park";
  maxVisits?: number;
}

export class FlowBuilder {
  private readonly nodes: Record<NodeId, FlowNode> = {};
  private entryId: NodeId | undefined;
  private budgetSpec: FlowBudget | undefined;
  private superviseSpec: SuperviseSpec | undefined;

  /** Explicit entry; otherwise the first node added is the entry. */
  entry(id: NodeId): this {
    this.entryId = id;
    return this;
  }

  private add(id: NodeId, node: FlowNode): this {
    if (this.nodes[id]) throw new Error(`node "${id}" is already defined`);
    this.nodes[id] = node;
    this.entryId ??= id;
    return this;
  }

  worker(id: NodeId, opts: WorkerOpts): this {
    return this.add(id, {
      kind: "worker",
      cast: opts.cast,
      ...(opts.brief !== undefined ? { brief: opts.brief } : {}),
      ...(opts.artifact !== undefined ? { artifact: opts.artifact } : {}),
      onPass: opts.onPass,
      onFail: opts.onFail ?? "park",
      ...(opts.maxVisits !== undefined ? { maxVisits: opts.maxVisits } : {}),
      ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    });
  }

  gate(id: NodeId, opts: GateOpts): this {
    return this.add(id, {
      kind: "gate",
      by: opts.by,
      onPass: opts.onPass,
      onFail: opts.onFail ?? "park",
      ...(opts.maxFails !== undefined ? { maxFails: opts.maxFails } : {}),
      ...(opts.maxVisits !== undefined ? { maxVisits: opts.maxVisits } : {}),
    });
  }

  fanout(id: NodeId, opts: FanoutOpts): this {
    return this.add(id, {
      kind: "fanout",
      arms: opts.arms,
      isolation: opts.isolation ?? "worktree-each",
      join: opts.join,
      ...(opts.maxVisits !== undefined ? { maxVisits: opts.maxVisits } : {}),
      ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    });
  }

  join(id: NodeId, opts: JoinOpts): this {
    return this.add(id, {
      kind: "join",
      strategy: opts.strategy,
      ...(opts.quorumK !== undefined ? { quorumK: opts.quorumK } : {}),
      onPass: opts.onPass,
      onFail: opts.onFail ?? "park",
      ...(opts.maxVisits !== undefined ? { maxVisits: opts.maxVisits } : {}),
    });
  }

  budget(budget: FlowBudget): this {
    this.budgetSpec = budget;
    return this;
  }

  supervise(supervise: SuperviseSpec): this {
    this.superviseSpec = supervise;
    return this;
  }

  /** Lint and freeze. Throws with every lint issue listed if the graph is bad. */
  build(lintOpts?: LintOptions): FlowSpec {
    if (!this.entryId) throw new Error("an empty flow has no entry — add a node");
    const spec: FlowSpec = {
      version: 1,
      entry: this.entryId,
      nodes: this.nodes,
      ...(this.budgetSpec !== undefined ? { budget: this.budgetSpec } : {}),
      ...(this.superviseSpec !== undefined ? { supervise: this.superviseSpec } : {}),
    };
    return mustLint(spec, lintOpts);
  }
}

/** Entry point for scripts: `flow().worker("implement", {...}).build()`. */
export function flow(entry?: NodeId): FlowBuilder {
  const builder = new FlowBuilder();
  if (entry != null) builder.entry(entry);
  return builder;
}
