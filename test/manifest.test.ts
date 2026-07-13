/**
 * §6.4 — the spawn/ready/done handshakes: every worker can prove where it
 * is before it does anything; a worker somewhere wrong declines (or is
 * refused) loudly.
 */
import { describe, expect, it } from "vitest";
import { buildManifest, manifestHashOf, verifyReadiness } from "../src/engine/manifest.js";
import { SUPERVISE_DEFAULTS } from "../src/spec/types.js";
import * as presets from "../src/presets.js";
import { makeRig } from "./helpers.js";

const body = () => ({
  taskRef: "#m1",
  seatKey: "implement#v1",
  node: "implement",
  nodeKind: "worker",
  visit: 1,
  attempt: 1,
  worktree: "/w",
  branch: "beckett/task-m1",
  baseSha: "f0f0f0",
  flow: { entry: "implement", position: "implement", onPass: "done", onFail: "park" },
  budget: { remainingUsd: 10 },
  envelope: { turnCap: 15, wallClockS: 600 },
  supervise: SUPERVISE_DEFAULTS,
});

describe("manifest hashing", () => {
  it("is deterministic and key-order independent", () => {
    const a = manifestHashOf(body());
    const b = manifestHashOf(JSON.parse(JSON.stringify(body())));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field changes", () => {
    const base = manifestHashOf(body());
    for (const mutate of [
      (m: ReturnType<typeof body>) => (m.branch = "other"),
      (m: ReturnType<typeof body>) => (m.baseSha = "beefed"),
      (m: ReturnType<typeof body>) => (m.visit = 2),
      (m: ReturnType<typeof body>) => (m.budget.remainingUsd = 1),
    ]) {
      const m = body();
      mutate(m);
      expect(manifestHashOf(m)).not.toBe(base);
    }
  });
});

describe("verifyReadiness", () => {
  const manifest = buildManifest(body());
  it("accepts an honest claim", () => {
    expect(
      verifyReadiness(manifest, {
        manifestHash: manifest.manifestHash,
        observedBranch: "beckett/task-m1",
        observedSha: "f0f0f0",
      }),
    ).toEqual({ ok: true });
  });
  it("rejects hash, branch and sha mismatches, naming expected vs observed", () => {
    const wrongHash = verifyReadiness(manifest, {
      manifestHash: "deadbeef",
      observedBranch: "beckett/task-m1",
      observedSha: "f0f0f0",
    });
    expect(wrongHash).toMatchObject({ ok: false, mismatch: "manifest_hash" });
    const wrongBranch = verifyReadiness(manifest, {
      manifestHash: manifest.manifestHash,
      observedBranch: "main",
      observedSha: "f0f0f0",
    });
    expect(wrongBranch).toMatchObject({
      ok: false,
      mismatch: "branch",
      expected: "beckett/task-m1",
      observed: "main",
    });
    const wrongSha = verifyReadiness(manifest, {
      manifestHash: manifest.manifestHash,
      observedBranch: "beckett/task-m1",
      observedSha: "111111",
    });
    expect(wrongSha).toMatchObject({ ok: false, mismatch: "base_sha" });
  });
});

describe("the handshake in the engine", () => {
  it("every spawned seat carries a manifest stating branch, position, budget and envelope", async () => {
    const rig = makeRig();
    const spec = presets.reviewedLifecycle();
    spec.budget = { usd: 20 };
    await rig.engine.open("#m2", spec, { body: "b" });
    const seat = rig.adapter.seat("implement");
    const m = seat.request.manifest;
    expect(m.taskRef).toBe("#m2");
    expect(m.node).toBe("implement");
    expect(m.flow).toEqual({
      entry: "implement",
      position: "implement",
      onPass: "review",
      onFail: "park",
    });
    expect(m.budget.remainingUsd).toBe(20);
    expect(m.envelope).toEqual({ turnCap: 60, wallClockS: 2400 }); // high effort
    expect(m.supervise).toEqual(SUPERVISE_DEFAULTS);
    expect(m.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    // the seat_spawned event records the same hash
    const spawned = rig.engine.store.readEvents("#m2").find((e) => e.type === "seat_spawned");
    expect(spawned).toMatchObject({ manifestHash: m.manifestHash });
  });

  it("an honest worker_ready is recorded with the observed branch/sha", async () => {
    const rig = makeRig();
    await rig.engine.open("#m3", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    const ready = rig.engine.store.readEvents("#m3").find((e) => e.type === "worker_ready");
    expect(ready).toMatchObject({
      seatKey: "implement#v1",
      manifestHash: seat.request.manifest.manifestHash,
      observedBranch: seat.request.branch,
      observedSha: seat.request.baseSha,
    });
  });

  it("a worker observing the wrong branch is refused, paged, and the seat re-staffed", async () => {
    const rig = makeRig();
    await rig.engine.open("#m4", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement", { attempt: 1 });
    await seat.readyWith({ observedBranch: "main" }); // woke up in the wrong place
    const refused = rig.engine.store.readEvents("#m4").find((e) => e.type === "worker_refused");
    expect(refused).toMatchObject({
      seatKey: "implement#v1",
      observed: { branch: "main" },
    });
    expect((refused as { observed: { reason?: string } }).observed.reason).toContain("branch");
    // worker_refused pages the owner (§6.3)
    expect(rig.sink.pages().map((a) => a.eventType)).toContain("worker_refused");
    // and the seat was re-staffed on the same visit
    const retry = rig.adapter.seat("implement", { attempt: 2 });
    expect(retry.request.visit).toBe(1);
    await retry.ready();
    await retry.complete();
    expect(rig.engine.status("#m4").status).toBe("done");
  });

  it("a worker's own refusal (its env check failed) walks the same path", async () => {
    const rig = makeRig();
    await rig.engine.open("#m5", presets.onePass(), { body: "b" });
    const seat = rig.adapter.seat("implement", { attempt: 1 });
    await seat.refuse("worktree has uncommitted changes I don't recognise", {
      branch: "beckett/task-m5",
    });
    const refused = rig.engine.store.readEvents("#m5").find((e) => e.type === "worker_refused");
    expect((refused as { observed: { reason?: string } }).observed.reason).toContain(
      "uncommitted changes",
    );
    const retry = rig.adapter.seat("implement", { attempt: 2 });
    await retry.ready();
    await retry.complete();
    expect(rig.engine.status("#m5").status).toBe("done");
  });
});
