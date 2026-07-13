/**
 * Git-backed adapters: real worktrees, real branches, real merges — the
 * spawn-path pieces §5.2/§5.4 reuse (createWorktree, base-sha capture,
 * mergeBranchesIntoWorktree). Workers stay simulated (SimSeat), but every
 * provision/merge here talks to an actual repository, so the fan-out /
 * all-merge / conflict semantics are exercised against git itself.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { refToSlug } from "../run/store.js";
import type {
  Clock,
  MergeOutcome,
  MergeProvider,
  SeatRequest,
  WorkerHandle,
} from "../engine/ports.js";
import { SimSeat, type Deliver, type SeatScript } from "./simulated.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export class GitWorktreeSpawnAdapter {
  readonly seats: SimSeat[] = [];
  private deliverFn: Deliver | null = null;
  private scripts = new Map<string, SeatScript>();
  private scriptQueue: Array<() => Promise<void>> = [];

  constructor(
    /** the primary checkout the task worktrees hang off */
    readonly repoRoot: string,
    private readonly clock: Clock,
  ) {}

  connect(deliver: Deliver): void {
    this.deliverFn = deliver;
  }

  script(node: string, script: SeatScript): void {
    this.scripts.set(node, script);
  }

  async settle(): Promise<void> {
    while (this.scriptQueue.length > 0) {
      const job = this.scriptQueue.shift()!;
      await job();
    }
  }

  taskBranch(ref: string): string {
    return `beckett/task-${refToSlug(ref)}`;
  }

  worktreesDir(): string {
    return path.join(this.repoRoot, ".beckett", "worktrees");
  }

  taskWorktree(ref: string): string {
    return path.join(this.worktreesDir(), refToSlug(ref));
  }

  private branchExists(branch: string): boolean {
    try {
      git(this.repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
      return true;
    } catch {
      return false;
    }
  }

  private headOf(branch: string): string {
    return git(this.repoRoot, "rev-parse", `refs/heads/${branch}`);
  }

  /**
   * Allocate (or reuse) the worktree for a seat identity. The task seat
   * lives at .beckett/worktrees/<slug> on beckett/task-<slug>; each fanout
   * arm gets .beckett/worktrees/<slug>/../<slug>-arm-N on
   * beckett/task-<slug>/arm-N, forked from the captured base (§5.4).
   */
  provision(id: {
    ref: string;
    node: string;
    visit: number;
    arm?: number;
    isolation?: "worktree-each" | "shared";
  }): { worktree: string; branch: string; baseSha: string } {
    const slug = refToSlug(id.ref);
    const taskBranch = this.taskBranch(id.ref);
    // Ensure the task branch + worktree exist first — arms fork from it.
    const taskTree = this.taskWorktree(id.ref);
    if (!this.branchExists(taskBranch)) {
      fs.mkdirSync(this.worktreesDir(), { recursive: true });
      git(this.repoRoot, "worktree", "add", taskTree, "-b", taskBranch, "HEAD");
    }
    const isArm = id.arm != null && id.isolation !== "shared";
    if (!isArm) {
      return { worktree: taskTree, branch: taskBranch, baseSha: this.headOf(taskBranch) };
    }
    // NB: "<task>/arm-N" would collide with the task branch in git's ref
    // hierarchy (a ref cannot be both a name and a directory), so arms use
    // a dot separator: beckett/task-42.1.arm-2.
    const armBranch = `${taskBranch}.arm-${id.arm}`;
    const armTree = path.join(this.worktreesDir(), `${slug}-arm-${id.arm}`);
    if (!this.branchExists(armBranch)) {
      const base = this.headOf(taskBranch); // base sha captured exactly once
      git(this.repoRoot, "worktree", "add", armTree, "-b", armBranch, base);
    }
    return { worktree: armTree, branch: armBranch, baseSha: this.headOf(armBranch) };
  }

  baseShaFor(ref: string): string {
    const branch = this.taskBranch(ref);
    return this.branchExists(branch) ? this.headOf(branch) : git(this.repoRoot, "rev-parse", "HEAD");
  }

  spawn(request: SeatRequest): WorkerHandle {
    if (!this.deliverFn) throw new Error("GitWorktreeSpawnAdapter not connected to an engine");
    const seat = new SimSeat(request, this.deliverFn, this.clock, () =>
      this.commitWip(request.worktree),
    );
    this.seats.push(seat);
    const script = this.scripts.get(request.node);
    if (script) this.scriptQueue.push(() => script(seat));
    return seat.handle;
  }

  /** Commit whatever is in the worktree (the abort/checkpoint path). */
  commitWip(worktree: string, message = "WIP checkpoint"): string {
    git(worktree, "add", "-A");
    try {
      git(worktree, "commit", "-m", message);
    } catch {
      // nothing to commit — fall through to current head
    }
    return git(worktree, "rev-parse", "HEAD");
  }

  /** Test/scenario helper: the "worker" writes a file and commits it. */
  writeAndCommit(seat: SimSeat, file: string, content: string, message?: string): string {
    const target = path.join(seat.request.worktree, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return this.commitWip(seat.request.worktree, message ?? `edit ${file}`);
  }

  seat(node: string, opts: { arm?: number; attempt?: number } = {}): SimSeat {
    const matches = this.seats.filter(
      (s) =>
        s.request.node === node &&
        (opts.arm === undefined || s.request.arm === opts.arm) &&
        (opts.attempt === undefined || s.request.attempt === opts.attempt),
    );
    const seat = matches[matches.length - 1];
    if (!seat) throw new Error(`no git-backed seat at node "${node}"`);
    return seat;
  }
}

/** all-merge / first / judge merges, against the real task worktree. */
export class GitMergeProvider implements MergeProvider {
  constructor(private readonly adapter: GitWorktreeSpawnAdapter) {}

  mergeArm(ref: string, armBranch: string): MergeOutcome {
    const worktree = this.adapter.taskWorktree(ref);
    try {
      git(worktree, "merge", "--no-ff", armBranch, "-m", `merge ${armBranch}`);
      return { ok: true, sha: git(worktree, "rev-parse", "HEAD") };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        git(worktree, "merge", "--abort");
      } catch {
        // no merge in progress — nothing to abort
      }
      return { ok: false, conflict: detail.split("\n")[0] ?? "merge conflict" };
    }
  }
}
