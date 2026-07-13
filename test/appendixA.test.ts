/**
 * Appendix A — byte-for-byte behavioural equivalence at cutover: the OPS
 * and INT lifecycles, expressed as flow specs, walk the same stages in the
 * same order with the same caps as the compiled-in dispatcher (§1.1–§1.3).
 */
import { describe, expect, it } from "vitest";
import * as presets from "../src/presets.js";
import { makeRig } from "./helpers.js";
import type { RunEvent } from "../src/run/events.js";

/** The stage trail: node_entered order, the legacy board columns in disguise. */
function trail(events: RunEvent[]): string[] {
  return events
    .filter((e): e is Extract<RunEvent, { type: "node_entered" }> => e.type === "node_entered")
    .map((e) => `${e.node}#${e.visit}`);
}

describe("OPS reviewed lifecycle (todo → in_progress → in_review → done)", () => {
  it("happy path: implement → review → done, one seat each", async () => {
    const rig = makeRig();
    await rig.engine.open("#a1", presets.reviewedLifecycle(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    const review = rig.adapter.seat("review");
    await review.ready();
    await review.complete({ data: { pass: true } });
    expect(trail(rig.engine.store.readEvents("#a1"))).toEqual(["implement#1", "review#1"]);
    expect(rig.engine.status("#a1").status).toBe("done");
  });

  it("the rework loop honours MAX_REWORK_CYCLES = 3 then parks for a human (§1.3)", async () => {
    const rig = makeRig();
    await rig.engine.open("#a2", presets.reviewedLifecycle(), { body: "b" });
    for (let cycle = 1; cycle <= 3; cycle++) {
      const seat = rig.adapter.seat("implement", { visit: cycle });
      await seat.ready();
      await seat.complete();
      if (rig.engine.status("#a2").status !== "running") break;
      const review = rig.adapter.seat("review", { visit: cycle });
      await review.ready();
      await review.complete({ data: { pass: false } });
    }
    const run = rig.engine.status("#a2");
    expect(run.status).toBe("parked");
    // exactly three implement seats and three review bounces, like today
    expect(trail(rig.engine.store.readEvents("#a2"))).toEqual([
      "implement#1",
      "review#1",
      "implement#2",
      "review#2",
      "implement#3",
      "review#3",
    ]);
  });

  it("implement crash retries honour MAX_IMPLEMENT_RETRIES = 3 (§1.3)", async () => {
    const rig = makeRig();
    await rig.engine.open("#a3", presets.reviewedLifecycle(), { body: "b" });
    for (let attempt = 1; attempt <= 4; attempt++) {
      const seat = rig.adapter.seat("implement", { attempt });
      await seat.ready();
      await seat.crash(`crash ${attempt}`);
    }
    // 1 first try + 3 retries, all visit 1, then park (WIP published today)
    expect(rig.adapter.seatCount("implement")).toBe(4);
    expect(rig.engine.status("#a3").parked?.reason).toBe("retries_exhausted");
  });
});

describe("one-pass work (effort low/medium → review tier self)", () => {
  it("is the same spec minus the gate: implement → done", async () => {
    const rig = makeRig();
    await rig.engine.open("#a4", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    expect(trail(rig.engine.store.readEvents("#a4"))).toEqual(["implement#1"]);
    expect(rig.engine.status("#a4").status).toBe("done");
    expect(rig.adapter.seatCount()).toBe(1); // exactly one seat, zero reviewers
  });
});

describe("INT design flow (design → design_review → in_progress → …)", () => {
  it("walks design → design_check → design_review(human) → implement → review → done", async () => {
    const rig = makeRig();
    await rig.engine.open("#a5", presets.intDesignFlow(), { body: "b" });
    const design = rig.adapter.seat("design");
    await design.ready();
    await design.complete();
    // design_check is the Haiku/low pseudo-stage, now a first-class gate
    const check = rig.adapter.seat("design_check");
    expect(check.request.cast.model).toContain("haiku");
    expect(check.request.cast.effort).toBe("low");
    await check.ready();
    await check.complete({ data: { pass: true } });
    // design_review is the human approval gate: parked, no seat
    expect(rig.engine.status("#a5").parked?.node).toBe("design_review");
    await rig.engine.decideHumanGate("#a5", "design_review", "pass");
    const impl = rig.adapter.seat("implement");
    await impl.ready();
    await impl.complete();
    const review = rig.adapter.seat("review");
    await review.ready();
    await review.complete({ data: { pass: true } });
    expect(trail(rig.engine.store.readEvents("#a5"))).toEqual([
      "design#1",
      "design_check#1",
      "design_review#1",
      "implement#1",
      "review#1",
    ]);
    expect(rig.engine.status("#a5").status).toBe("done");
  });

  it("design ↔ completeness check honours MAX_DESIGN_CYCLES = 2 then parks with a ⚠ (§1.3)", async () => {
    const rig = makeRig();
    await rig.engine.open("#a6", presets.intDesignFlow(), { body: "b" });
    for (let visit = 1; visit <= 3; visit++) {
      const design = rig.adapter.seat("design", { visit });
      await design.ready();
      await design.complete();
      if (rig.engine.status("#a6").status !== "running") break;
      const check = rig.adapter.seat("design_check", { visit });
      await check.ready();
      await check.complete({ data: { pass: false }, summary: "incomplete" });
    }
    const run = rig.engine.status("#a6");
    expect(run.status).toBe("parked");
    // two bounces allowed; the third fail exhausts the gate → human attention
    expect(run.parked?.reason).toBe("gate_fails_exhausted");
    expect(run.parked?.node).toBe("design_check");
    expect(run.gateFails["design_check"]).toBe(3);
  });
});

describe("compileFromCast — a filing with no beckett-flow block never breaks (§3.2)", () => {
  it("low/medium effort compiles to the self tier (one pass)", () => {
    for (const effort of ["low", "medium"] as const) {
      const spec = presets.compileFromCast({ harness: "pi", effort });
      expect(Object.keys(spec.nodes)).toEqual(["implement"]);
      expect(spec.nodes["implement"]).toMatchObject({ onPass: "done" });
    }
  });
  it("high/xhigh/unset compiles to a fresh adversarial review", () => {
    for (const effort of ["high", "xhigh", undefined] as const) {
      const spec = presets.compileFromCast({ harness: "pi", ...(effort ? { effort } : {}) });
      expect(Object.keys(spec.nodes)).toEqual(["implement", "review"]);
      expect(spec.nodes["implement"]).toMatchObject({ onPass: "review", maxVisits: 3 });
    }
  });
  it("an explicit reviewTier field overrides, as today (§1.2)", () => {
    const spec = presets.compileFromCast({ harness: "pi", effort: "xhigh" }, "self");
    expect(Object.keys(spec.nodes)).toEqual(["implement"]);
  });
});
