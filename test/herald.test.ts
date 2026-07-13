/**
 * §6.3 — the Herald: every run event is classified trace/status/page;
 * every abnormal event reaches a human surface within sixty seconds; a
 * page never refers to state that didn't commit.
 */
import { describe, expect, it } from "vitest";
import { classifyEvent } from "../src/engine/herald.js";
import type { RunEvent } from "../src/run/events.js";
import * as presets from "../src/presets.js";
import { makeRig } from "./helpers.js";

const stub = (partial: Record<string, unknown>): RunEvent =>
  ({ seq: 1, at: "2026-07-13T00:00:00.000Z", ...partial }) as unknown as RunEvent;

describe("classification table", () => {
  it("routes the narrating events to trace", () => {
    for (const type of [
      "node_entered",
      "seat_spawned",
      "worker_ready",
      "progress_noted",
      "checkpoint_committed",
      "edge_taken",
      "nudge_delivered",
      "arm_joined",
    ]) {
      expect(classifyEvent(stub({ type })), type).toBe("trace");
    }
    expect(classifyEvent(stub({ type: "signal_received", subtype: "done_signal" }))).toBe("trace");
  });

  it("routes state changes to status", () => {
    for (const type of [
      "run_opened",
      "gate_decided",
      "join_resolved",
      "resumed",
      "alarm_raised",
      "alarm_cleared",
      "run_done",
      "run_cancelled",
    ]) {
      expect(classifyEvent(stub({ type })), type).toBe("status");
    }
    expect(classifyEvent(stub({ type: "parked", reason: "human_gate" }))).toBe("status");
    expect(classifyEvent(stub({ type: "signal_received", subtype: "synthesized_stall" }))).toBe(
      "status",
    );
  });

  it("routes abnormal-stop events to page", () => {
    expect(classifyEvent(stub({ type: "parked", reason: "retries_exhausted" }))).toBe("page");
    expect(classifyEvent(stub({ type: "parked", reason: "join_conflict" }))).toBe("page");
    expect(classifyEvent(stub({ type: "budget_hit" }))).toBe("page");
    expect(classifyEvent(stub({ type: "worker_refused" }))).toBe("page");
    expect(
      classifyEvent(stub({ type: "signal_received", subtype: "synthesized_wall_clock_cap" })),
    ).toBe("page");
  });
});

describe("the ≤60s human-surface invariant (§6)", () => {
  it("every abnormal event in a failing run is announced within 60s of its append", async () => {
    const rig = makeRig();
    const spec = presets.onePass();
    spec.nodes["implement"]!.retries = 1;
    await rig.engine.open("#h1", spec, { body: "b", originChannel: "chan:ops" });
    // a run that exercises alarms, refusals, and a park:
    const s1 = rig.adapter.seat("implement", { attempt: 1 });
    await s1.readyWith({ observedSha: "wrong" }); // worker_refused → retry
    const s2 = rig.adapter.seat("implement", { attempt: 2 });
    await s2.ready();
    await s2.crash("OOM"); // silent exit → retries exhausted → park
    const run = rig.engine.status("#h1");
    expect(run.status).toBe("parked");

    const abnormalTypes = new Set(["alarm_raised", "worker_refused", "parked", "budget_hit"]);
    const abnormal = rig.engine.store
      .readEvents("#h1")
      .filter((e) => abnormalTypes.has(e.type));
    expect(abnormal.length).toBeGreaterThanOrEqual(3);
    for (const ev of abnormal) {
      const announced = rig.sink.announcements.find((a) => a.eventSeq === ev.seq);
      expect(announced, `${ev.type} seq ${ev.seq} must be announced`).toBeTruthy();
      const latency =
        (Date.parse(announced!.deliveredAt) - Date.parse(announced!.eventAt)) / 1000;
      expect(latency).toBeLessThanOrEqual(60);
      // announcement is after the fsync'd append: the event is on disk
      expect(announced!.eventSeq).toBeLessThanOrEqual(rig.engine.status("#h1").lastSeq);
    }
  });

  it("status goes to the origin channel; pages go to the owner DM", async () => {
    const rig = makeRig();
    await rig.engine.open("#h2", presets.onePass(), { body: "b", originChannel: "chan:vid" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.blocked("stuck");
    const statuses = rig.sink.statuses();
    const pages = rig.sink.pages();
    expect(statuses.every((a) => a.target === "chan:vid")).toBe(true);
    expect(pages.every((a) => a.target === "dm:owner")).toBe(true);
    expect(pages.map((a) => a.eventType)).toContain("parked");
  });

  it("a run with no origin channel falls back to the default channel", async () => {
    const rig = makeRig();
    await rig.engine.open("#h3", presets.onePass(), { body: "b" });
    const opened = rig.sink.byType("run_opened")[0]!;
    expect(opened.target).toBe("chan:default");
  });
});

describe("the journal narrative", () => {
  it("hears every event, with node context per line (§5.5)", async () => {
    const rig = makeRig();
    await rig.engine.open("#h4", presets.reviewedLifecycle(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    const review = rig.adapter.seat("review");
    await review.ready();
    await review.complete({ data: { pass: true } });
    const journal = rig.engine.store.readJournal("#h4");
    const events = rig.engine.store.readEvents("#h4");
    expect(journal).toHaveLength(events.length); // one line per event, no second channel
    expect(journal.some((l) => l.includes("entered implement"))).toBe(true);
    expect(journal.some((l) => l.includes("gate review: pass"))).toBe(true);
    expect(journal.some((l) => l.includes("run done"))).toBe(true);
  });
});
