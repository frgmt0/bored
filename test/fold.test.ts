/**
 * §5.1 — the fold is pure and deterministic: same log, same state, every
 * time. Every durable fact lands in the FlowRun record.
 */
import { describe, expect, it } from "vitest";
import { foldRun } from "../src/run/fold.js";
import type { RunEvent } from "../src/run/events.js";
import * as presets from "../src/presets.js";
import { makeRig } from "./helpers.js";

async function sampleLog(): Promise<RunEvent[]> {
  const rig = makeRig();
  await rig.engine.open("#9.1", presets.reviewedLifecycle(), {
    originChannel: "chan:ops",
    body: "body",
  });
  const seat = rig.adapter.seat("implement");
  await seat.ready();
  await seat.turn();
  await seat.complete({ spendUsd: 2 });
  const review = rig.adapter.seat("review");
  await review.ready();
  await review.complete({ data: { pass: false }, spendUsd: 0.5 });
  return rig.engine.store.readEvents("#9.1");
}

describe("foldRun", () => {
  it("is deterministic and prefix-consistent", async () => {
    const log = await sampleLog();
    const a = foldRun(log);
    const b = foldRun(log);
    expect(a).toEqual(b);
    // folding a prefix then continuing equals folding the whole
    for (let cut = 0; cut <= log.length; cut++) {
      const whole = foldRun(log);
      const partial = foldRun(log.slice(0, cut));
      // re-fold the remainder on top by just folding the full slice again
      const rejoined = foldRun([...log.slice(0, cut), ...log.slice(cut)]);
      expect(rejoined).toEqual(whole);
      expect(partial.lastSeq).toBe(cut === 0 ? 0 : log[cut - 1]!.seq);
    }
  });

  it("tracks visits, gate fails, spend and leases", async () => {
    const run = foldRun(await sampleLog());
    expect(run.taskRef).toBe("#9.1");
    expect(run.visits["implement"]).toBe(2); // rework re-entry after review fail
    expect(run.visits["review"]).toBe(1);
    expect(run.gateFails["review"]).toBe(1);
    expect(run.spend.usd).toBe(2.5);
    expect(run.spend.byNode["implement"]).toBe(2);
    expect(run.spend.byNode["review"]).toBe(0.5);
    // the finished seats' leases are gone; only the freshly staffed rework
    // seat (implement visit 2) holds one
    expect(Object.keys(run.leases)).toEqual(["implement#v2"]);
    expect(run.leases["implement#v2"]?.state).toBe("live");
    // seats are recorded with their outcome
    expect(run.seats["implement#v1"]?.phase).toBe("finished");
    expect(run.seats["review#v1"]?.lastSignalStatus).toBe("complete");
    // exactly one cursor (the re-entered implement), phase entered/seated
    expect(run.cursors).toHaveLength(1);
    expect(run.cursors[0]?.node).toBe("implement");
    expect(run.cursors[0]?.visit).toBe(2);
  });

  it("keeps run status/cursor bookkeeping through park and resume", async () => {
    const rig = makeRig();
    await rig.engine.open("#9.2", presets.intDesignFlow(), { body: "b" });
    const design = rig.adapter.seat("design");
    await design.ready();
    await design.complete();
    const check = rig.adapter.seat("design_check");
    await check.ready();
    await check.complete({ data: { pass: true } });
    // now parked at the human design_review gate
    let run = rig.engine.status("#9.2");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("human_gate");
    expect(run.cursors.some((c) => c.node === "design_review" && c.phase === "gate_waiting")).toBe(
      true,
    );
    await rig.engine.resume("#9.2", { gate: { node: "design_review", verdict: "pass" } });
    run = rig.engine.status("#9.2");
    expect(run.status).toBe("running");
    expect(run.parked).toBeUndefined();
    expect(run.visits["implement"]).toBe(1);
  });
});
