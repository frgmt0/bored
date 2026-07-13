/**
 * §6.1 / §6.2 — failure detection: leases, not vibes. The three clocks
 * (quiet→stall, overrun, ready deadline), the hard backstop, and the
 * escalation ladder. A slow worker renews; a dead worker doesn't.
 */
import { describe, expect, it } from "vitest";
import * as presets from "../src/presets.js";
import { makeRig } from "./helpers.js";

// supervise defaults: leaseS 90, quietStrikes 2, overrunFactor 1.5,
// readyS 60; onePass low-effort envelope: 15 turns / 600s.

describe("the quiet → stall ladder", () => {
  it("strike 1: a status-check nudge after one quiet window", async () => {
    const rig = makeRig();
    await rig.engine.open("#s1", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    rig.clock.advance(100); // one 90s window missed
    await rig.engine.tick();
    expect(seat.nudges.some((n) => n.includes("status check"))).toBe(true);
    expect(seat.aborted).toBeFalsy(); // strike 1 never kills
    const run = rig.engine.status("#s1");
    expect(run.activeAlarms).toHaveLength(0);
  });

  it("strike 2: the stall alarm aborts and re-staffs the same visit", async () => {
    const rig = makeRig();
    await rig.engine.open("#s2", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement", { attempt: 1 });
    await seat.ready();
    rig.clock.advance(200); // two quiet windows → quietStrikes reached
    await rig.engine.tick();
    expect(seat.aborted).toBeTruthy();
    const events = rig.engine.store.readEvents("#s2");
    const alarm = events.find((e) => e.type === "alarm_raised");
    expect(alarm).toMatchObject({ alarm: { type: "stall", seatKey: "implement#v1" } });
    // stall is a *status* announcement — a human surface hears it (§6)
    expect(rig.sink.byType("alarm_raised")).toHaveLength(1);
    const retry = rig.adapter.seat("implement", { attempt: 2 });
    expect(retry.request.visit).toBe(1);
    await retry.ready();
    await retry.complete();
    expect(rig.engine.status("#s2").status).toBe("done");
  });

  it("a slow worker renews and never stalls; a dead worker cannot fake a renewal", async () => {
    const rig = makeRig();
    await rig.engine.open("#s3", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    // renew every 80s for 10 windows — slow, but alive
    for (let i = 0; i < 10; i++) {
      rig.clock.advance(80);
      await seat.turn(1, { input: 10, output: 5 });
      await rig.engine.tick();
    }
    expect(seat.aborted).toBeFalsy();
    expect(rig.engine.status("#s3").activeAlarms).toHaveLength(0);
    // now go silent
    rig.clock.advance(200);
    await rig.engine.tick();
    expect(seat.aborted).toBeTruthy();
  });

  it("a driver-emitted stalled event escalates without waiting for windows", async () => {
    const rig = makeRig();
    await rig.engine.open("#s4", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.stall();
    await rig.engine.tick();
    expect(seat.aborted).toBeTruthy();
  });

  it("custom supervise thresholds are honoured (relaxing is allowed)", async () => {
    const rig = makeRig();
    const spec = presets.onePass();
    spec.supervise = { leaseS: 300, quietStrikes: 3 };
    await rig.engine.open("#s5", spec, { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    rig.clock.advance(600); // 2 windows of 300 — below quietStrikes 3
    await rig.engine.tick();
    expect(seat.aborted).toBeFalsy();
    rig.clock.advance(400); // 3rd window
    await rig.engine.tick();
    expect(seat.aborted).toBeTruthy();
  });
});

describe("the ready deadline (§6.4 spawn-phase hang)", () => {
  it("no worker_ready within readyS raises ready_timeout and re-staffs", async () => {
    const rig = makeRig();
    await rig.engine.open("#s6", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement", { attempt: 1 });
    // never call seat.ready()
    rig.clock.advance(90);
    await rig.engine.tick();
    expect(seat.aborted).toBeTruthy();
    const alarm = rig.engine.store
      .readEvents("#s6")
      .find((e) => e.type === "alarm_raised");
    expect(alarm).toMatchObject({ alarm: { type: "ready_timeout" } });
    const retry = rig.adapter.seat("implement", { attempt: 2 });
    await retry.ready();
    await retry.complete();
    expect(rig.engine.status("#s6").status).toBe("done");
  });
});

describe("overrun (advisory) and the hard backstop", () => {
  it("crossing overrunFactor × envelope raises the alarm but never kills", async () => {
    const rig = makeRig();
    await rig.engine.open("#s7", presets.onePass(), { body: "b" }); // low: 600s envelope
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    // stay alive past 1.5 × 600 = 900s
    for (let i = 0; i < 12; i++) {
      rig.clock.advance(85);
      await seat.turn();
    }
    await rig.engine.tick();
    const run = rig.engine.status("#s7");
    expect(run.activeAlarms.map((a) => a.type)).toContain("overrun");
    expect(seat.aborted).toBeFalsy(); // long thinking is not punished (§6.1)
    await seat.complete();
    expect(rig.engine.status("#s7").status).toBe("done");
  });

  it("the hard wall-clock backstop kills and pages — every softer layer failed", async () => {
    const rig = makeRig({ hardCapS: 1800 });
    const spec = presets.onePass();
    spec.supervise = { leaseS: 3600, quietStrikes: 10 }; // soften the stall ladder out of the way
    await rig.engine.open("#s8", spec, { body: "b" });
    const seat = rig.adapter.seat("implement", { attempt: 1 });
    await seat.ready();
    // keep renewing so quiet never fires, but blow through the hard cap
    for (let i = 0; i < 4; i++) {
      rig.clock.advance(500);
      await seat.turn();
    }
    await rig.engine.tick();
    expect(seat.aborted).toBeTruthy();
    const signal = rig.engine.store
      .readEvents("#s8")
      .find((e) => e.type === "signal_received");
    expect(signal).toMatchObject({ subtype: "synthesized_wall_clock_cap" });
    // the backstop's firing is a page (§6.1)
    expect(rig.sink.pages().map((a) => a.eventType)).toContain("signal_received");
  });

  it("the sentinel constructor enforces the 1800s floor", () => {
    expect(() => makeRig({ hardCapS: 60 })).toThrow(/floor/);
  });
});

describe("progress_noted rollups", () => {
  it("at most one per minute per seat, aggregating turns/files/tokens", async () => {
    const rig = makeRig();
    await rig.engine.open("#s9", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    // lots of activity inside one minute
    for (let i = 0; i < 5; i++) {
      rig.clock.advance(10);
      await seat.turn(2, { input: 100, output: 50 });
      await seat.fileChange(`src/f${i}.ts`);
      await rig.engine.tick();
    }
    rig.clock.advance(15); // cross the 60s line
    await rig.engine.tick();
    const notes = rig.engine.store
      .readEvents("#s9")
      .filter((e) => e.type === "progress_noted");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ seatKey: "implement#v1", turns: 5, filesTouched: 5, tokens: 750 });
    // another burst, another single rollup
    for (let i = 0; i < 3; i++) {
      rig.clock.advance(10);
      await seat.turn(1, { input: 10, output: 10 });
    }
    rig.clock.advance(35);
    await rig.engine.tick();
    expect(
      rig.engine.store.readEvents("#s9").filter((e) => e.type === "progress_noted"),
    ).toHaveLength(2);
  });
});

describe("checkpoints", () => {
  it("worker checkpoint events are recorded and renew the lease", async () => {
    const rig = makeRig();
    await rig.engine.open("#s10", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    rig.clock.advance(85);
    await seat.checkpoint("abc123");
    rig.clock.advance(85); // only ~85s since the checkpoint renewed
    await rig.engine.tick();
    expect(seat.aborted).toBeFalsy();
    const cp = rig.engine.store
      .readEvents("#s10")
      .find((e) => e.type === "checkpoint_committed");
    expect(cp).toMatchObject({ seatKey: "implement#v1", sha: "abc123" });
  });
});
