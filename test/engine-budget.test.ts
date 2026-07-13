/**
 * §4.3 step 4 / §5.3 — budgets and caps: hard ceilings for the whole run,
 * checked before every spawn; a breach parks with budget_hit, and a parked
 * run never burns another token until it is resumed with authority.
 */
import { describe, expect, it } from "vitest";
import * as presets from "../src/presets.js";
import { makeRig } from "./helpers.js";

describe("usd budget", () => {
  it("refuses the next spawn once spend crosses the cap: alarm + budget_hit + park", async () => {
    const rig = makeRig();
    const spec = presets.reviewedLifecycle();
    spec.budget = { usd: 3 };
    await rig.engine.open("#b1", spec, { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete({ spendUsd: 3.5 }); // implement blew the budget
    const run = rig.engine.status("#b1");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("budget_usd");
    expect(run.parked?.node).toBe("review"); // the refusal was pre-spawn at review
    expect(rig.adapter.seatCount("review")).toBe(0); // no seat was requested
    const events = rig.engine.store.readEvents("#b1").map((e) => e.type);
    expect(events).toContain("budget_hit");
    expect(events).toContain("alarm_raised"); // §1.6's "no budget alarm exists" — fixed
    // pages: budget_hit and the park
    expect(rig.sink.pages().map((a) => a.eventType)).toEqual(
      expect.arrayContaining(["budget_hit", "parked"]),
    );
  });

  it("resume with an extraUsd grant re-arms the run", async () => {
    const rig = makeRig();
    const spec = presets.reviewedLifecycle();
    spec.budget = { usd: 3 };
    await rig.engine.open("#b2", spec, { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete({ spendUsd: 3.5 });
    expect(rig.engine.status("#b2").status).toBe("parked");
    await rig.engine.resume("#b2", { extraUsd: 5 });
    const run = rig.engine.status("#b2");
    expect(run.status).toBe("running");
    const review = rig.adapter.seat("review");
    // the manifest tells the new seat what is actually left to spend
    expect(review.request.manifest.budget.remainingUsd).toBeCloseTo(3 + 5 - 3.5);
    await review.ready();
    await review.complete({ data: { pass: true }, spendUsd: 0.5 });
    expect(rig.engine.status("#b2").status).toBe("done");
  });
});

describe("wall-clock budget", () => {
  it("refuses a pre-spawn once the run clock crosses the cap", async () => {
    const rig = makeRig();
    const spec = presets.reviewedLifecycle();
    spec.budget = { wallClockS: 600 };
    await rig.engine.open("#b3", spec, { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    rig.clock.advance(700); // implement took 700s
    await seat.complete();
    const run = rig.engine.status("#b3");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("budget_wall_clock");
  });

  it("the tick parks a run that blows the cap mid-seat and aborts the worker", async () => {
    const rig = makeRig();
    const spec = presets.onePass();
    spec.budget = { wallClockS: 900 };
    await rig.engine.open("#b4", spec, { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.turn();
    rig.clock.advance(1000);
    await rig.engine.tick();
    const run = rig.engine.status("#b4");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("budget_wall_clock");
    expect(seat.aborted).toBeTruthy();
  });
});

describe("concurrency caps", () => {
  it("budget.maxConcurrent queues excess arms FIFO within a run", async () => {
    const rig = makeRig({ maxWorkers: 10 });
    const spec = {
      version: 1,
      entry: "fan",
      budget: { maxConcurrent: 2 },
      nodes: {
        fan: {
          kind: "fanout",
          arms: [0, 1, 2, 3].map((i) => ({ cast: { harness: "pi", effort: "low" }, brief: `a${i}` })),
          isolation: "worktree-each",
          join: "join",
        },
        join: { kind: "join", strategy: "all-merge", onPass: "done", onFail: "park" },
      },
    };
    await rig.engine.open("#b5", spec, { body: "b" });
    expect(rig.adapter.seatCount("fan")).toBe(2); // arms 0,1 live; 2,3 queued
    expect(rig.engine.scheduler.queuedCount("#b5")).toBe(2);
    const arm0 = rig.adapter.seat("fan", { arm: 0 });
    await arm0.ready();
    await arm0.complete();
    // finishing one frees a slot: arm 2 staffed next (FIFO)
    expect(rig.adapter.seatCount("fan")).toBe(3);
    expect(rig.adapter.seat("fan", { arm: 2 })).toBeTruthy();
    for (const arm of [1, 2]) {
      const s = rig.adapter.seat("fan", { arm });
      await s.ready();
      await s.complete();
    }
    const arm3 = rig.adapter.seat("fan", { arm: 3 });
    await arm3.ready();
    await arm3.complete();
    expect(rig.engine.status("#b5").status).toBe("done");
  });

  it("the global max_workers cap holds across runs", async () => {
    const rig = makeRig({ maxWorkers: 1 });
    await rig.engine.open("#b6", presets.onePass(), { body: "b" });
    await rig.engine.open("#b7", presets.onePass(), { body: "b" });
    expect(rig.adapter.seatCount()).toBe(1); // second run queued behind the first
    const first = rig.adapter.seats[0]!;
    expect(first.request.ref).toBe("#b6");
    await first.ready();
    await first.complete();
    expect(rig.adapter.seatCount()).toBe(2);
    const second = rig.adapter.seats[1]!;
    expect(second.request.ref).toBe("#b7");
    await second.ready();
    await second.complete();
    expect(rig.engine.status("#b6").status).toBe("done");
    expect(rig.engine.status("#b7").status).toBe("done");
  });

  it("duplicate seat requests dedup on (run, node, visit, arm)", async () => {
    const rig = makeRig();
    const result1 = rig.engine.scheduler.request({ ref: "#x", node: "n", visit: 1, attempt: 1 });
    const result2 = rig.engine.scheduler.request({ ref: "#x", node: "n", visit: 1, attempt: 2 });
    expect(result1).toBe("admitted");
    expect(result2).toBe("dedup");
  });
});
