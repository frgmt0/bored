import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CollectingSink,
  ManualClock,
  SimulatedMergeProvider,
  SimulatedSpawnAdapter,
  StageManager,
  type StageManagerOptions,
} from "../src/index.js";

export interface Rig {
  engine: StageManager;
  adapter: SimulatedSpawnAdapter;
  merger: SimulatedMergeProvider;
  sink: CollectingSink;
  clock: ManualClock;
  root: string;
}

export function makeRig(opts: Partial<StageManagerOptions> = {}): Rig {
  const clock = new ManualClock();
  const adapter = new SimulatedSpawnAdapter(clock);
  const merger = new SimulatedMergeProvider();
  const sink = new CollectingSink();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-of-show-test-"));
  const engine = new StageManager(root, adapter, merger, sink, {
    clock,
    ownerDM: "dm:owner",
    defaultChannel: "chan:default",
    ...opts,
  });
  adapter.connect((ref, seatKey, ev) => engine.deliverWorkerEvent(ref, seatKey, ev));
  return { engine, adapter, merger, sink, clock, root };
}

/** A rig whose engine is a fresh process over the same store (recovery tests). */
export function rebootRig(rig: Rig, opts: Partial<StageManagerOptions> = {}): Rig {
  const adapter = new SimulatedSpawnAdapter(rig.clock);
  const merger = new SimulatedMergeProvider();
  const sink = new CollectingSink();
  const engine = new StageManager(rig.root, adapter, merger, sink, {
    clock: rig.clock,
    ownerDM: "dm:owner",
    defaultChannel: "chan:default",
    ...opts,
  });
  adapter.connect((ref, seatKey, ev) => engine.deliverWorkerEvent(ref, seatKey, ev));
  return { engine, adapter, merger, sink, clock: rig.clock, root: rig.root };
}

export function eventTypes(rig: Rig, ref: string): string[] {
  return rig.engine.store.readEvents(ref).map((e) => e.type);
}
