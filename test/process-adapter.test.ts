/**
 * The real agent-spawn adapter, end to end: the engine provisions a git
 * worktree, spawns an actual node child process, the process reads the
 * stage manifest, completes the §6.4 readiness handshake against real git
 * state, does real work (writes + commits a file), emits its done-signal
 * over the JSONL protocol — and the run completes. Plus the failure paths:
 * silent exit, refusal, and nudges over stdin.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CollectingSink,
  GitMergeProvider,
  GitWorktreeSpawnAdapter,
  ProcessSpawnAdapter,
  StageManager,
  Tracker,
  coerceWorkerEvent,
  presets,
  systemClock,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ros-proc-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "engine@test");
  git(dir, "config", "user.name", "engine");
  fs.writeFileSync(path.join(dir, "README.md"), "# repo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/**
 * A minimal real worker: reads BECKETT_MANIFEST, proves where it is via
 * git, writes a file, commits, and signals done. Behaviour switches on
 * WORKER_MODE so the failure paths use the same binary.
 */
const WORKER_JS = `
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const manifest = JSON.parse(fs.readFileSync(process.env.BECKETT_MANIFEST, "utf8"));
const mode = process.env.WORKER_MODE || "complete";

emit({ kind: "session_started" });
if (mode === "refuse") {
  emit({ kind: "worker_refused", observed: { branch: git("rev-parse", "--abbrev-ref", "HEAD"), reason: "env check failed: dirty state" } });
  process.exit(0);
}
emit({
  kind: "worker_ready",
  manifestHash: manifest.manifestHash,
  observedBranch: git("rev-parse", "--abbrev-ref", "HEAD"),
  observedSha: git("rev-parse", "HEAD"),
});
if (mode === "crash") process.exit(137);
if (mode === "hang-with-child" || mode === "die-with-child") {
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.env.PID_FILE, String(child.pid));
  if (mode === "die-with-child") process.exit(23);
  setInterval(() => {}, 1000);
  return;
}
if (mode === "hang-for-nudge") {
  // wait for a nudge on stdin, acknowledge it, echo it into the summary, finish
  let buf = "";
  process.stdin.on("data", (c) => {
    buf += c.toString();
    const line = buf.split("\\n")[0];
    if (!line) return;
    const msg = JSON.parse(line);
    if (msg.steerId) emit({ kind: "nudge_ack", steerId: msg.steerId }); // confirm pickup
    emit({ kind: "turn_completed", turn: 1, toolCalls: 1, tokens: { input: 10, output: 5 } });
    emit({ kind: "finished", signal: { status: "complete", summary: "heard: " + msg.text, filesChanged: [], checksRun: null, blockedReason: null }, spendUsd: 0.01 });
    process.exit(0);
  });
  emit("waiting"); // non-protocol chatter — must be ignored
  return;
}
// mode === "complete": do real work
emit({ kind: "turn_completed", turn: 1, toolCalls: 2, tokens: { input: 500, output: 200 } });
fs.writeFileSync("output.txt", "made by a real worker for " + manifest.taskRef + "\\n");
emit({ kind: "file_change", path: "output.txt" });
git("add", "-A");
git("commit", "-m", "worker output");
emit({ kind: "checkpoint", sha: git("rev-parse", "HEAD") });
emit({
  kind: "finished",
  signal: { status: "complete", summary: "wrote output.txt", filesChanged: ["output.txt"], checksRun: null, blockedReason: null },
  spendUsd: 0.05,
});
`;

interface ProcRig {
  engine: StageManager;
  adapter: ProcessSpawnAdapter;
  git: GitWorktreeSpawnAdapter;
  repo: string;
  sink: CollectingSink;
  workerPath: string;
}

function makeProcRig(
  env: Record<string, string> = {},
  processOpts: { killGraceMs?: number; executionTimeoutMs?: number } = {},
): ProcRig {
  const repo = makeRepo();
  const workerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ros-worker-")), "worker.cjs");
  fs.writeFileSync(workerPath, WORKER_JS);
  const gitAdapter = new GitWorktreeSpawnAdapter(repo, systemClock);
  const adapter = new ProcessSpawnAdapter(gitAdapter, () => ({
    cmd: process.execPath,
    args: [workerPath],
    env,
  }), processOpts);
  const sink = new CollectingSink();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ros-proc-store-"));
  const engine = new StageManager(root, adapter, new GitMergeProvider(gitAdapter), sink, {
    clock: systemClock,
    ownerDM: "dm",
  });
  adapter.connect((ref, seatKey, ev) => engine.deliverWorkerEvent(ref, seatKey, ev));
  return { engine, adapter, git: gitAdapter, repo, sink, workerPath };
}

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("ProcessSpawnAdapter — a real child process runs the work", () => {
  it("spawns, handshakes against real git state, commits real output, completes the run", async () => {
    const rig = makeProcRig();
    await rig.engine.open("#p1", presets.onePass(), {
      body: "write output.txt",
      criteria: ["output.txt exists"],
    });
    await waitFor(() => rig.engine.status("#p1").status === "done", "run to complete");

    const run = rig.engine.status("#p1");
    expect(run.spend.usd).toBeCloseTo(0.05);
    const types = rig.engine.store.readEvents("#p1").map((e) => e.type);
    expect(types).toContain("worker_ready"); // the handshake really verified
    expect(types).toContain("checkpoint_committed");
    // the work is really on the task branch
    const worktree = rig.git.taskWorktree("#p1");
    expect(fs.readFileSync(path.join(worktree, "output.txt"), "utf8")).toContain("#p1");
    expect(git(worktree, "log", "--format=%s", "-1")).toBe("worker output");
    // the manifest + brief were really written for the worker
    expect(fs.existsSync(path.join(worktree, ".beckett", "stage-manifest.json"))).toBe(true);
    const brief = fs.readFileSync(path.join(worktree, ".beckett", "brief.md"), "utf8");
    expect(brief).toContain("write output.txt");
    expect(brief).toContain("output.txt exists");
  });

  it("a process dying without a done-signal synthesizes it, alarms, and re-staffs", async () => {
    const rig = makeProcRig({ WORKER_MODE: "crash" });
    const spec = presets.onePass();
    spec.nodes["implement"]!.retries = 1;
    await rig.engine.open("#p2", spec, { body: "b" });
    // attempt 1 crashes → retry → attempt 2 crashes → retries exhausted → park
    await waitFor(() => rig.engine.status("#p2").status === "parked", "retries to exhaust");
    const run = rig.engine.status("#p2");
    expect(run.parked?.reason).toBe("retries_exhausted");
    const events = rig.engine.store.readEvents("#p2");
    expect(events.filter((e) => e.type === "seat_spawned")).toHaveLength(2);
    expect(
      events.some(
        (e) => e.type === "alarm_raised" && (e as { alarm: { type: string } }).alarm.type === "silent_exit",
      ),
    ).toBe(true);
    expect(rig.sink.pages().map((a) => a.eventType)).toContain("parked");
  });

  it("a worker refusing its environment check walks the refusal path", async () => {
    const rig = makeProcRig({ WORKER_MODE: "refuse" });
    const spec = presets.onePass();
    spec.nodes["implement"]!.retries = 0;
    await rig.engine.open("#p3", spec, { body: "b" });
    await waitFor(() => rig.engine.status("#p3").status === "parked", "refusal to park");
    const events = rig.engine.store.readEvents("#p3").map((e) => e.type);
    expect(events).toContain("worker_refused");
  });

  it("nudges reach the live process over stdin; non-protocol stdout is ignored", async () => {
    const rig = makeProcRig({ WORKER_MODE: "hang-for-nudge" });
    await rig.engine.open("#p4", presets.onePass(), { body: "b" });
    await waitFor(
      () => rig.engine.store.readEvents("#p4").some((e) => e.type === "worker_ready"),
      "worker to become ready",
    );
    const receipt = rig.engine.nudge("#p4", "prefer approach B");
    expect(receipt.receipt).toBe("delivered");
    expect(receipt.steerId).toBeDefined();
    await waitFor(() => rig.engine.status("#p4").status === "done", "nudged worker to finish");
    const signal = rig.engine.store
      .readEvents("#p4")
      .find((e) => e.type === "signal_received");
    expect((signal as { signal: { summary: string } }).signal.summary).toBe(
      "heard: prefer approach B",
    );
    // The worker acked the steer over stdin → the engine recorded it and the
    // durable buffer drained: injection was confirmed, not fire-and-forget.
    const acked = rig.engine.store
      .readEvents("#p4")
      .find((e) => e.type === "nudge_acked");
    expect(acked).toMatchObject({ steerId: receipt.steerId });
    expect(rig.engine.status("#p4").pendingSteers).toHaveLength(0);
  });

  it("reaps a worker process group and records WIP + an abort reason", async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ros-pid-")), "child.pid");
    const rig = makeProcRig({ WORKER_MODE: "hang-with-child", PID_FILE: pidFile }, { killGraceMs: 50 });
    await rig.engine.open("#p-abort", presets.onePass(), { body: "b" });
    await waitFor(() => fs.existsSync(pidFile), "grandchild PID");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await rig.engine.pause("#p-abort");
    await waitFor(() => pidIsGone(pid), "grandchild to be reaped");
    const events = rig.engine.store.readEvents("#p-abort");
    expect(events.some((event) => event.type === "seat_aborted" && event.reason === "operator pause")).toBe(true);
    expect(git(rig.git.taskWorktree("#p-abort"), "log", "--format=%s", "-1")).toContain("WIP: seat aborted");
  });

  it("reaps grandchildren after an unexpected worker death", async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ros-pid-")), "child.pid");
    const rig = makeProcRig({ WORKER_MODE: "die-with-child", PID_FILE: pidFile }, { killGraceMs: 50 });
    const spec = presets.onePass();
    spec.nodes["implement"]!.retries = 0;
    await rig.engine.open("#p-death", spec, { body: "b" });
    await waitFor(() => fs.existsSync(pidFile), "grandchild PID");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitFor(() => rig.engine.status("#p-death").status === "parked", "worker death to park");
    await waitFor(() => pidIsGone(pid), "dead worker's grandchild to be reaped");
    const events = rig.engine.store.readEvents("#p-death");
    expect(events.some((event) => event.type === "error_recorded" && event.code === "WORKER_UNEXPECTED_EXIT")).toBe(true);
    expect(events.some((event) => event.type === "seat_aborted" && event.reason === "worker_unexpected_exit")).toBe(true);
    expect(git(rig.git.taskWorktree("#p-death"), "log", "--format=%s", "-1")).toContain("WIP: seat aborted");
  });

  it("enforces a seat timeout, reaps descendants, and emits parseable timeout records", async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ros-pid-")), "child.pid");
    const rig = makeProcRig(
      { WORKER_MODE: "hang-with-child", PID_FILE: pidFile },
      { killGraceMs: 50, executionTimeoutMs: 150 },
    );
    const spec = presets.onePass();
    spec.nodes["implement"]!.retries = 0;
    await rig.engine.open("#p-timeout", spec, { body: "b" });
    await waitFor(() => fs.existsSync(pidFile), "grandchild PID");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitFor(() => rig.engine.status("#p-timeout").status === "parked", "timeout to park");
    await waitFor(() => pidIsGone(pid), "timed-out grandchild to be reaped");
    const events = rig.engine.store.readEvents("#p-timeout");
    const timeout = events.find((event) => event.type === "seat_timeout");
    expect(timeout).toMatchObject({ ticketRef: "#p-timeout", runId: "#p-timeout", reason: "execution_timeout" });
    expect(timeout?.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(events.some((event) => event.type === "seat_aborted" && event.reason === "execution_timeout")).toBe(true);
    expect(git(rig.git.taskWorktree("#p-timeout"), "log", "--format=%s", "-1")).toContain("WIP: seat aborted");
  });

  it("works end to end under the tracker (ticket → real process → done)", async () => {
    const repo = makeRepo();
    const workerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ros-worker-")), "worker.cjs");
    fs.writeFileSync(workerPath, WORKER_JS);
    const gitAdapter = new GitWorktreeSpawnAdapter(repo, systemClock);
    const adapter = new ProcessSpawnAdapter(gitAdapter, () => ({
      cmd: process.execPath,
      args: [workerPath],
    }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ros-proc-tracker-"));
    const tracker = new Tracker(root, adapter, new GitMergeProvider(gitAdapter), new CollectingSink(), {
      clock: systemClock,
      ownerDM: "dm",
    });
    adapter.connect((ref, seatKey, ev) => tracker.engine.deliverWorkerEvent(ref, seatKey, ev));
    const ticket = await tracker.file({ title: "real work", body: "do it", flow: presets.onePass() });
    await waitFor(() => tracker.get(ticket.ref).state === "done", "ticket to reach done");
    const worktree = gitAdapter.taskWorktree(ticket.ref);
    expect(fs.existsSync(path.join(worktree, "output.txt"))).toBe(true);
  });
});

describe("coerceWorkerEvent — the protocol boundary", () => {
  it("accepts every well-formed kind and rejects malformed lines", () => {
    expect(coerceWorkerEvent({ kind: "session_started" })).toEqual({ kind: "session_started" });
    expect(
      coerceWorkerEvent({ kind: "worker_ready", manifestHash: "h", observedBranch: "b", observedSha: "s" }),
    ).toMatchObject({ kind: "worker_ready" });
    expect(coerceWorkerEvent({ kind: "worker_ready", manifestHash: "h" })).toBeNull();
    expect(coerceWorkerEvent({ kind: "file_change", path: "x" })).toMatchObject({ path: "x" });
    expect(coerceWorkerEvent({ kind: "file_change" })).toBeNull();
    expect(coerceWorkerEvent({ kind: "unknown_thing" })).toBeNull();
    expect(coerceWorkerEvent("chatter")).toBeNull();
    expect(coerceWorkerEvent(null)).toBeNull();
    const finished = coerceWorkerEvent({
      kind: "finished",
      signal: { status: "complete", summary: "s", filesChanged: ["a"], checksRun: null, blockedReason: null, data: { pass: true } },
      spendUsd: 1.5,
    });
    expect(finished).toMatchObject({
      kind: "finished",
      spendUsd: 1.5,
      signal: { status: "complete", data: { pass: true } },
    });
    // a garbage signal degrades to null (→ the silent-exit path), never throws
    expect(coerceWorkerEvent({ kind: "finished", signal: { status: "nonsense" } })).toMatchObject({
      kind: "finished",
      signal: null,
    });
  });
});
