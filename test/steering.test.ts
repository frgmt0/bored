/**
 * §5.5 — mid-run context injection made a clean, first-class operation.
 *
 * Injecting context into a running agent is deterministic, never
 * fire-and-forget. Two explicit modes:
 *
 *  - enqueue (`engine.nudge`): the steer is durably buffered AND handed to the
 *    live worker best-effort. A worker that picks it up acks it (draining the
 *    buffer); a worker that ignores it, dies, or retries leaves it buffered, so
 *    it folds into the next seat's brief. The steer is never silently skipped
 *    and never lost past the run — the exact symptom this suite guards against.
 *  - interrupt (`engine.interrupt`): the steer is buffered, the in-flight seat
 *    is aborted with a WIP checkpoint, and the same visit is re-staffed with the
 *    steer folded into a fresh brief — immediate, deterministic application.
 */
import { describe, expect, it } from "vitest";
import * as presets from "../src/presets.js";
import { eventTypes, makeRig, rebootRig } from "./helpers.js";

describe("mid-run injection — enqueue (nudge)", () => {
  it("durably buffers a steer handed to a live worker until it is acked", async () => {
    const rig = makeRig();
    await rig.engine.open("#s1", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();

    const receipt = rig.engine.nudge("#s1", "prefer approach B", "implement");
    // Live hand-off happened, but the guarantee is the durable buffer.
    expect(receipt.receipt).toBe("delivered");
    expect(receipt.buffered).toBe(true);
    expect(receipt.steerId).toBeDefined();
    expect(seat.steers.map((s) => s.steerId)).toContain(receipt.steerId);

    // Not yet acknowledged: the steer stays buffered so it cannot be skipped.
    expect(rig.engine.status("#s1").pendingSteers).toHaveLength(1);
    expect(rig.engine.status("#s1").pendingSteers[0]!.id).toBe(receipt.steerId);

    // The worker confirms it applied the steer → the buffer drains.
    await seat.ackNudge(receipt.steerId);
    expect(rig.engine.status("#s1").pendingSteers).toHaveLength(0);
    expect(eventTypes(rig, "#s1")).toContain("nudge_acked");
  });

  it("a steer the running worker never acks is not lost — it folds into the next seat's brief", async () => {
    const rig = makeRig();
    await rig.engine.open("#s2", presets.reviewedLifecycle(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();

    // Deliver to the live worker, but the worker barrels past without acking.
    const receipt = rig.engine.nudge("#s2", "watch the auth edge case", "implement");
    expect(receipt.receipt).toBe("delivered");
    expect(rig.engine.status("#s2").pendingSteers).toHaveLength(1);

    // The seat finishes without ever picking the steer up.
    await seat.complete();

    // The very next seat (the review gate) carries the steer in its brief,
    // then the buffer drains — the injection was applied, not skipped.
    const review = rig.adapter.seat("review");
    expect(review.request.briefParts.steers.map((s) => s.text)).toContain(
      "watch the auth edge case",
    );
    expect(rig.engine.status("#s2").pendingSteers).toHaveLength(0);
  });

  it("buffers when no seat is live and survives an engine reboot (durable)", async () => {
    const rig = makeRig();
    await rig.engine.open("#s3", presets.reviewedLifecycle(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    // review gate is live; steering targeted at implement has no live seat.
    const receipt = rig.engine.nudge("#s3", "when you rework, use approach B", "implement");
    expect(receipt.receipt).toBe("queued");
    expect(receipt.buffered).toBe(true);

    // Reboot the engine over the same store: the buffer rebuilds from the log
    // alone (a fold of the persisted nudge_delivered event).
    const rebooted = rebootRig(rig);
    expect(rebooted.engine.status("#s3").pendingSteers.map((s) => s.text)).toContain(
      "when you rework, use approach B",
    );

    // And recovery applies it: the re-staffed seat's brief carries the steer.
    await rebooted.engine.recoverAll();
    const restaffed = rebooted.adapter.seat("review");
    expect(restaffed.request.briefParts.steers.map((s) => s.text)).toContain(
      "when you rework, use approach B",
    );
  });

  it("rejects steering a finished run", async () => {
    const rig = makeRig();
    await rig.engine.open("#s4", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    expect(rig.engine.status("#s4").status).toBe("done");
    expect(() => rig.engine.nudge("#s4", "too late", "implement")).toThrow(/finished/);
  });

  it("buffers a steer on a parked run for when it resumes", async () => {
    const rig = makeRig();
    await rig.engine.open("#s7", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await rig.engine.pause("#s7");
    expect(rig.engine.status("#s7").status).toBe("parked");

    const receipt = rig.engine.nudge("#s7", "use the documented API", "implement");
    expect(receipt.receipt).toBe("queued");
    expect(rig.engine.status("#s7").pendingSteers).toHaveLength(1);

    // Resume re-staffs the same visit; the steer folds into its brief.
    await rig.engine.resume("#s7");
    const restaffed = rig.adapter.seat("implement", { attempt: 2 });
    expect(restaffed.request.briefParts.steers.map((s) => s.text)).toContain(
      "use the documented API",
    );
  });
});

describe("mid-run injection — interrupt", () => {
  it("aborts the in-flight seat and re-staffs the same visit with the steer applied", async () => {
    const rig = makeRig();
    await rig.engine.open("#s5", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.turn();

    const receipt = await rig.engine.interrupt("#s5", "stop — requirements changed", "implement");
    expect(receipt.receipt).toBe("will-restart");
    expect(receipt.buffered).toBe(true);

    // The in-flight seat was aborted with a WIP checkpoint — nothing is lost.
    expect(seat.aborted?.reason).toContain("steer interrupt");
    expect(eventTypes(rig, "#s5")).toContain("checkpoint_committed");

    // The same visit is re-staffed (next attempt) with the steer in its brief;
    // no retry cap was burned and the run never left `running`.
    const run = rig.engine.status("#s5");
    expect(run.status).toBe("running");
    const restaffed = rig.adapter.seat("implement", { attempt: 2 });
    expect(restaffed.request.visit).toBe(1);
    expect(restaffed.request.briefParts.steers.map((s) => s.text)).toContain(
      "stop — requirements changed",
    );

    // The re-staffed worker finishes the (now correctly-steered) work.
    await restaffed.ready();
    await restaffed.complete();
    expect(rig.engine.status("#s5").status).toBe("done");
  });

  it("degrades to a durable enqueue when no seat is live", async () => {
    const rig = makeRig();
    await rig.engine.open("#s6", presets.reviewedLifecycle(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    // review gate is live; interrupt targeted at implement finds no live seat.
    const receipt = await rig.engine.interrupt("#s6", "note for the rework", "implement");
    expect(receipt.receipt).toBe("queued");
    expect(receipt.buffered).toBe(true);
    expect(rig.engine.status("#s6").pendingSteers.map((s) => s.text)).toContain(
      "note for the rework",
    );
  });
});
