/**
 * §5.2 / §5.3 — how a stage runs and how loops terminate, at worker nodes:
 * pass/fail edges, the same-visit retry ladder, maxVisits parks, resume
 * grants, steering, pause/cancel.
 */
import { describe, expect, it } from "vitest";
import * as presets from "../src/presets.js";
import { eventTypes, makeRig } from "./helpers.js";

describe("worker nodes — edges", () => {
  it("complete takes onPass straight to done (one-pass work)", async () => {
    const rig = makeRig();
    await rig.engine.open("#1", presets.onePass(), { body: "tweak the README" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete({ spendUsd: 0.2 });
    const run = rig.engine.status("#1");
    expect(run.status).toBe("done");
    expect(run.outcome).toBe("success");
    expect(eventTypes(rig, "#1")).toEqual([
      "run_opened",
      "node_entered",
      "seat_spawned",
      "worker_ready",
      "signal_received",
      "edge_taken",
      "run_done",
    ]);
  });

  it("blocked takes onFail to park and hands the run to a human", async () => {
    const rig = makeRig();
    await rig.engine.open("#2", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.blocked("needs credentials");
    const run = rig.engine.status("#2");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("onfail_park");
    expect(run.parked?.detail).toContain("needs credentials");
    // a non-gate park pages the owner (§6.3)
    expect(rig.sink.pages().map((a) => a.eventType)).toContain("parked");
  });

  it("partial also takes onFail", async () => {
    const rig = makeRig();
    await rig.engine.open("#3", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.partial("got halfway");
    expect(rig.engine.status("#3").status).toBe("parked");
  });

  it("onFail can name a node instead of park", async () => {
    const rig = makeRig();
    const spec = {
      version: 1,
      entry: "try",
      nodes: {
        try: {
          kind: "worker",
          cast: { harness: "pi", effort: "low" },
          onPass: "done",
          onFail: "fallback",
        },
        fallback: {
          kind: "worker",
          cast: { harness: "claude", effort: "high" },
          onPass: "done",
          onFail: "park",
        },
      },
    };
    await rig.engine.open("#4", spec, { body: "b" });
    const first = rig.adapter.seat("try");
    await first.ready();
    await first.blocked("too hard for low effort");
    const fallback = rig.adapter.seat("fallback");
    await fallback.ready();
    await fallback.complete();
    expect(rig.engine.status("#4").status).toBe("done");
  });
});

describe("worker nodes — the same-visit retry ladder (crash/infra)", () => {
  it("a crash synthesizes the signal, burns a retry and re-staffs the same visit", async () => {
    const rig = makeRig();
    await rig.engine.open("#5", presets.onePass(), { body: "b" });
    const seat1 = rig.adapter.seat("implement", { attempt: 1 });
    await seat1.ready();
    await seat1.crash("OOM killed");
    // silent exit raises an alarm (§1.6 fixed) and re-staffs
    const run = rig.engine.status("#5");
    expect(run.status).toBe("running");
    const types = eventTypes(rig, "#5");
    expect(types).toContain("alarm_raised");
    expect(types.filter((t) => t === "seat_spawned")).toHaveLength(2);
    const seat2 = rig.adapter.seat("implement", { attempt: 2 });
    expect(seat2.request.visit).toBe(1); // same visit — retries are not rework
    await seat2.ready();
    await seat2.complete();
    expect(rig.engine.status("#5").status).toBe("done");
  });

  it("retries exhaust onto the fail edge with the ladder recorded", async () => {
    const rig = makeRig();
    const spec = presets.onePass();
    spec.nodes["implement"]!.retries = 2;
    await rig.engine.open("#6", spec, { body: "b" });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const seat = rig.adapter.seat("implement", { attempt });
      await seat.ready();
      await seat.crash(`crash ${attempt}`);
    }
    const run = rig.engine.status("#6");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("retries_exhausted");
    expect(rig.adapter.seatCount("implement")).toBe(3); // 1 + 2 retries
    const retryEdges = rig.engine.store
      .readEvents("#6")
      .filter((e) => e.type === "edge_taken" && e.why === "retry");
    expect(retryEdges).toHaveLength(2);
  });
});

describe("loops terminate — always, by construction (§5.3)", () => {
  it("rework loops park when maxVisits exhausts, with the pending edge recorded", async () => {
    const rig = makeRig();
    await rig.engine.open("#7", presets.reviewedLifecycle(), { body: "b" });
    // three full implement→review(fail) cycles
    for (let visit = 1; visit <= 3; visit++) {
      const seat = rig.adapter.seat("implement", { visit });
      await seat.ready();
      await seat.complete();
      const run = rig.engine.status("#7");
      if (run.status === "parked") break;
      const review = rig.adapter.seat("review", { visit });
      await review.ready();
      await review.complete({ data: { pass: false }, summary: `changes requested ${visit}` });
    }
    const run = rig.engine.status("#7");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("max_visits_exhausted");
    expect(run.parked?.node).toBe("implement");
    expect(run.parked?.pendingEdge).toEqual({ to: "implement" });
    expect(run.visits["implement"]).toBe(3);
    expect(run.gateFails["review"]).toBe(3);
  });

  it("a resume grant of extra visits re-arms the pending edge (§5.3)", async () => {
    const rig = makeRig();
    await rig.engine.open("#8", presets.reviewedLifecycle(), { body: "b" });
    for (let visit = 1; visit <= 3; visit++) {
      const seat = rig.adapter.seat("implement", { visit });
      await seat.ready();
      await seat.complete();
      if (rig.engine.status("#8").status === "parked") break;
      const review = rig.adapter.seat("review", { visit });
      await review.ready();
      await review.complete({ data: { pass: false } });
    }
    expect(rig.engine.status("#8").status).toBe("parked");
    await rig.engine.resume("#8", { extraVisits: 1 });
    const run = rig.engine.status("#8");
    expect(run.status).toBe("running");
    expect(run.visits["implement"]).toBe(4);
    const seat = rig.adapter.seat("implement", { visit: 4 });
    await seat.ready();
    await seat.complete();
    // grants are per-node: the review gate's own cap now exhausts too, and
    // parks with its own pending edge — each cap needs its own authority
    let after = rig.engine.status("#8");
    expect(after.status).toBe("parked");
    expect(after.parked?.node).toBe("review");
    await rig.engine.resume("#8", { extraVisits: 1 });
    const review = rig.adapter.seat("review", { visit: 4 });
    await review.ready();
    await review.complete({ data: { pass: true } });
    expect(rig.engine.status("#8").status).toBe("done");
  });
});

describe("steering (§5.5)", () => {
  it("delivers to the live worker with a receipt", async () => {
    const rig = makeRig();
    await rig.engine.open("#10", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    const receipt = rig.engine.nudge("#10", "prefer the small fix", "implement");
    expect(receipt.receipt).toBe("delivered");
    expect(seat.nudges).toContain("prefer the small fix");
    const events = rig.engine.store.readEvents("#10");
    const nudge = events.find((e) => e.type === "nudge_delivered");
    expect(nudge).toMatchObject({ receipt: "delivered", target: "implement#v1" });
  });

  it("buffers when nothing is live and folds into the next seat's brief", async () => {
    const rig = makeRig();
    await rig.engine.open("#11", presets.reviewedLifecycle(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    // review seat is live now; kill it via crash so nothing is live... no:
    // simpler — nudge targeted at the *implement* node, which has no live seat
    const receipt = rig.engine.nudge("#11", "when you rework, use approach B", "implement");
    expect(receipt.receipt).toBe("queued");
    const review = rig.adapter.seat("review");
    await review.ready();
    await review.complete({ data: { pass: false } });
    // the rework seat's brief carries the buffered steer
    const rework = rig.adapter.seat("implement", { visit: 2 });
    expect(rework.request.briefParts.steers.map((s) => s.text)).toContain(
      "when you rework, use approach B",
    );
    // and the buffer drained
    expect(rig.engine.status("#11").pendingSteers).toHaveLength(0);
  });
});

describe("pause / resume / cancel", () => {
  it("pause parks, commits WIP, kills the seat; resume re-staffs the same visit", async () => {
    const rig = makeRig();
    await rig.engine.open("#12", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.turn();
    await rig.engine.pause("#12");
    expect(seat.aborted?.reason).toContain("pause");
    let run = rig.engine.status("#12");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("operator_pause");
    expect(eventTypes(rig, "#12")).toContain("checkpoint_committed"); // WIP committed on abort

    await rig.engine.resume("#12");
    run = rig.engine.status("#12");
    expect(run.status).toBe("running");
    const seat2 = rig.adapter.seat("implement", { attempt: 2 });
    expect(seat2.request.visit).toBe(1);
    await seat2.ready();
    await seat2.complete();
    expect(rig.engine.status("#12").status).toBe("done");
  });

  it("cancel aborts all cursors and is terminal", async () => {
    const rig = makeRig();
    await rig.engine.open("#13", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await rig.engine.cancel("#13", "superseded");
    const run = rig.engine.status("#13");
    expect(run.status).toBe("cancelled");
    expect(run.cursors).toHaveLength(0);
    expect(seat.aborted).toBeTruthy();
    await expect(rig.engine.cancel("#13")).rejects.toThrow(/already cancelled/);
    await expect(rig.engine.resume("#13")).rejects.toThrow(/not parked/);
  });

  it("resume refuses a run that isn't parked; open refuses a duplicate ref", async () => {
    const rig = makeRig();
    await rig.engine.open("#14", presets.onePass(), { body: "b" });
    await expect(rig.engine.resume("#14")).rejects.toThrow(/not parked/);
    await expect(rig.engine.open("#14", presets.onePass())).rejects.toThrow(/already exists/);
  });
});

describe("artifacts and briefs", () => {
  it("later seats receive prior stages' artifacts and the node brief", async () => {
    const rig = makeRig();
    const spec = presets.intDesignFlow();
    (spec.nodes["implement"] as { brief?: string }).brief = "implement exactly the design doc";
    await rig.engine.open("#15", spec, { body: "the task", criteria: ["works"] });
    const design = rig.adapter.seat("design");
    await design.ready();
    await design.complete();
    const check = rig.adapter.seat("design_check");
    // the gate seat carries the rubric
    expect(check.request.briefParts.rubric).toBe("design-completeness");
    await check.ready();
    await check.complete({ data: { pass: true } });
    await rig.engine.resume("#15", { gate: { node: "design_review", verdict: "pass" } });
    const impl = rig.adapter.seat("implement");
    expect(impl.request.briefParts.body).toBe("the task");
    expect(impl.request.briefParts.criteria).toEqual(["works"]);
    expect(impl.request.briefParts.nodeBrief).toBe("implement exactly the design doc");
    expect(impl.request.briefParts.priorArtifacts).toEqual([
      { path: "docs/design/design.md", fromNode: "design" },
    ]);
  });
});
