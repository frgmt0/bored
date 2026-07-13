/**
 * Real-git integration: worktree allocation, base-sha capture, arm forking
 * and the all-merge join running against an actual repository — the pieces
 * §5.2/§5.4 say are reused verbatim from today's spawn path.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CollectingSink,
  GitMergeProvider,
  GitWorktreeSpawnAdapter,
  ManualClock,
  StageManager,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ros-git-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "engine@test");
  git(dir, "config", "user.name", "engine");
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

interface GitRig {
  engine: StageManager;
  adapter: GitWorktreeSpawnAdapter;
  sink: CollectingSink;
  repo: string;
  clock: ManualClock;
}

function makeGitRig(): GitRig {
  const repo = makeRepo();
  const clock = new ManualClock();
  const adapter = new GitWorktreeSpawnAdapter(repo, clock);
  const merger = new GitMergeProvider(adapter);
  const sink = new CollectingSink();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ros-git-store-"));
  const engine = new StageManager(root, adapter, merger, sink, { clock, ownerDM: "dm" });
  adapter.connect((ref, seatKey, ev) => engine.deliverWorkerEvent(ref, seatKey, ev));
  return { engine, adapter, sink, repo, clock };
}

const fanoutSpec = {
  version: 1,
  entry: "fan",
  nodes: {
    fan: {
      kind: "fanout",
      arms: [
        { cast: { harness: "pi", effort: "high" }, brief: "backend" },
        { cast: { harness: "codex", effort: "high" }, brief: "frontend" },
      ],
      isolation: "worktree-each",
      join: "join",
    },
    join: { kind: "join", strategy: "all-merge", onPass: "done", onFail: "park" },
  },
};

describe("git worktrees", () => {
  let rig: GitRig;
  beforeEach(() => {
    rig = makeGitRig();
  });

  it("provisions the task worktree on a real branch with the real head sha", async () => {
    await rig.engine.open("#101", {
      version: 1,
      entry: "implement",
      nodes: {
        implement: { kind: "worker", cast: { harness: "pi", effort: "low" }, onPass: "done", onFail: "park" },
      },
    }, { body: "b" });
    const seat = rig.adapter.seat("implement");
    expect(seat.request.branch).toBe("beckett/task-101");
    expect(fs.existsSync(seat.request.worktree)).toBe(true);
    expect(git(seat.request.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "beckett/task-101",
    );
    expect(seat.request.baseSha).toBe(git(rig.repo, "rev-parse", "HEAD"));
    // the honest readiness handshake verifies against the real repo state
    await seat.ready();
    await seat.complete();
    expect(rig.engine.status("#101").status).toBe("done");
  });

  it("re-provisioning the same seat identity reuses the worktree (checkpointed re-staff)", async () => {
    const a = rig.adapter.provision({ ref: "#102", node: "implement", visit: 1 });
    fs.writeFileSync(path.join(a.worktree, "wip.txt"), "half-done work");
    rig.adapter.commitWip(a.worktree, "WIP");
    const b = rig.adapter.provision({ ref: "#102", node: "implement", visit: 1 });
    expect(b.worktree).toBe(a.worktree);
    expect(b.branch).toBe(a.branch);
    expect(b.baseSha).not.toBe(a.baseSha); // head moved with the checkpoint
    expect(fs.existsSync(path.join(b.worktree, "wip.txt"))).toBe(true);
  });
});

describe("fan-out and rejoin on real branches (Fig 6)", () => {
  it("both arms fork from one captured base; all-merge lands both files on the task branch in arm order", async () => {
    const rig = makeGitRig();
    await rig.engine.open("#103", fanoutSpec, { body: "backend+frontend feature" });

    const arm0 = rig.adapter.seat("fan", { arm: 0 });
    const arm1 = rig.adapter.seat("fan", { arm: 1 });
    // both forked from the same base F0
    expect(arm0.request.baseSha).toBe(arm1.request.baseSha);
    expect(arm0.request.branch).toBe("beckett/task-103.arm-0");
    expect(arm1.request.branch).toBe("beckett/task-103.arm-1");

    await arm0.ready();
    await arm1.ready();
    // each "worker" writes a different file in its own worktree
    rig.adapter.writeAndCommit(arm0, "src/api.ts", "export const api = 1;\n");
    rig.adapter.writeAndCommit(arm1, "src/ui.ts", "export const ui = 1;\n");
    await arm1.complete({ summary: "ui done" }); // slowest-first finish order
    await arm0.complete({ summary: "api done" });

    const run = rig.engine.status("#103");
    expect(run.status).toBe("done");
    // the task branch carries both arms' work, merged in declared order
    const taskTree = rig.adapter.taskWorktree("#103");
    expect(fs.existsSync(path.join(taskTree, "src/api.ts"))).toBe(true);
    expect(fs.existsSync(path.join(taskTree, "src/ui.ts"))).toBe(true);
    const log = git(taskTree, "log", "--format=%s");
    expect(log).toContain("merge beckett/task-103.arm-0");
    expect(log).toContain("merge beckett/task-103.arm-1");
    const arm0MergeIdx = log.indexOf("merge beckett/task-103.arm-1"); // newest first
    const arm1MergeIdx = log.indexOf("merge beckett/task-103.arm-0");
    expect(arm0MergeIdx).toBeLessThan(arm1MergeIdx); // arm 0 merged before arm 1
  });

  it("a real conflict parks the half-merged join with the task branch at the last clean merge", async () => {
    const rig = makeGitRig();
    // seed a file both arms will edit
    fs.writeFileSync(path.join(rig.repo, "shared.txt"), "original\n");
    git(rig.repo, "add", "-A");
    git(rig.repo, "commit", "-q", "-m", "seed shared file");

    await rig.engine.open("#104", fanoutSpec, { body: "conflicting edits" });
    const arm0 = rig.adapter.seat("fan", { arm: 0 });
    const arm1 = rig.adapter.seat("fan", { arm: 1 });
    await arm0.ready();
    await arm1.ready();
    rig.adapter.writeAndCommit(arm0, "shared.txt", "arm zero's version\n");
    rig.adapter.writeAndCommit(arm1, "shared.txt", "arm one's version\n");
    await arm0.complete();
    await arm1.complete();

    const run = rig.engine.status("#104");
    expect(run.status).toBe("parked");
    expect(run.parked?.reason).toBe("join_conflict");
    expect(run.parked?.detail).toContain("arm 1");
    // the task branch sits at the last clean merge: arm 0's content, no
    // conflict markers, nothing force-pushed (§5.4)
    const taskTree = rig.adapter.taskWorktree("#104");
    expect(fs.readFileSync(path.join(taskTree, "shared.txt"), "utf8")).toBe(
      "arm zero's version\n",
    );
    expect(git(taskTree, "status", "--porcelain")).toBe(""); // merge aborted cleanly
  });
});
