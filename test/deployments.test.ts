/**
 * §7 — the three simulated deployments, asserted end to end. These run the
 * exact scenario code the runnable examples print, so the demonstrations
 * and the assertions can never drift apart.
 */
import { describe, expect, it } from "vitest";
import {
  deployFanoutFeature,
  deployFailureThatRecovers,
  deployOnePassFix,
} from "../examples/scenarios.js";

describe("§7.1 the one-pass fix", () => {
  it("lands with one seat, seven events, and only opening/closing announcements", async () => {
    const report = await deployOnePassFix();
    expect(report.run.status).toBe("done");
    expect(report.run.outcome).toBe("success");
    expect(Object.keys(report.run.seats)).toEqual(["implement#v1"]);
    expect(report.run.spend.usd).toBeCloseTo(0.35);
    expect(report.events.map((e) => e.type)).toEqual([
      "run_opened",
      "node_entered",
      "seat_spawned",
      "worker_ready",
      "signal_received",
      "edge_taken",
      "run_done",
    ]);
    // quiet run, quiet herald: no pages, exactly open + done on the channel
    const mine = report.rig.sink.announcements.filter((a) => a.ref === report.ref);
    expect(mine.filter((a) => a.severity === "page")).toHaveLength(0);
    expect(mine.map((a) => a.eventType)).toEqual(["run_opened", "run_done"]);
    // the journal narrates every event
    expect(report.journal).toHaveLength(report.events.length);
    // the worker was told exactly where it was and what was left to spend
    const seat = report.rig.adapter.seat("implement");
    expect(seat.request.manifest.budget.remainingUsd).toBe(2);
    expect(seat.request.manifest.flow).toMatchObject({ position: "implement", onPass: "done" });
  });
});

describe("§7.2 the fan-out feature", () => {
  it("forks from one base, holds the barrier, merges in declared order, reviews the joined diff", async () => {
    const report = await deployFanoutFeature();
    expect(report.run.status).toBe("done");
    // two arms + one reviewer = three seats
    expect(Object.keys(report.run.seats).sort()).toEqual([
      "review#v1",
      "split#v1#a0",
      "split#v1#a1",
    ]);
    // arm 1 finished first but merged second (declared order)
    const armJoins = report.events.filter((e) => e.type === "arm_joined");
    expect(armJoins.map((e) => (e as { arm: number }).arm)).toEqual([1, 0]);
    expect(report.rig.merger.merges.map((m) => m.branch)).toEqual([
      "beckett/task-OPS-158.arm-0",
      "beckett/task-OPS-158.arm-1",
    ]);
    const join = report.events.find((e) => e.type === "join_resolved");
    expect(join).toMatchObject({ strategy: "all-merge", outcome: "pass", mergeOrder: [0, 1] });
    // spend accounted per node: both arms under "split", reviewer under "review"
    expect(report.run.spend.byNode["split"]).toBeCloseTo(9.7);
    expect(report.run.spend.byNode["review"]).toBeCloseTo(1.2);
    expect(report.run.spend.usd).toBeCloseTo(10.9);
    // the gate verdict is in the log with its rubric score
    const gate = report.events.find((e) => e.type === "gate_decided");
    expect(gate).toMatchObject({ by: "model", verdict: "pass", rubricScore: 0.94 });
    // no pages — this deployment never went abnormal
    const mine = report.rig.sink.announcements.filter((a) => a.ref === report.ref);
    expect(mine.filter((a) => a.severity === "page")).toHaveLength(0);
  });
});

describe("§7.3 the failure that recovers", () => {
  it("stall → abort+retry → engine reboot re-staff → rework → done, all announced", async () => {
    const report = await deployFailureThatRecovers();
    expect(report.run.status).toBe("done");
    expect(report.run.outcome).toBe("success");

    const types = report.events.map((e) => e.type);
    // the nudge, the stall alarm, and the WIP checkpoint are all durable
    expect(types).toContain("nudge_delivered");
    expect(types).toContain("alarm_raised");
    expect(types).toContain("checkpoint_committed");

    // three attempts at visit 1 (silent, engine-crash, success) + rework visit 2
    const spawns = report.events.filter(
      (e) => e.type === "seat_spawned" && (e as { node: string }).node === "implement",
    );
    expect(spawns.map((e) => (e as { visit: number; attempt: number }).attempt)).toEqual([
      1, 2, 3, 1,
    ]);
    expect(spawns.map((e) => (e as { visit: number }).visit)).toEqual([1, 1, 1, 2]);

    // the stall alarm was raised exactly once and announced to a human surface
    const alarms = report.events.filter((e) => e.type === "alarm_raised");
    expect(alarms.map((e) => (e as { alarm: { type: string } }).alarm.type)).toContain("stall");
    const announced = report.rig.sink.announcements.filter((a) => a.ref === report.ref);
    expect(announced.map((a) => a.eventType)).toContain("alarm_raised");
    for (const a of announced) {
      expect(
        (Date.parse(a.deliveredAt) - Date.parse(a.eventAt)) / 1000,
        "≤60s human-surface invariant",
      ).toBeLessThanOrEqual(60);
    }

    // one review bounce recorded, then a pass
    const verdicts = report.events
      .filter((e) => e.type === "gate_decided")
      .map((e) => (e as { verdict: string }).verdict);
    expect(verdicts).toEqual(["fail", "pass"]);
    expect(report.run.visits["implement"]).toBe(2);

    // total spend survived the reboot because the log did
    expect(report.run.spend.usd).toBeCloseTo(3.2 + 0.9 + 1.1 + 0.8);
  });
});
