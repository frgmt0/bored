/**
 * Gate nodes — human gates (PARKED: no worker, zero tokens, restart-inert)
 * and model gates (LIVE: the cheap check, generalising design_check).
 */
import { describe, expect, it } from "vitest";
import * as presets from "../src/presets.js";
import { eventTypes, makeRig } from "./helpers.js";

const humanGateSpec = () => ({
  version: 1,
  entry: "implement",
  nodes: {
    implement: {
      kind: "worker",
      cast: { harness: "pi", effort: "high" },
      onPass: "approve",
      onFail: "park",
    },
    approve: {
      kind: "gate",
      by: "human",
      onPass: "done",
      onFail: "implement",
      maxFails: 2,
    },
  },
});

describe("human gates", () => {
  it("enter PARKED directly — no seat, no lease — and the Herald pings the origin channel", async () => {
    const rig = makeRig();
    await rig.engine.open("#g1", humanGateSpec(), { body: "b", originChannel: "chan:vid" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    const run = rig.engine.status("#g1");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("human_gate");
    expect(run.parked?.node).toBe("approve");
    // zero tokens: no seat was spawned for the gate
    expect(rig.adapter.seatCount("approve")).toBe(0);
    expect(Object.keys(run.leases)).toHaveLength(0);
    // a human-gate park is a status ping on the origin channel, not a page
    const parkAnnouncements = rig.sink.byType("parked");
    expect(parkAnnouncements).toHaveLength(1);
    expect(parkAnnouncements[0]).toMatchObject({ severity: "status", target: "chan:vid" });
  });

  it("a human pass verdict moves the run on (gate_decided by:human)", async () => {
    const rig = makeRig();
    await rig.engine.open("#g2", humanGateSpec(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    await rig.engine.decideHumanGate("#g2", "approve", "pass", "ship it");
    const run = rig.engine.status("#g2");
    expect(run.status).toBe("done");
    const decided = rig.engine.store
      .readEvents("#g2")
      .find((e) => e.type === "gate_decided");
    expect(decided).toMatchObject({ by: "human", verdict: "pass", note: "ship it" });
  });

  it("a human fail verdict takes onFail back into rework", async () => {
    const rig = makeRig();
    await rig.engine.open("#g3", humanGateSpec(), { body: "b" });
    let seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    await rig.engine.decideHumanGate("#g3", "approve", "fail", "wrong direction");
    let run = rig.engine.status("#g3");
    expect(run.status).toBe("running");
    expect(run.visits["implement"]).toBe(2);
    seat = rig.adapter.seat("implement", { visit: 2 });
    await seat.ready();
    await seat.complete();
    // parked at the gate again — the loop is bounded by the gate's maxFails
    run = rig.engine.status("#g3");
    expect(run.parked?.reason).toBe("human_gate");
  });

  it("resume without a verdict at a human gate is refused", async () => {
    const rig = makeRig();
    await rig.engine.open("#g4", humanGateSpec(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    await expect(rig.engine.resume("#g4")).rejects.toThrow(/requires grant.gate/);
  });

  it("human gates are restart-inert: recovery leaves them parked", async () => {
    const rig = makeRig();
    await rig.engine.open("#g5", humanGateSpec(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    expect(rig.engine.status("#g5").status).toBe("parked");
    const before = eventTypes(rig, "#g5").length;
    await rig.engine.recover("#g5");
    expect(rig.engine.status("#g5").status).toBe("parked");
    expect(eventTypes(rig, "#g5")).toHaveLength(before); // nothing appended
  });
});

describe("model gates", () => {
  it("a complete/pass verdict takes onPass; the rubric rides in the brief", async () => {
    const rig = makeRig();
    await rig.engine.open("#g6", presets.reviewedLifecycle(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    const review = rig.adapter.seat("review");
    expect(review.request.briefParts.rubric).toBe("criteria-vs-diff");
    await review.ready();
    await review.complete({ data: { pass: true, rubricScore: 0.92 } });
    expect(rig.engine.status("#g6").status).toBe("done");
    const decided = rig.engine.store.readEvents("#g6").find((e) => e.type === "gate_decided");
    expect(decided).toMatchObject({ by: "model", verdict: "pass", rubricScore: 0.92 });
  });

  it("verdict defaults to the done-signal status when no data.pass is present", async () => {
    const rig = makeRig();
    await rig.engine.open("#g7", presets.reviewedLifecycle(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    const review = rig.adapter.seat("review");
    await review.ready();
    await review.partial("could not finish the review"); // partial → fail verdict
    const run = rig.engine.status("#g7");
    expect(run.gateFails["review"]).toBe(1);
    expect(run.visits["implement"]).toBe(2); // bounced back into rework
  });

  it("gate maxFails exhaustion parks even before node caps (§5.3)", async () => {
    const rig = makeRig();
    const spec = {
      version: 1,
      entry: "implement",
      nodes: {
        implement: {
          kind: "worker",
          cast: { harness: "pi", effort: "high" },
          onPass: "check",
          onFail: "park",
          maxVisits: 10,
        },
        check: {
          kind: "gate",
          by: { cast: { harness: "claude", effort: "low" }, rubric: "r" },
          onPass: "done",
          onFail: "implement",
          maxFails: 1,
          maxVisits: 10,
        },
      },
    };
    await rig.engine.open("#g8", spec, { body: "b" });
    for (let visit = 1; visit <= 2; visit++) {
      const seat = rig.adapter.seat("implement", { visit });
      await seat.ready();
      await seat.complete();
      const check = rig.adapter.seat("check", { visit });
      await check.ready();
      await check.complete({ data: { pass: false } });
    }
    const run = rig.engine.status("#g8");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("gate_fails_exhausted");
    expect(run.parked?.node).toBe("check");
    expect(run.gateFails["check"]).toBe(2);
  });

  it("gate infra failure runs the same-visit retry ladder (MAX_REVIEW_INFRA_RETRIES generalised)", async () => {
    const rig = makeRig();
    await rig.engine.open("#g9", presets.reviewedLifecycle(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    const review1 = rig.adapter.seat("review", { attempt: 1 });
    await review1.ready();
    await review1.crash("rate limited");
    const review2 = rig.adapter.seat("review", { attempt: 2 });
    expect(review2.request.visit).toBe(1);
    await review2.ready();
    await review2.complete({ data: { pass: true } });
    expect(rig.engine.status("#g9").status).toBe("done");
  });
});
