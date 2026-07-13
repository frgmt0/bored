/**
 * §3.3 — what the linter refuses at filing time. Every refusal class gets a
 * spec that triggers it and a near-identical spec that passes.
 */
import { describe, expect, it } from "vitest";
import { lintFlowSpec, mustLint } from "../src/spec/lint.js";
import { SUPERVISE_FLOORS } from "../src/spec/types.js";
import * as presets from "../src/presets.js";

const worker = (onPass: string, onFail = "park") => ({
  kind: "worker",
  cast: { harness: "pi", effort: "high" },
  onPass,
  onFail,
});

const minimal = () => ({
  version: 1,
  entry: "implement",
  nodes: { implement: worker("done") },
});

function codes(data: unknown, opts = {}): string[] {
  return lintFlowSpec(data, opts).errors.map((e) => e.code);
}

describe("flow linter — schema layer", () => {
  it("accepts the minimal one-pass spec", () => {
    const result = lintFlowSpec(minimal());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("refuses non-objects, wrong versions, unknown node kinds and extra keys", () => {
    expect(codes(null)).toContain("schema");
    expect(codes({ ...minimal(), version: 2 })).toContain("schema");
    expect(
      codes({ version: 1, entry: "x", nodes: { x: { kind: "loop", onPass: "done" } } }),
    ).toContain("schema");
    expect(codes({ ...minimal(), extra: true })).toContain("schema");
  });

  it("Infinity is simply not representable in any counter (§3.3)", () => {
    for (const field of ["maxVisits", "retries"]) {
      const spec = minimal();
      (spec.nodes.implement as Record<string, unknown>)[field] = Infinity;
      expect(codes(spec)).toContain("schema");
    }
    const gateSpec = {
      version: 1,
      entry: "g",
      nodes: {
        g: {
          kind: "gate",
          by: "human",
          onPass: "done",
          onFail: "park",
          maxFails: Infinity,
        },
      },
    };
    expect(codes(gateSpec)).toContain("schema");
  });

  it('"alarms: off" is not representable: supervision thresholds are numbers with floors', () => {
    expect(codes({ ...minimal(), supervise: { leaseS: Infinity } })).toContain("schema");
    for (const [key, floor] of Object.entries(SUPERVISE_FLOORS)) {
      const belowValue = floor - (key === "overrunFactor" ? 0.2 : 1);
      const below = { ...minimal(), supervise: { [key]: belowValue } };
      // quietStrikes' floor is 1, so "below" is 0 — the schema layer itself
      // refuses it (positive int); every other floor is the linter's job
      const expected = belowValue <= 0 ? "schema" : "supervision_below_floor";
      expect(codes(below), key).toContain(expected);
      const at = { ...minimal(), supervise: { [key]: floor } };
      expect(lintFlowSpec(at).ok, key).toBe(true);
    }
  });

  it("relaxing supervision above the floor is allowed", () => {
    const result = lintFlowSpec({ ...minimal(), supervise: { leaseS: 300, quietStrikes: 5 } });
    expect(result.ok).toBe(true);
  });

  it("malformed efforts are refused per seat (cast validation)", () => {
    const spec = minimal();
    (spec.nodes.implement.cast as Record<string, unknown>).effort = "extreme";
    expect(codes(spec)).toContain("schema");
  });

  it("a fanout needs at least two arms", () => {
    expect(
      codes({
        version: 1,
        entry: "f",
        nodes: {
          f: {
            kind: "fanout",
            arms: [{ cast: { harness: "pi" } }],
            isolation: "worktree-each",
            join: "j",
          },
          j: { kind: "join", strategy: "all-merge", onPass: "done", onFail: "park" },
        },
      }),
    ).toContain("schema");
  });
});

describe("flow linter — graph shape", () => {
  it("refuses an entry that isn't a node", () => {
    expect(codes({ ...minimal(), entry: "nope" })).toContain("bad_entry");
  });

  it("refuses unknown edge targets", () => {
    expect(codes({ version: 1, entry: "a", nodes: { a: worker("ghost") } })).toContain(
      "unknown_edge_target",
    );
  });

  it('"done" is only a pass target and "park" only a fail target', () => {
    // onFail: "done" → "done" treated as an unknown node on the fail edge
    expect(codes({ version: 1, entry: "a", nodes: { a: worker("done", "done") } })).toContain(
      "unknown_edge_target",
    );
    expect(codes({ version: 1, entry: "a", nodes: { a: worker("park") } })).toContain(
      "unknown_edge_target",
    );
  });

  it("refuses reserved node ids", () => {
    expect(
      codes({ version: 1, entry: "done", nodes: { done: worker("done") } }),
    ).toContain("reserved_node_id");
  });

  it("refuses unreachable nodes", () => {
    const spec = {
      version: 1,
      entry: "a",
      nodes: { a: worker("done"), orphan: worker("done") },
    };
    expect(codes(spec)).toContain("unreachable_node");
  });

  it("refuses a fanout whose join is not a join node", () => {
    expect(
      codes({
        version: 1,
        entry: "f",
        nodes: {
          f: {
            kind: "fanout",
            arms: [{ cast: { harness: "pi" } }, { cast: { harness: "codex" } }],
            isolation: "worktree-each",
            join: "w",
          },
          w: worker("done"),
        },
      }),
    ).toContain("fanout_join_invalid");
  });

  it("refuses an orphaned join and a join shared by two fanouts", () => {
    expect(
      codes({
        version: 1,
        entry: "a",
        nodes: {
          a: worker("done"),
          j: { kind: "join", strategy: "all-merge", onPass: "done", onFail: "park" },
        },
      }),
    ).toEqual(expect.arrayContaining(["join_orphaned", "unreachable_node"]));

    const shared = {
      version: 1,
      entry: "f1",
      nodes: {
        f1: {
          kind: "fanout",
          arms: [{ cast: { harness: "pi" } }, { cast: { harness: "codex" } }],
          isolation: "worktree-each",
          join: "j",
        },
        f2: {
          kind: "fanout",
          arms: [{ cast: { harness: "pi" } }, { cast: { harness: "codex" } }],
          isolation: "worktree-each",
          join: "j",
        },
        j: { kind: "join", strategy: "all-merge", onPass: "f2", onFail: "park" },
      },
    };
    expect(codes(shared)).toContain("join_shared");
  });

  it("refuses edges that jump into a join from the side (arm escape)", () => {
    const spec = {
      version: 1,
      entry: "w",
      nodes: {
        w: worker("f", "j"), // fail edge escapes into the join directly
        f: {
          kind: "fanout",
          arms: [{ cast: { harness: "pi" } }, { cast: { harness: "codex" } }],
          isolation: "worktree-each",
          join: "j",
        },
        j: { kind: "join", strategy: "all-merge", onPass: "done", onFail: "park" },
      },
    };
    expect(codes(spec)).toContain("join_entered_directly");
  });

  it("quorum sanity: quorumK required, bounded by arm count, only on quorum joins", () => {
    const base = (join: Record<string, unknown>) => ({
      version: 1,
      entry: "f",
      nodes: {
        f: {
          kind: "fanout",
          arms: [{ cast: { harness: "pi" } }, { cast: { harness: "codex" } }],
          isolation: "shared",
          join: "j",
        },
        j: { onPass: "done", onFail: "park", ...join },
      },
    });
    expect(codes(base({ kind: "join", strategy: "quorum" }))).toContain("quorum_invalid");
    expect(codes(base({ kind: "join", strategy: "quorum", quorumK: 3 }))).toContain(
      "quorum_invalid",
    );
    expect(codes(base({ kind: "join", strategy: "all-merge", quorumK: 2 }))).toContain(
      "quorum_invalid",
    );
    expect(lintFlowSpec(base({ kind: "join", strategy: "quorum", quorumK: 2 })).ok).toBe(true);
  });

  it("cycles are accepted when cut by finite caps (they always are, by construction)", () => {
    const spec = {
      version: 1,
      entry: "implement",
      nodes: {
        implement: worker("review"),
        review: {
          kind: "gate",
          by: "human",
          onPass: "done",
          onFail: "implement", // the rework cycle
        },
      },
    };
    const result = lintFlowSpec(spec);
    expect(result.ok).toBe(true);
  });
});

describe("flow linter — budgets and cast doctrine", () => {
  it("refuses budget.maxConcurrent above the global max_workers", () => {
    const spec = { ...minimal(), budget: { maxConcurrent: 12 } };
    expect(codes(spec, { maxWorkers: 8 })).toContain("budget_insane");
    expect(lintFlowSpec(spec, { maxWorkers: 16 }).ok).toBe(true);
  });

  it("refuses blocked models", () => {
    const spec = minimal();
    (spec.nodes.implement.cast as Record<string, unknown>).model = "forbidden-model";
    expect(codes(spec, { blockedModels: ["forbidden-model"] })).toContain("cast_blocked");
  });

  it("a Fable seat anywhere triggers the confirm-before-cast handshake (§3.3)", () => {
    const spec = minimal();
    (spec.nodes.implement.cast as Record<string, unknown>).model = "claude-fable-5";
    const result = lintFlowSpec(spec);
    expect(result.ok).toBe(true);
    expect(result.requiresConfirm).toBe(true);
    expect(lintFlowSpec(minimal()).requiresConfirm).toBe(false);
  });

  it("mustLint throws with every issue listed", () => {
    expect(() => mustLint({ version: 1, entry: "ghost", nodes: { a: worker("ghost2") } })).toThrow(
      /bad_entry[\s\S]*unknown_edge_target|unknown_edge_target[\s\S]*bad_entry/,
    );
  });
});

describe("flow linter — the shipped presets all validate", () => {
  for (const [name, factory] of Object.entries({
    reviewedLifecycle: () => presets.reviewedLifecycle(),
    onePass: () => presets.onePass(),
    intDesignFlow: () => presets.intDesignFlow(),
    bakeOff: () => presets.bakeOff(),
    panelReview: () => presets.panelReview(),
  })) {
    it(`${name} passes the linter`, () => {
      const result = lintFlowSpec(factory(), { maxWorkers: 8 });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});
