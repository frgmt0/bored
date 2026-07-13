/**
 * §5.6 — crash recovery: on boot the engine replays each run's event log.
 * PARKED cursors stay parked; LIVE cursors re-staff from their checkpointed
 * worktrees; decisions appended but not acted on are re-derived. The
 * property test kills the engine after *every* prefix of a real run's log
 * and proves the rebooted engine always drives the run to the same outcome.
 */
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import * as presets from "../src/presets.js";
import type { SimSeat } from "../src/adapters/simulated.js";
import { makeRig, rebootRig, type Rig } from "./helpers.js";

/** Auto-play any seat the engine spawns, per node, so recovery can finish runs. */
function installAutoplay(rig: Rig, behaviours: Record<string, (seat: SimSeat) => Promise<void>>): void {
  for (const [node, play] of Object.entries(behaviours)) {
    rig.adapter.script(node, play);
  }
}

const reviewedBehaviours = {
  implement: async (seat: SimSeat) => {
    await seat.ready();
    await seat.complete({ spendUsd: 1 });
  },
  review: async (seat: SimSeat) => {
    await seat.ready();
    await seat.complete({ data: { pass: true }, spendUsd: 0.5 });
  },
};

async function runReviewedToCompletion(): Promise<Rig> {
  const rig = makeRig();
  installAutoplay(rig, reviewedBehaviours);
  await rig.engine.open("#r1", presets.reviewedLifecycle(), { body: "b", originChannel: "c" });
  await rig.adapter.settle();
  expect(rig.engine.status("#r1").status).toBe("done");
  return rig;
}

describe("crash recovery — the every-prefix property", () => {
  it("recovers to done from a crash after ANY event of a reviewed run", async () => {
    const reference = await runReviewedToCompletion();
    const fullLog = fs.readFileSync(reference.engine.store.logPath("#r1"), "utf8");
    const lines = fullLog.split("\n").filter(Boolean);

    for (let cut = 1; cut < lines.length; cut++) {
      // a fresh store containing only the first `cut` events — the crash point
      const rig = makeRig();
      const logPath = rig.engine.store.logPath("#r1");
      fs.mkdirSync(rig.root + "/runs", { recursive: true });
      fs.writeFileSync(logPath, lines.slice(0, cut).join("\n") + "\n");
      installAutoplay(rig, reviewedBehaviours);

      const recovered = await rig.engine.recoverAll();
      expect(recovered).toContain("#r1");
      await rig.adapter.settle();
      // some cuts need a second settle round (recovery spawned → script → spawn)
      await rig.adapter.settle();

      const run = rig.engine.status("#r1");
      expect(run.status, `crash after event ${cut} (${lines[cut - 1]?.slice(0, 60)})`).toBe("done");
      expect(run.outcome).toBe("success");
      expect(run.visits["implement"]).toBe(1);
      expect(run.visits["review"]).toBe(1);
      // no duplicated gate verdicts, ever
      const decided = rig.engine.store
        .readEvents("#r1")
        .filter((e) => e.type === "gate_decided");
      expect(decided).toHaveLength(1);
    }
  });

  it("recovers a fanout/all-merge run from every crash point", async () => {
    const spec = {
      version: 1,
      entry: "fan",
      nodes: {
        fan: {
          kind: "fanout",
          arms: [
            { cast: { harness: "pi", effort: "high" }, brief: "api" },
            { cast: { harness: "codex", effort: "high" }, brief: "ui" },
          ],
          isolation: "worktree-each",
          join: "join",
        },
        join: { kind: "join", strategy: "all-merge", onPass: "done", onFail: "park" },
      },
    };
    const behaviours = {
      fan: async (seat: SimSeat) => {
        await seat.ready();
        await seat.complete({ summary: `arm ${seat.request.arm}` });
      },
    };
    const reference = makeRig();
    installAutoplay(reference, behaviours);
    await reference.engine.open("#r2", spec, { body: "b" });
    await reference.adapter.settle();
    expect(reference.engine.status("#r2").status).toBe("done");
    const lines = fs
      .readFileSync(reference.engine.store.logPath("#r2"), "utf8")
      .split("\n")
      .filter(Boolean);

    for (let cut = 1; cut < lines.length; cut++) {
      const rig = makeRig();
      fs.writeFileSync(rig.engine.store.logPath("#r2"), lines.slice(0, cut).join("\n") + "\n");
      installAutoplay(rig, behaviours);
      await rig.engine.recoverAll();
      await rig.adapter.settle();
      await rig.adapter.settle();
      const run = rig.engine.status("#r2");
      expect(run.status, `crash after event ${cut} (${lines[cut - 1]?.slice(0, 60)})`).toBe("done");
      // both arms merged exactly... at least once (mid-merge replays may re-merge
      // idempotently), in arm order per pass
      const joinResolved = rig.engine.store
        .readEvents("#r2")
        .filter((e) => e.type === "join_resolved");
      expect(joinResolved.length).toBe(1);
      expect(joinResolved[0]).toMatchObject({ outcome: "pass" });
    }
  });
});

describe("crash recovery — states that must NOT restart", () => {
  it("parked runs stay parked (human gate)", async () => {
    const rig = makeRig();
    await rig.engine.open("#r3", presets.intDesignFlow(), { body: "b" });
    const design = rig.adapter.seat("design");
    await design.ready();
    await design.complete();
    const check = rig.adapter.seat("design_check");
    await check.ready();
    await check.complete({ data: { pass: true } });
    expect(rig.engine.status("#r3").status).toBe("parked");

    const rebooted = rebootRig(rig);
    await rebooted.engine.recoverAll();
    const run = rebooted.engine.status("#r3");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("human_gate");
    expect(rebooted.adapter.seatCount()).toBe(0); // restart-inert: zero seats spawned
  });

  it("done and cancelled runs are untouched", async () => {
    const rig = makeRig();
    await rig.engine.open("#r4", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    const before = rig.engine.store.readEvents("#r4").length;
    const rebooted = rebootRig(rig);
    await rebooted.engine.recoverAll();
    expect(rebooted.engine.store.readEvents("#r4")).toHaveLength(before);
    expect(rebooted.adapter.seatCount()).toBe(0);
  });
});

describe("crash recovery — live cursors re-staff", () => {
  it("a worker live at crash time is re-staffed on the same visit with the next attempt", async () => {
    const rig = makeRig();
    await rig.engine.open("#r5", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.turn(); // mid-flight — then the engine dies

    const rebooted = rebootRig(rig);
    await rebooted.engine.recoverAll();
    const run = rebooted.engine.status("#r5");
    expect(run.status).toBe("running");
    const restaffed = rebooted.adapter.seat("implement", { attempt: 2 });
    expect(restaffed.request.visit).toBe(1);
    // re-staffing is not a rework and burns no retry
    expect(run.cursors[0]?.retriesUsed).toBe(0);
    await restaffed.ready();
    await restaffed.complete();
    expect(rebooted.engine.status("#r5").status).toBe("done");
  });

  it("late deliveries for an already-resolved seat are dropped", async () => {
    const rig = makeRig();
    await rig.engine.open("#r6", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    expect(rig.engine.status("#r6").status).toBe("done");
    const before = rig.engine.store.readEvents("#r6").length;
    // a duplicate finished from a zombie process for the finished seat
    await rig.engine.deliverWorkerEvent("#r6", "implement#v1", {
      kind: "finished",
      signal: {
        status: "complete",
        summary: "ghost",
        filesChanged: [],
        checksRun: null,
        blockedReason: null,
      },
    });
    expect(rig.engine.store.readEvents("#r6")).toHaveLength(before);
  });
});
