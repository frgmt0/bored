/**
 * The tracker layer: the ticket entity, the #N / #N.x tree, cross-task
 * `needs` with promote-on-done, the eight-value state model projected from
 * runs, and the locked/versioned tasks.json registry.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CollectingSink,
  ManualClock,
  SimulatedMergeProvider,
  SimulatedSpawnAdapter,
  TicketStore,
  Tracker,
  presets,
} from "../src/index.js";

interface TrackerRig {
  tracker: Tracker;
  adapter: SimulatedSpawnAdapter;
  sink: CollectingSink;
  clock: ManualClock;
  root: string;
}

function makeTrackerRig(): TrackerRig {
  const clock = new ManualClock();
  const adapter = new SimulatedSpawnAdapter(clock);
  const sink = new CollectingSink();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ros-tracker-"));
  const tracker = new Tracker(root, adapter, new SimulatedMergeProvider(), sink, {
    clock,
    ownerDM: "dm:owner",
  });
  adapter.connect((ref, seatKey, ev) => tracker.engine.deliverWorkerEvent(ref, seatKey, ev));
  return { tracker, adapter, sink, clock, root };
}

async function completeOnePass(rig: TrackerRig, ref: string): Promise<void> {
  const seat = [...rig.adapter.seats]
    .reverse()
    .find((s) => s.request.ref === ref && s.request.node === "implement");
  expect(seat, `a seat for ${ref}`).toBeTruthy();
  await seat!.ready();
  await seat!.complete();
}

const onePassInput = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  body: `${title} body`,
  flow: presets.onePass(),
  ...extra,
});

describe("ticket store — tasks.json, locked and versioned", () => {
  it("bumps the version on every write and survives re-reads", () => {
    const store = new TicketStore(fs.mkdtempSync(path.join(os.tmpdir(), "ros-tstore-")));
    expect(store.read().version).toBe(0);
    store.update((t) => {
      t.nextId = 5;
    });
    store.update((t) => {
      t.nextId = 9;
    });
    const tasks = store.read();
    expect(tasks.version).toBe(2);
    expect(tasks.nextId).toBe(9);
  });
});

describe("filing and the #N / #N.x tree", () => {
  it("allocates sequential top-level refs and child refs under a parent", async () => {
    const rig = makeTrackerRig();
    const a = await rig.tracker.file(onePassInput("first", { autoStaff: false }));
    const b = await rig.tracker.file(onePassInput("second", { autoStaff: false }));
    expect(a.ref).toBe("#1");
    expect(b.ref).toBe("#2");
    const child1 = await rig.tracker.file(onePassInput("child", { parent: "#1", autoStaff: false }));
    const child2 = await rig.tracker.file(onePassInput("child2", { parent: "#1", autoStaff: false }));
    expect(child1.ref).toBe("#1.1");
    expect(child2.ref).toBe("#1.2");
    expect(rig.tracker.get("#1").children).toEqual(["#1.1", "#1.2"]);
    expect(child1.parent).toBe("#1");
    // the tree is one level deep
    await expect(
      rig.tracker.file(onePassInput("grandchild", { parent: "#1.1" })),
    ).rejects.toThrow(/itself a child/);
  });

  it("refuses needs on unknown or cancelled tickets", async () => {
    const rig = makeTrackerRig();
    await expect(rig.tracker.file(onePassInput("x", { needs: ["#99"] }))).rejects.toThrow(
      /no such ticket/,
    );
    const a = await rig.tracker.file(onePassInput("a", { autoStaff: false }));
    await rig.tracker.cancel(a.ref, "superseded");
    await expect(rig.tracker.file(onePassInput("b", { needs: [a.ref] }))).rejects.toThrow(
      /cancelled/,
    );
  });

  it("refuses an invalid flow at filing time (the linter runs before anything is stored)", async () => {
    const rig = makeTrackerRig();
    await expect(
      rig.tracker.file({
        title: "bad",
        flow: { version: 1, entry: "ghost", nodes: {} },
      }),
    ).rejects.toThrow(/bad_entry/);
    expect(rig.tracker.list()).toHaveLength(0);
  });
});

describe("cross-task dependencies — blockedBy → promote on done (§1.5)", () => {
  it("a ticket with unmet needs sits in backlog and staffs when its needs complete", async () => {
    const rig = makeTrackerRig();
    const a = await rig.tracker.file(onePassInput("build the API"));
    expect(rig.tracker.get(a.ref).state).toBe("in_progress"); // auto-staffed
    const b = await rig.tracker.file(onePassInput("build the UI", { needs: [a.ref] }));
    expect(b.state).toBe("backlog");
    expect(b.stateReason).toContain(a.ref);
    expect(rig.adapter.seatCount()).toBe(1); // b burned zero tokens

    // status shows both directions of the dependency
    const status = rig.tracker.status(b.ref);
    expect(status.blockedOn).toEqual([{ ref: a.ref, state: "in_progress" }]);
    expect(rig.tracker.status(a.ref).blocking).toEqual([b.ref]);

    await completeOnePass(rig, a.ref);
    await rig.tracker.settle(); // promotion staffs b in the background
    const promoted = rig.tracker.get(b.ref);
    expect(promoted.state).toBe("in_progress");
    expect(promoted.staffed).toBe(true);
    const bSeat = rig.adapter.seats[rig.adapter.seats.length - 1]!;
    expect(bSeat.request.ref).toBe(b.ref);
    await bSeat.ready();
    await bSeat.complete();
    expect(rig.tracker.get(b.ref).state).toBe("done");
  });

  it("promotion waits for ALL needs; partial completion only updates the reason", async () => {
    const rig = makeTrackerRig();
    const a = await rig.tracker.file(onePassInput("a"));
    const b = await rig.tracker.file(onePassInput("b"));
    const c = await rig.tracker.file(onePassInput("c", { needs: [a.ref, b.ref] }));
    expect(c.state).toBe("backlog");
    await completeOnePass(rig, a.ref);
    await rig.tracker.settle();
    const mid = rig.tracker.get(c.ref);
    expect(mid.state).toBe("backlog");
    expect(mid.stateReason).toBe(`waiting on ${b.ref}`);
    await completeOnePass(rig, b.ref);
    await rig.tracker.settle();
    expect(rig.tracker.get(c.ref).state).toBe("in_progress");
  });

  it("autoStaff:false tickets promote to todo and wait for a human staff call", async () => {
    const rig = makeTrackerRig();
    const a = await rig.tracker.file(onePassInput("a"));
    const b = await rig.tracker.file(onePassInput("b", { needs: [a.ref], autoStaff: false }));
    await completeOnePass(rig, a.ref);
    await rig.tracker.settle();
    expect(rig.tracker.get(b.ref).state).toBe("todo");
    expect(rig.tracker.get(b.ref).staffed).toBe(false);
    await rig.tracker.staff(b.ref);
    expect(rig.tracker.get(b.ref).state).toBe("in_progress");
  });

  it("filing with met needs goes straight to todo/staffed", async () => {
    const rig = makeTrackerRig();
    const a = await rig.tracker.file(onePassInput("a"));
    await completeOnePass(rig, a.ref);
    const b = await rig.tracker.file(onePassInput("b", { needs: [a.ref] }));
    expect(b.staffed).toBe(true);
    expect(b.state).toBe("in_progress");
  });
});

describe("state projection — runs onto the eight-value union (§1.1)", () => {
  it("walks todo → in_progress → in_review → done through the reviewed lifecycle", async () => {
    const rig = makeTrackerRig();
    const t = await rig.tracker.file({
      title: "reviewed work",
      body: "b",
      flow: presets.reviewedLifecycle(),
    });
    expect(rig.tracker.get(t.ref).state).toBe("in_progress");
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    expect(rig.tracker.get(t.ref).state).toBe("in_review"); // gate active
    const review = rig.adapter.seat("review");
    await review.ready();
    await review.complete({ data: { pass: true } });
    expect(rig.tracker.get(t.ref).state).toBe("done");
  });

  it("the INT design flow projects design / design_review via the state_map", async () => {
    const rig = makeTrackerRig();
    const t = await rig.tracker.file({
      title: "INT work",
      body: "b",
      flow: presets.intDesignFlow(),
      stateMap: presets.INT_DESIGN_STATE_MAP,
    });
    expect(rig.tracker.get(t.ref).state).toBe("design");
    const design = rig.adapter.seat("design");
    await design.ready();
    await design.complete();
    expect(rig.tracker.get(t.ref).state).toBe("design"); // design_check maps to design
    const check = rig.adapter.seat("design_check");
    await check.ready();
    await check.complete({ data: { pass: true } });
    // parked at the human design_review gate — the design_review column
    expect(rig.tracker.get(t.ref).state).toBe("design_review");
    await rig.tracker.decideGate(t.ref, "design_review", "pass");
    expect(rig.tracker.get(t.ref).state).toBe("in_progress");
  });

  it("parks a human owns read as in_review, with the reason on the ticket", async () => {
    const rig = makeTrackerRig();
    const t = await rig.tracker.file(onePassInput("blocked work"));
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.blocked("needs credentials");
    const after = rig.tracker.get(t.ref);
    expect(after.state).toBe("in_review");
    expect(after.stateReason).toContain("needs credentials");
  });

  it("cancel mid-run cancels the run and the ticket", async () => {
    const rig = makeTrackerRig();
    const t = await rig.tracker.file(onePassInput("doomed"));
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await rig.tracker.cancel(t.ref, "descoped");
    expect(rig.tracker.get(t.ref).state).toBe("cancelled");
    expect(rig.tracker.engine.status(t.ref).status).toBe("cancelled");
  });

  it("a ticket with no flow compiles one from the cast (§3.2), defaulting sanely", async () => {
    const rig = makeTrackerRig();
    const low = await rig.tracker.file({ title: "trivial", cast: { harness: "pi", effort: "low" } });
    // low effort → self tier → one pass, no reviewer
    const run = rig.tracker.engine.status(low.ref);
    expect(Object.keys(run.spec.nodes)).toEqual(["implement"]);
    const noCast = await rig.tracker.file({ title: "default cast" });
    const run2 = rig.tracker.engine.status(noCast.ref);
    expect(Object.keys(run2.spec.nodes)).toEqual(["implement", "review"]); // fresh review tier
  });
});

describe("tracker recovery", () => {
  it("re-projects states and runs missed promotions on boot", async () => {
    const rig = makeTrackerRig();
    const a = await rig.tracker.file(onePassInput("a"));
    const b = await rig.tracker.file(onePassInput("b", { needs: [a.ref], autoStaff: false }));
    await completeOnePass(rig, a.ref);
    await rig.tracker.settle();
    expect(rig.tracker.get(b.ref).state).toBe("todo");
    // simulate the promotion write being lost in a crash: rewind to backlog
    rig.tracker.tickets.update((tasks) => {
      tasks.tickets[b.ref]!.state = "backlog";
      tasks.tickets[b.ref]!.stateReason = `waiting on ${a.ref}`;
    });

    // reboot over the same root
    const clock = new ManualClock();
    const adapter = new SimulatedSpawnAdapter(clock);
    const rebooted = new Tracker(rig.root, adapter, new SimulatedMergeProvider(), new CollectingSink(), {
      clock,
      ownerDM: "dm:owner",
    });
    adapter.connect((ref, seatKey, ev) => rebooted.engine.deliverWorkerEvent(ref, seatKey, ev));
    await rebooted.recover();
    const recovered = rebooted.get(b.ref);
    expect(recovered.state).toBe("todo"); // promotion re-derived from a's done state
    expect(recovered.staffed).toBe(false); // autoStaff:false respected on replay
    expect(rebooted.get(a.ref).state).toBe("done");
  });
});
