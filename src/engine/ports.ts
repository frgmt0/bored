/**
 * The engine's ports — §4.2's three internal contracts plus the narrow
 * world-facing interfaces (worktrees, merges, announcements, time) that the
 * Spawn Adapter and Herald need. Everything here is dependency-injected so
 * each component is testable alone (§4).
 */
import type { HarnessSpec, NodeId } from "../spec/types.js";
import type { DoneSignal, SeatKey } from "../run/events.js";
import type { StageManifest } from "./manifest.js";

export interface TokenUsage {
  input: number;
  output: number;
}

/**
 * A single steer as it folds into a seat's brief — the injected context the
 * worker actually reads. The steer's stable `id` (which makes mid-run
 * injection deterministic rather than fire-and-forget, §5.5) is tracked in the
 * run's buffer (`pendingSteers`) for dedup and ack draining; it is internal
 * and does not ride into the brief, so a folded steer carries only its text
 * and timestamp.
 */
export interface Steer {
  text: string;
  at: string;
}

/**
 * How a mid-run steer is applied to a running agent:
 *  - `enqueue` (default): hand it to the live worker best-effort AND durably
 *    buffer it, so it is guaranteed to reach the run — acknowledged by the
 *    running worker, or folded into the next seat's brief. Never silently
 *    skipped; the in-flight seat is not disturbed.
 *  - `interrupt`: durably buffer it, then stop the in-flight seat (WIP is
 *    committed) and re-staff the same visit with the steer folded into a fresh
 *    brief — immediate, deterministic application to the current node's work.
 */
export type NudgeMode = "enqueue" | "interrupt";

export interface ArtifactRef {
  path: string;
  fromNode: NodeId;
}

/** Contract 2 — what the Stage Manager asks of the world when it wants a seat filled. */
export interface SeatRequest {
  /** identity — also the dedup key */
  ref: string;
  node: NodeId;
  visit: number;
  arm?: number;
  /** same-visit attempt counter (retry ladder) */
  attempt: number;
  seatKey: SeatKey;
  /** who sits down */
  cast: HarnessSpec;
  /** where they sit */
  worktree: string;
  branch: string;
  baseSha: string;
  briefParts: {
    body: string;
    criteria: string[];
    nodeBrief?: string;
    rubric?: string;
    priorArtifacts: ArtifactRef[];
    steers: Steer[];
  };
  /** §6.4 — the machine-readable handshake */
  manifest: StageManifest;
  /** advisory, as today */
  envelope: { turnCap: number; wallClockS: number };
}

/** Events a live worker emits — the driver event stream that already exists. */
export type WorkerEvent =
  | { kind: "session_started" }
  | {
      kind: "worker_ready";
      manifestHash: string;
      observedBranch: string;
      observedSha: string;
    }
  | {
      kind: "worker_refused";
      observed: { branch?: string; sha?: string; manifestHash?: string; reason?: string };
    }
  | { kind: "turn_completed"; turn: number; toolCalls: number; tokens: TokenUsage }
  | { kind: "file_change"; path: string }
  | { kind: "checkpoint"; sha: string }
  | { kind: "stalled" }
  /** The adapter killed the process group at its execution deadline. */
  | { kind: "timeout"; timeoutMs: number; reason: string }
  /** A non-terminal adapter/protocol failure with a stable code. */
  | { kind: "error"; code: string; message: string }
  /**
   * The adapter reaped a worker which could not complete its protocol. This
   * makes the WIP/abort receipt durable even when the worker died first.
   */
  | { kind: "aborted"; reason: string }
  /**
   * The worker confirms it picked up a steer at a safe checkpoint (the crux
   * of reliable mid-run injection: a steer is applied on ack, never assumed).
   */
  | { kind: "nudge_ack"; steerId: string }
  | {
      kind: "finished";
      signal: DoneSignal | null;
      error?: string;
      spendUsd?: number;
    };

export interface NudgeReceipt {
  /**
   * What happened to the live hand-off:
   *  - `delivered`: streamed to a live worker over the wire (best-effort);
   *  - `queued`: no live worker matched — buffered for the next seat;
   *  - `will-restart`: the in-flight seat was interrupted and is being
   *    re-staffed with the steer folded into a fresh brief;
   *  - `dropped`: the seat was already gone; nothing to deliver to.
   */
  receipt: "delivered" | "queued" | "will-restart" | "dropped";
  /** the steer's stable id — track it to a `nudge_ack` */
  steerId?: string;
  /**
   * True when the steer is durably buffered, i.e. guaranteed to reach the run
   * even if the live hand-off is ignored. Only `dropped` receipts (which never
   * occur for the engine verb) are un-buffered.
   */
  buffered?: boolean;
}

/** Contract 3 — what a live worker looks like from inside the engine. */
export interface WorkerHandle {
  seatKey: SeatKey;
  /**
   * Hand a steer to the live worker. `steerId`, when present, is echoed back
   * by the worker as a `nudge_ack` once it picks the steer up at a safe
   * checkpoint — turning fire-and-forget delivery into confirmed application.
   */
  nudge(text: string, steerId?: string): NudgeReceipt;
  /** commits WIP first; returns the checkpoint sha */
  abort(reason: string): Promise<string>;
  telemetry(): { turns: number; toolCalls: number; tokens: TokenUsage; wallClockS: number };
}

/**
 * The Spawn Adapter port — today's spawn path, verbatim, behind an
 * interface: worktree, branch, scope-guard, brief, envelope, done-signal
 * schema — plus, new, the stage manifest (§6.4).
 *
 * Provisioning is split out because the Stage Manager needs the branch and
 * base sha to build the manifest *before* the worker exists.
 */
export interface SpawnAdapter {
  /** Allocate (or reuse) the worktree/branch for a seat identity. */
  provision(id: {
    ref: string;
    node: NodeId;
    visit: number;
    arm?: number;
    isolation?: "worktree-each" | "shared";
  }): { worktree: string; branch: string; baseSha: string };
  /** Current head sha of the task branch (fanout base capture, §5.4). */
  baseShaFor(ref: string): string;
  /** Turn a SeatRequest into a live worker. */
  spawn(request: SeatRequest): WorkerHandle;
  /** Reap a worktree after first-join abort / cancel (best-effort). */
  reap?(ref: string, branch: string): void;
}

export type MergeOutcome = { ok: true; sha: string } | { ok: false; conflict: string };

/**
 * The merge machinery the all-merge / first / judge join strategies reuse
 * (mergeBranchesIntoWorktree today).
 */
export interface MergeProvider {
  /**
   * Merge one arm branch into the run's task branch (resolved from `ref`).
   * Never force-pushes (§5.4).
   */
  mergeArm(ref: string, armBranch: string): MergeOutcome;
}

/** Where the Herald delivers non-trace announcements (§6.3). */
export type AnnounceSeverity = "status" | "page";

export interface Announcement {
  severity: AnnounceSeverity;
  /** origin channel for status, owner DM for page */
  target: string;
  ref: string;
  eventType: string;
  eventSeq: number;
  /** when the announced event was appended */
  eventAt: string;
  /** when the Herald delivered it */
  deliveredAt: string;
  text: string;
}

export interface AnnounceSink {
  deliver(announcement: Announcement): void;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A hand-crank clock for tests and simulations. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: string | number = "2026-07-13T00:00:00.000Z") {
    this.t = typeof start === "number" ? start : Date.parse(start);
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(seconds: number): void {
    this.t += seconds * 1000;
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}
