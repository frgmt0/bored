/**
 * Scripted workflow authoring: the fluent builder, .js flow scripts that
 * compute shape per task, and hooks — the scripted concierge.
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
  Tracker,
  flow,
  loadFlowScript,
} from "../src/index.js";

function scriptFile(source: string, name = "test.flow.mjs"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ros-flowscript-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

interface Rig {
  tracker: Tracker;
  adapter: SimulatedSpawnAdapter;
  root: string;
}

function makeRig(root?: string): Rig {
  const clock = new ManualClock();
  const adapter = new SimulatedSpawnAdapter(clock);
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "ros-authoring-"));
  const tracker = new Tracker(dir, adapter, new SimulatedMergeProvider(), new CollectingSink(), {
    clock,
    ownerDM: "dm",
  });
  adapter.connect((ref, seatKey, ev) => tracker.engine.deliverWorkerEvent(ref, seatKey, ev));
  return { tracker, adapter, root: dir };
}

describe("the flow builder", () => {
  it("composes the reviewed lifecycle fluently, first node as entry, park defaults", () => {
    const spec = flow()
      .worker("implement", {
        cast: { harness: "pi", effort: "high" },
        onPass: "review",
        maxVisits: 3,
      })
      .gate("review", {
        by: { cast: { harness: "claude", effort: "high" }, rubric: "criteria-vs-diff" },
        onPass: "done",
        onFail: "implement",
        maxFails: 3,
      })
      .budget({ usd: 10 })
      .build();
    expect(spec.entry).toBe("implement");
    expect(spec.nodes["implement"]).toMatchObject({ kind: "worker", onFail: "park" });
    expect(spec.budget).toEqual({ usd: 10 });
  });

  it("builds fanout/join shapes with sane defaults", () => {
    const spec = flow()
      .fanout("split", {
        arms: [{ cast: { harness: "pi" } }, { cast: { harness: "codex" } }],
        join: "land",
      })
      .join("land", { strategy: "all-merge", onPass: "done" })
      .build();
    expect(spec.nodes["split"]).toMatchObject({ isolation: "worktree-each" });
    expect(spec.nodes["land"]).toMatchObject({ onFail: "park" });
  });

  it("refuses duplicate nodes, empty flows, and lint-invalid graphs at build()", () => {
    expect(() =>
      flow()
        .worker("a", { cast: { harness: "pi" }, onPass: "done" })
        .worker("a", { cast: { harness: "pi" }, onPass: "done" }),
    ).toThrow(/already defined/);
    expect(() => flow().build()).toThrow(/no entry/);
    expect(() =>
      flow().worker("a", { cast: { harness: "pi" }, onPass: "ghost" }).build(),
    ).toThrow(/unknown_edge_target/);
  });
});

describe("loadFlowScript", () => {
  it("runs the default export with the ticket context and lints the result", async () => {
    const file = scriptFile(`
      export default ({ ticket, flow }) =>
        flow().worker("implement", {
          cast: { harness: "pi", effort: ticket.title.includes("big") ? "high" : "low" },
          onPass: "done",
        }).build();
    `);
    const small = await loadFlowScript(file, { title: "small tweak" });
    const big = await loadFlowScript(file, { title: "big refactor" });
    expect((small.flow.nodes["implement"] as { cast: { effort: string } }).cast.effort).toBe("low");
    expect((big.flow.nodes["implement"] as { cast: { effort: string } }).cast.effort).toBe("high");
    expect(small.scriptPath).toBe(file);
  });

  it("supports async scripts, presets in context, wrapped returns and module exports", async () => {
    const file = scriptFile(`
      export default async ({ presets }) => ({
        flow: presets.onePass(),
        stateMap: { implement: "in_progress" },
        hooks: { onEvent: () => {} },
      });
    `);
    const loaded = await loadFlowScript(file, { title: "t" });
    expect(Object.keys(loaded.flow.nodes)).toEqual(["implement"]);
    expect(loaded.stateMap).toEqual({ implement: "in_progress" });
    expect(loaded.hooks?.onEvent).toBeTypeOf("function");

    const moduleLevel = scriptFile(`
      export default ({ presets }) => presets.onePass();
      export const stateMap = { implement: "in_review" };
      export const hooks = { onEvent: () => {} };
    `);
    const loaded2 = await loadFlowScript(moduleLevel, { title: "t" });
    expect(loaded2.stateMap).toEqual({ implement: "in_review" });
    expect(loaded2.hooks?.onEvent).toBeTypeOf("function");
  });

  it("works with CommonJS scripts too", async () => {
    const file = scriptFile(
      `module.exports = { default: ({ presets }) => presets.onePass() };`,
      "test.flow.cjs",
    );
    const loaded = await loadFlowScript(file, { title: "t" });
    expect(loaded.flow.entry).toBe("implement");
  });

  it("fails loudly on missing exports, load errors and lint-invalid results", async () => {
    await expect(
      loadFlowScript(scriptFile(`export const x = 1;`), { title: "t" }),
    ).rejects.toThrow(/must default-export a function/);
    await expect(
      loadFlowScript(scriptFile(`syntax error here(`), { title: "t" }),
    ).rejects.toThrow(/failed to load/);
    await expect(
      loadFlowScript(
        scriptFile(`export default () => ({ version: 1, entry: "ghost", nodes: {} });`),
        { title: "t" },
      ),
    ).rejects.toThrow(/bad_entry/);
  });
});

describe("scripted filing through the tracker", () => {
  it("the same script produces different shapes for different tickets", async () => {
    const rig = makeRig();
    const script = path.resolve("examples/flows/adaptive.flow.mjs");

    const hotfix = await rig.tracker.file({
      title: "hotfix: broken link",
      body: "fix it",
      flowScript: script,
    });
    const hotfixRun = rig.tracker.engine.status(hotfix.ref);
    expect(Object.keys(hotfixRun.spec.nodes)).toEqual(["implement"]);
    expect(hotfixRun.spec.budget).toEqual({ usd: 2 });

    const feature = await rig.tracker.file({
      title: "notification prefs",
      body: "areas: api, ui, docs",
      flowScript: script,
    });
    const featureRun = rig.tracker.engine.status(feature.ref);
    expect(Object.keys(featureRun.spec.nodes).sort()).toEqual(["land", "review", "split"]);
    const split = featureRun.spec.nodes["split"] as { arms: Array<{ brief: string }> };
    expect(split.arms).toHaveLength(3);
    expect(split.arms[1]!.brief).toContain("ui");
    // the script's flow was linted and frozen; the ticket remembers its author
    expect(rig.tracker.get(feature.ref).flowScript).toBe(script);
    expect(rig.tracker.get(feature.ref).flow).toBeTruthy();
  });

  it("refuses flow + flowScript together", async () => {
    const rig = makeRig();
    await expect(
      rig.tracker.file({
        title: "t",
        flow: { version: 1, entry: "implement", nodes: { implement: { kind: "worker", cast: { harness: "pi" }, onPass: "done", onFail: "park" } } },
        flowScript: "x.mjs",
      }),
    ).rejects.toThrow(/not both/);
  });

  it("a broken script fails the filing and stores nothing", async () => {
    const rig = makeRig();
    const bad = scriptFile(`export default () => ({ version: 1, entry: "x", nodes: {} });`);
    await expect(rig.tracker.file({ title: "t", flowScript: bad })).rejects.toThrow(/bad_entry/);
    expect(rig.tracker.list()).toHaveLength(0);
  });
});

describe("hooks — the scripted concierge", () => {
  it("auto-approves a human gate per the script's policy", async () => {
    const rig = makeRig();
    const script = scriptFile(`
      export default ({ flow }) =>
        flow()
          .worker("implement", { cast: { harness: "pi", effort: "low" }, onPass: "approve" })
          .gate("approve", { by: "human", onPass: "done", onFail: "implement" })
          .build();
      export const hooks = {
        async onEvent({ event, actions }) {
          if (event.type === "parked" && event.reason === "human_gate") {
            await actions.decideGate("approve", "pass", "auto-approved: low-risk policy");
          }
        },
      };
    `);
    const t = await rig.tracker.file({ title: "low-risk chore", flowScript: script });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    await rig.tracker.settle(); // the hook fires off the event path
    expect(rig.tracker.get(t.ref).state).toBe("done");
    const decided = rig.tracker.engine.store
      .readEvents(t.ref)
      .find((e) => e.type === "gate_decided");
    expect(decided).toMatchObject({ by: "human", verdict: "pass", note: "auto-approved: low-risk policy" });
  });

  it("auto-grants one extra visit when the rework loop parks (adaptive example)", async () => {
    const rig = makeRig();
    const t = await rig.tracker.file({
      title: "stubborn feature",
      body: "plain",
      criteria: ["a", "b", "c"], // → reviewed lifecycle, high effort
      flowScript: path.resolve("examples/flows/adaptive.flow.mjs"),
    });
    // burn all three rework cycles
    for (let visit = 1; visit <= 3; visit++) {
      const seat = rig.adapter.seat("implement", { visit });
      await seat.ready();
      await seat.complete();
      if (visit < 3) {
        const review = rig.adapter.seat("review", { visit });
        await review.ready();
        await review.complete({ data: { pass: false } });
      }
    }
    const review3 = rig.adapter.seat("review", { visit: 3 });
    await review3.ready();
    await review3.complete({ data: { pass: false } });
    // the park fires; the hook resumes with +1 visit
    await rig.tracker.settle();
    const run = rig.tracker.engine.status(t.ref);
    expect(run.status).toBe("running");
    expect(run.visits["implement"]).toBe(4);
    const resumed = rig.tracker.engine.store.readEvents(t.ref).find((e) => e.type === "resumed");
    expect(resumed).toMatchObject({ grant: { extraVisits: 1 } });
  });

  it("a hook can file follow-up work that depends on this ticket", async () => {
    const rig = makeRig();
    const script = scriptFile(`
      export default ({ presets }) => presets.onePass();
      export const hooks = {
        async onEvent({ ref, event, actions }) {
          if (event.type === "run_done") {
            await actions.file({ title: "follow-up: docs for " + ref, autoStaff: false });
          }
        },
      };
    `);
    const t = await rig.tracker.file({ title: "main work", flowScript: script });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    await rig.tracker.settle();
    const followUp = rig.tracker.list().find((x) => x.title.startsWith("follow-up"));
    expect(followUp).toBeTruthy();
    expect(followUp!.title).toContain(t.ref);
    expect(followUp!.state).toBe("todo");
  });

  it("hook errors are journalled, never crash the run", async () => {
    const rig = makeRig();
    const script = scriptFile(`
      export default ({ presets }) => presets.onePass();
      export const hooks = {
        onEvent({ event }) {
          if (event.type === "run_done") throw new Error("policy engine exploded");
        },
      };
    `);
    const t = await rig.tracker.file({ title: "t", flowScript: script });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    await rig.tracker.settle();
    expect(rig.tracker.get(t.ref).state).toBe("done"); // unharmed
    expect(
      rig.tracker.engine.store.readJournal(t.ref).some((l) => l.includes("policy engine exploded")),
    ).toBe(true);
  });

  it("recovery reloads hooks from the stored script path", async () => {
    const rig = makeRig();
    const script = scriptFile(`
      export default ({ flow }) =>
        flow()
          .worker("implement", { cast: { harness: "pi", effort: "low" }, onPass: "approve" })
          .gate("approve", { by: "human", onPass: "done", onFail: "implement" })
          .build();
      export const hooks = {
        async onEvent({ event, actions }) {
          if (event.type === "parked" && event.reason === "human_gate") {
            await actions.decideGate("approve", "pass", "auto-approved after reboot");
          }
        },
      };
    `);
    const t = await rig.tracker.file({ title: "survives reboots", flowScript: script });
    const seat = rig.adapter.seat("implement");
    await seat.ready();

    // reboot before the gate is reached
    const rebooted = makeRig(rig.root);
    await rebooted.tracker.recover();
    expect(rebooted.tracker.hookRefs()).toContain(t.ref);
    // recovery re-staffed the seat; drive it to the gate — the reloaded hook approves
    const seat2 = rebooted.adapter.seat("implement", { attempt: 2 });
    await seat2.ready();
    await seat2.complete();
    await rebooted.tracker.settle();
    expect(rebooted.tracker.get(t.ref).state).toBe("done");
    const decided = rebooted.tracker.engine.store
      .readEvents(t.ref)
      .find((e) => e.type === "gate_decided");
    expect(decided).toMatchObject({ note: "auto-approved after reboot" });
  });
});
