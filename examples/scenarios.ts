/**
 * §7 — three simulated deployments, run stage-by-stage with real specs,
 * event logs and worker manifests: a one-pass fix, a fan-out feature, and a
 * failure that recovers. Shared by the runnable examples (deploy-*.ts) and
 * the deployment test suite, so what gets demonstrated is exactly what gets
 * asserted.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CollectingSink,
  ManualClock,
  SimulatedMergeProvider,
  SimulatedSpawnAdapter,
  StageManager,
  presets,
  type FlowRun,
  type RunEvent,
} from "../src/index.js";

export interface DeploymentRig {
  engine: StageManager;
  adapter: SimulatedSpawnAdapter;
  merger: SimulatedMergeProvider;
  sink: CollectingSink;
  clock: ManualClock;
  root: string;
}

export interface DeploymentReport {
  ref: string;
  rig: DeploymentRig;
  run: FlowRun;
  events: RunEvent[];
  journal: string[];
  /** narration checkpoints captured stage by stage */
  stages: string[];
}

export function makeDeploymentRig(root?: string): DeploymentRig {
  const clock = new ManualClock("2026-07-13T09:00:00.000Z");
  const adapter = new SimulatedSpawnAdapter(clock);
  const merger = new SimulatedMergeProvider();
  const sink = new CollectingSink();
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "ros-deploy-"));
  const engine = new StageManager(dir, adapter, merger, sink, {
    clock,
    maxWorkers: 8,
    ownerDM: "dm:ro",
    defaultChannel: "discord:ops-152",
  });
  adapter.connect((ref, seatKey, ev) => engine.deliverWorkerEvent(ref, seatKey, ev));
  return { engine, adapter, merger, sink, clock, root: dir };
}

function report(rig: DeploymentRig, ref: string, stages: string[]): DeploymentReport {
  return {
    ref,
    rig,
    run: rig.engine.status(ref),
    events: rig.engine.store.readEvents(ref),
    journal: rig.engine.store.readJournal(ref),
    stages,
  };
}

/**
 * Deployment 1 — the one-pass fix (§7.1). A README link fix filed at low
 * effort with a $2 spend cap: one seat, no gate, no reviewer, seven-ish
 * events, done in minutes. The shape today's "self" review tier compiles to.
 */
export async function deployOnePassFix(rig = makeDeploymentRig()): Promise<DeploymentReport> {
  const ref = "OPS-142";
  const stages: string[] = [];
  const spec = presets.onePass({ harness: "pi", effort: "low" });
  spec.budget = { usd: 2 };

  await rig.engine.open(ref, spec, {
    originChannel: "discord:ops",
    body: "Fix the broken quickstart link in README.md",
    criteria: ["the link resolves", "no other content changes"],
  });
  stages.push("filed: one-pass spec validated, run opened, implement seat requested");

  const seat = rig.adapter.seat("implement");
  stages.push(
    `manifest handed to the worker: branch ${seat.request.manifest.branch}, ` +
      `position ${seat.request.manifest.flow.position}, ` +
      `$${seat.request.manifest.budget.remainingUsd} remaining, ` +
      `envelope ${seat.request.manifest.envelope.turnCap} turns / ${seat.request.manifest.envelope.wallClockS}s`,
  );
  await seat.ready();
  stages.push("worker_ready: the §6.4 handshake verified branch, base sha and manifest hash");

  rig.clock.advance(45);
  await seat.turn(2, { input: 2200, output: 600 });
  await seat.fileChange("README.md");
  rig.clock.advance(30);
  await seat.complete({
    summary: "replaced the dead quickstart URL",
    filesChanged: ["README.md"],
    checksRun: ["markdown-link-check"],
    spendUsd: 0.35,
  });
  stages.push("done-signal complete → onPass → done; $0.35 of the $2 cap spent");

  return report(rig, ref, stages);
}

/**
 * Deployment 2 — the fan-out feature (§7.2, Fig 6's picture with data). A
 * backend arm and a frontend arm fork from one captured base into isolated
 * worktrees, finish out of order, hold at the barrier, merge in declared
 * order, then a fresh review gate passes the joined diff.
 */
export async function deployFanoutFeature(rig = makeDeploymentRig()): Promise<DeploymentReport> {
  const ref = "OPS-158";
  const stages: string[] = [];
  const spec = {
    version: 1,
    entry: "split",
    budget: { maxConcurrent: 2, usd: 30 },
    nodes: {
      split: {
        kind: "fanout",
        arms: [
          { cast: { harness: "pi", effort: "high" }, brief: "the API: endpoint + persistence" },
          { cast: { harness: "claude", model: "claude-sonnet-5", effort: "high" }, brief: "the UI: settings panel" },
        ],
        isolation: "worktree-each",
        join: "land",
        retries: 3,
      },
      land: { kind: "join", strategy: "all-merge", onPass: "review", onFail: "park" },
      review: {
        kind: "gate",
        by: {
          cast: { harness: "claude", model: "claude-sonnet-5", effort: "high" },
          rubric: "criteria-vs-diff, both halves present",
        },
        onPass: "done",
        onFail: "park",
        maxFails: 2,
      },
    },
  };

  await rig.engine.open(ref, spec, {
    originChannel: "discord:ops",
    body: "Notification preferences: API + settings UI",
    criteria: ["endpoint stores prefs", "panel round-trips them"],
  });
  const api = rig.adapter.seat("split", { arm: 0 });
  const ui = rig.adapter.seat("split", { arm: 1 });
  stages.push(
    `fanout: arm 0 → ${api.request.branch}, arm 1 → ${ui.request.branch}, ` +
      `both from base ${api.request.baseSha.slice(0, 8)} (captured once)`,
  );

  await api.ready();
  await ui.ready();
  rig.clock.advance(240);
  await ui.turn(6, { input: 9000, output: 3000 });
  await ui.complete({ summary: "settings panel wired", filesChanged: ["ui/panel.tsx"], spendUsd: 4.1 });
  stages.push("arm 1 (ui) finished FIRST and holds at the join barrier — arm_joined, barrier holds");

  rig.clock.advance(180);
  await api.turn(8, { input: 12000, output: 4200 });
  await api.complete({ summary: "endpoint + store done", filesChanged: ["api/prefs.ts"], spendUsd: 5.6 });
  stages.push(
    "arm 0 (api) finished; barrier met → merged arm 0 then arm 1 (declared order, not finish order) → join pass",
  );

  const review = rig.adapter.seat("review");
  await review.ready();
  rig.clock.advance(120);
  await review.complete({
    data: { pass: true, rubricScore: 0.94 },
    summary: "both halves present and consistent",
    spendUsd: 1.2,
  });
  stages.push("fresh review gate passed the joined diff → done");

  return report(rig, ref, stages);
}

/**
 * Deployment 3 — the failure that recovers (§7.3). Attempt 1 goes silent
 * (lease expires → status nudge → stall alarm → abort with WIP → retry);
 * the engine itself is then killed and rebooted mid-run (crash recovery
 * re-staffs from the checkpointed worktree); the recovered seat finishes,
 * the reviewer bounces it once (rework), and the second pass lands.
 * Nothing fails quietly: every abnormal event is announced.
 */
export async function deployFailureThatRecovers(
  rig = makeDeploymentRig(),
): Promise<DeploymentReport> {
  const ref = "OPS-161";
  const stages: string[] = [];
  await rig.engine.open(ref, presets.reviewedLifecycle(), {
    originChannel: "discord:ops",
    body: "Make the retry queue idempotent under duplicate delivery",
    criteria: ["duplicate deliveries are no-ops", "existing tests stay green"],
  });

  // ── stage 1: the silent worker
  const attempt1 = rig.adapter.seat("implement", { attempt: 1 });
  await attempt1.ready();
  await attempt1.turn();
  rig.clock.advance(100); // one quiet 90s window
  await rig.engine.tick();
  stages.push("attempt 1 quiet for 100s → strike 1: status-check nudge (no kill)");
  rig.clock.advance(100); // second quiet window → stall
  await rig.engine.tick();
  stages.push(
    "attempt 1 still silent → alarm_raised(stall) announced ≤60s; seat aborted with WIP committed; same-visit retry",
  );

  // ── stage 2: the engine dies under attempt 2 and reboots
  const attempt2 = rig.adapter.seat("implement", { attempt: 2 });
  await attempt2.ready();
  await attempt2.turn();
  const rebooted = makeDeploymentRig(rig.root); // same store, fresh process
  await rebooted.engine.recoverAll();
  stages.push(
    "engine crash + reboot: replay found a LIVE cursor, re-staffed attempt 3 from the checkpointed worktree (no retry burned)",
  );

  // ── stage 3: the recovered attempt finishes; review bounces it once
  const attempt3 = rebooted.adapter.seat("implement", { attempt: 3 });
  await attempt3.ready();
  rebooted.clock.advance(300);
  await attempt3.turn(9, { input: 14000, output: 5000 });
  await attempt3.complete({ summary: "idempotency keys added", filesChanged: ["src/queue.ts"], spendUsd: 3.2 });
  const review1 = rebooted.adapter.seat("review", { visit: 1 });
  await review1.ready();
  await review1.complete({
    data: { pass: false },
    summary: "changes requested: missing dedupe-window test",
    spendUsd: 0.9,
  });
  stages.push("review bounced it (rework 1 of 3) → implement re-entered at visit 2");

  // ── stage 4: rework lands
  const rework = rebooted.adapter.seat("implement", { visit: 2 });
  await rework.ready();
  rebooted.clock.advance(200);
  await rework.complete({ summary: "test added", filesChanged: ["test/queue.test.ts"], spendUsd: 1.1 });
  const review2 = rebooted.adapter.seat("review", { visit: 2 });
  await review2.ready();
  await review2.complete({ data: { pass: true }, summary: "clean", spendUsd: 0.8 });
  stages.push("rework passed review → done; the full ladder is in the event log");

  // merge both rigs' sinks for the report (the reboot has its own herald)
  rig.sink.announcements.push(...rebooted.sink.announcements);
  return { ...report(rebooted, ref, stages), rig: { ...rebooted, sink: rig.sink } };
}
