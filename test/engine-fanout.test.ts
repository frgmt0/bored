/**
 * §5.4 — how parallel branches run and join: all four join strategies, the
 * silent arm, and the half-merged join.
 */
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/run/events.js";
import { makeRig } from "./helpers.js";

function fanoutSpec(join: Record<string, unknown>, arms = 2, retries = 2) {
  const armList = Array.from({ length: arms }, (_, i) => ({
    cast: { harness: i % 2 ? "codex" : "pi", effort: "high" as const },
    brief: `arm ${i}`,
  }));
  return {
    version: 1,
    entry: "fan",
    nodes: {
      fan: {
        kind: "fanout",
        arms: armList,
        isolation: "worktree-each",
        join: "join",
        retries,
      },
      join: { onPass: "wrap", onFail: "park", ...join },
      wrap: {
        kind: "worker",
        cast: { harness: "pi", effort: "low" },
        onPass: "done",
        onFail: "park",
      },
    },
  };
}

describe("fanout mechanics", () => {
  it("forks one isolated worktree/branch per arm from the same captured base", async () => {
    const rig = makeRig();
    await rig.engine.open("#f1", fanoutSpec({ kind: "join", strategy: "all-merge" }), { body: "b" });
    const arm0 = rig.adapter.seat("fan", { arm: 0 });
    const arm1 = rig.adapter.seat("fan", { arm: 1 });
    expect(arm0.request.branch).toMatch(/\.arm-0$/);
    expect(arm1.request.branch).toMatch(/\.arm-1$/);
    expect(arm0.request.worktree).not.toBe(arm1.request.worktree);
    expect(arm0.request.baseSha).toBe(arm1.request.baseSha); // same base F0 (§5.4, Fig 6)
    expect(arm0.request.briefParts.nodeBrief).toBe("arm 0");
    expect(arm1.request.briefParts.nodeBrief).toBe("arm 1");
    // two concurrent cursors between fanout and join
    expect(rig.engine.status("#f1").cursors).toHaveLength(2);
  });

  it("shared isolation reuses the task worktree (read-only scouts)", async () => {
    const rig = makeRig();
    const spec = fanoutSpec({ kind: "join", strategy: "quorum", quorumK: 2 });
    (spec.nodes.fan as { isolation: string }).isolation = "shared";
    await rig.engine.open("#f2", spec, { body: "b" });
    const arm0 = rig.adapter.seat("fan", { arm: 0 });
    const arm1 = rig.adapter.seat("fan", { arm: 1 });
    expect(arm0.request.worktree).toBe(arm1.request.worktree);
    expect(arm0.request.branch).toBe(arm1.request.branch);
  });
});

describe("all-merge", () => {
  it("waits for every arm, merges in arm order, records each merge as its own event", async () => {
    const rig = makeRig();
    await rig.engine.open("#f3", fanoutSpec({ kind: "join", strategy: "all-merge" }), { body: "b" });
    const arm1 = rig.adapter.seat("fan", { arm: 1 });
    await arm1.ready();
    await arm1.complete({ summary: "ui done" }); // slow arm order reversed on purpose
    // barrier holds: arm 0 still live
    expect(rig.engine.status("#f3").joins["join"]?.resolved).toBeUndefined();
    const arm0 = rig.adapter.seat("fan", { arm: 0 });
    await arm0.ready();
    await arm0.complete({ summary: "api done" });

    const run = rig.engine.status("#f3");
    expect(run.joins["join"]?.resolved).toBe("pass");
    // merged in declared arm order 0 then 1, regardless of finish order
    expect(rig.merger.merges.map((m) => m.branch)).toEqual([
      "beckett/task-f3.arm-0",
      "beckett/task-f3.arm-1",
    ]);
    const events = rig.engine.store.readEvents("#f3");
    const mergeNotes = events
      .filter((e): e is Extract<RunEvent, { type: "checkpoint_committed" }> => e.type === "checkpoint_committed")
      .map((e) => e.note);
    expect(mergeNotes).toEqual([
      expect.stringContaining("merged arm 0"),
      expect.stringContaining("merged arm 1"),
    ]);
    const resolved = events.find((e) => e.type === "join_resolved");
    expect(resolved).toMatchObject({ strategy: "all-merge", outcome: "pass", mergeOrder: [0, 1] });
    // the run then proceeds through the wrap node
    const wrap = rig.adapter.seat("wrap");
    await wrap.ready();
    await wrap.complete();
    expect(rig.engine.status("#f3").status).toBe("done");
  });

  it("fails fast: an arm's real failure aborts the sibling and fails the join", async () => {
    const rig = makeRig();
    await rig.engine.open("#f4", fanoutSpec({ kind: "join", strategy: "all-merge" }), { body: "b" });
    const arm0 = rig.adapter.seat("fan", { arm: 0 });
    const arm1 = rig.adapter.seat("fan", { arm: 1 });
    await arm0.ready();
    await arm1.ready();
    await arm0.blocked("API design not possible");
    expect(arm1.aborted).toBeTruthy(); // sibling reaped
    const run = rig.engine.status("#f4");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("join_failed");
    const resolved = rig.engine.store.readEvents("#f4").find((e) => e.type === "join_resolved");
    expect(resolved).toMatchObject({ outcome: "fail" });
    expect((resolved as { reason?: string }).reason).toContain("arm 0 failed");
  });

  it("the half-merged join: a conflict parks with the conflicting arm named and the branch at the last clean merge", async () => {
    const rig = makeRig();
    await rig.engine.open("#f5", fanoutSpec({ kind: "join", strategy: "all-merge" }), { body: "b" });
    rig.merger.failOn("beckett/task-f5.arm-1");
    for (const arm of [0, 1]) {
      const seat = rig.adapter.seat("fan", { arm });
      await seat.ready();
      await seat.complete();
    }
    const run = rig.engine.status("#f5");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("join_conflict");
    expect(run.parked?.detail).toContain("arm 1");
    // arm 0 merged cleanly and stays merged — nothing force-pushed
    expect(rig.merger.merges.map((m) => m.branch)).toEqual(["beckett/task-f5.arm-0"]);
    const resolved = rig.engine.store.readEvents("#f5").find((e) => e.type === "join_resolved");
    expect(resolved).toMatchObject({ outcome: "fail", mergeOrder: [0] });
  });
});

describe("first", () => {
  it("first complete wins; the engine aborts the rest and merges the winner", async () => {
    const rig = makeRig();
    await rig.engine.open("#f6", fanoutSpec({ kind: "join", strategy: "first" }), { body: "b" });
    const arm0 = rig.adapter.seat("fan", { arm: 0 });
    const arm1 = rig.adapter.seat("fan", { arm: 1 });
    await arm0.ready();
    await arm1.ready();
    await arm1.complete({ summary: "fast path found" });
    expect(arm0.aborted?.reason).toContain("finished first");
    const resolved = rig.engine.store.readEvents("#f6").find((e) => e.type === "join_resolved");
    expect(resolved).toMatchObject({ strategy: "first", outcome: "pass", winner: 1 });
    expect(rig.merger.merges.map((m) => m.branch)).toEqual(["beckett/task-f6.arm-1"]);
    expect(rig.engine.status("#f6").status).toBe("running"); // moved on to wrap
  });

  it("all arms failing fails the join", async () => {
    const rig = makeRig();
    await rig.engine.open("#f7", fanoutSpec({ kind: "join", strategy: "first" }, 2, 0), {
      body: "b",
    }); // retries: 0 — one shot per arm, now representable (§2.2)
    for (const arm of [0, 1]) {
      const seat = rig.adapter.seat("fan", { arm });
      await seat.ready();
      await seat.blocked(`arm ${arm} stuck`);
    }
    const run = rig.engine.status("#f7");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("join_failed");
  });
});

describe("quorum", () => {
  it("passes when k arms complete, aborting stragglers, with votes recorded", async () => {
    const rig = makeRig();
    await rig.engine.open(
      "#f8",
      fanoutSpec({ kind: "join", strategy: "quorum", quorumK: 2 }, 3),
      { body: "b" },
    );
    const seats = [0, 1, 2].map((arm) => rig.adapter.seat("fan", { arm }));
    for (const s of seats) await s.ready();
    await seats[0]!.complete();
    await seats[1]!.complete();
    expect(seats[2]!.aborted?.reason).toContain("quorum");
    const resolved = rig.engine.store.readEvents("#f8").find((e) => e.type === "join_resolved");
    expect(resolved).toMatchObject({ strategy: "quorum", outcome: "pass" });
    expect((resolved as { votes?: unknown[] }).votes).toHaveLength(2);
  });

  it("fails as soon as the quorum is impossible", async () => {
    const rig = makeRig();
    await rig.engine.open(
      "#f9",
      fanoutSpec({ kind: "join", strategy: "quorum", quorumK: 3 }, 3, 0),
      { body: "b" },
    );
    const s0 = rig.adapter.seat("fan", { arm: 0 });
    await s0.ready();
    await s0.blocked("reject"); // 1 fail of 3 with k=3 → impossible
    const run = rig.engine.status("#f9");
    expect(run.status).toBe("parked");
    expect(run.parked?.detail).toContain("impossible");
  });
});

describe("judge", () => {
  it("waits for all arms, spawns the judge cast with the arms' summaries, merges the named winner", async () => {
    const rig = makeRig();
    await rig.engine.open(
      "#f10",
      fanoutSpec({ kind: "join", strategy: { judge: { harness: "claude", model: "claude-fable-5", effort: "high" } } }),
      { body: "b" },
    );
    for (const arm of [0, 1]) {
      const seat = rig.adapter.seat("fan", { arm });
      await seat.ready();
      await seat.complete({ summary: `candidate ${arm}` });
    }
    const judge = rig.adapter.seat("join");
    expect(judge.request.cast.model).toBe("claude-fable-5");
    await judge.ready();
    await judge.complete({ data: { winner: 1 }, summary: "candidate 1 is cleaner" });
    const resolved = rig.engine.store.readEvents("#f10").find((e) => e.type === "join_resolved");
    expect(resolved).toMatchObject({ strategy: "judge", outcome: "pass", winner: 1 });
    expect(rig.merger.merges.map((m) => m.branch)).toEqual(["beckett/task-f10.arm-1"]);
  });

  it("a judge that names no winner (synthesis request) takes onFail", async () => {
    const rig = makeRig();
    await rig.engine.open(
      "#f11",
      fanoutSpec({ kind: "join", strategy: { judge: { harness: "claude", effort: "high" } } }),
      { body: "b" },
    );
    for (const arm of [0, 1]) {
      const seat = rig.adapter.seat("fan", { arm });
      await seat.ready();
      await seat.complete();
    }
    const judge = rig.adapter.seat("join");
    await judge.ready();
    await judge.complete({ data: { synthesis: true }, summary: "both halves are good; combine" });
    const run = rig.engine.status("#f11");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("join_failed");
    const resolved = rig.engine.store.readEvents("#f11").find((e) => e.type === "join_resolved");
    expect((resolved as { reason?: string }).reason).toContain("synthesis");
  });
});

describe("the silent arm (§5.4)", () => {
  it("a crashing arm burns its retries then enters the join as failed — a join waits, never quietly", async () => {
    const rig = makeRig();
    await rig.engine.open("#f12", fanoutSpec({ kind: "join", strategy: "all-merge" }, 2, 1), {
      body: "b",
    });
    const arm0a = rig.adapter.seat("fan", { arm: 0, attempt: 1 });
    await arm0a.ready();
    await arm0a.crash("segfault");
    // retry ladder ran: a second seat for the same arm, same visit
    const arm0b = rig.adapter.seat("fan", { arm: 0, attempt: 2 });
    expect(arm0b.request.visit).toBe(1);
    await arm0b.ready();
    await arm0b.crash("segfault again"); // retries (1) exhausted
    // the arm entered the join as failed; all-merge fails fast; sibling aborted
    const run = rig.engine.status("#f12");
    expect(run.status).toBe("parked");
    const armJoined = rig.engine.store
      .readEvents("#f12")
      .filter((e) => e.type === "arm_joined");
    expect(armJoined.some((e) => (e as { arm: number; status: string }).arm === 0 && (e as { status: string }).status === "failed")).toBe(true);
    // and the silent exits were alarmed, not swallowed
    expect(rig.sink.byType("alarm_raised").length).toBeGreaterThan(0);
  });
});
