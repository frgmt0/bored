/**
 * The Sentinel — §6.1. Liveness: consume worker events into leases, raise
 * typed alarms (stall, overrun, ready-timeout, silent-exit), drive the
 * escalation ladder's inputs. Never decides workflow — only reports.
 *
 * The primitive is a lease. Every LIVE seat holds one; it is renewed by any
 * real progress event from the driver stream — turns, tool calls, file
 * changes, checkpoints. The clocks watch silence, not speed: a slow worker
 * renews; a dead worker doesn't.
 */
import type { SuperviseSpec } from "../spec/types.js";
import type { AlarmType, SeatKey } from "../run/events.js";
import type { WorkerEvent } from "./ports.js";

export interface SeatWatch {
  ref: string;
  seatKey: SeatKey;
  spawnedAt: number;
  readyAt?: number;
  /** last real progress (renewals) */
  renewedAt: number;
  /** advisory envelope for overrun math */
  envelopeWallClockS: number;
  supervise: Required<SuperviseSpec>;
  /** activity accumulated since the last progress_noted rollup */
  turnsSinceNote: number;
  toolCallsSinceNote: number;
  tokensSinceNote: number;
  filesSinceNote: number;
  lastNotedAt?: number;
  /** quiet windows counted against quietStrikes */
  lastNudgeAtWindow?: number;
  raised: Set<AlarmType>;
  /** the driver said "stalled" outright */
  driverStalled: boolean;
}

export type SentinelAction =
  | {
      kind: "progress_noted";
      ref: string;
      seatKey: SeatKey;
      turns: number;
      filesTouched: number;
      tokens: number;
    }
  | { kind: "status_nudge"; ref: string; seatKey: SeatKey; quietForS: number }
  | { kind: "alarm"; ref: string; seatKey: SeatKey; type: AlarmType; evidence: string }
  | { kind: "hard_cap_kill"; ref: string; seatKey: SeatKey; liveForS: number };

export class Sentinel {
  private watches = new Map<string, SeatWatch>();

  constructor(
    /** hard wall-clock backstop, seconds (default 3600, floor 1800 — §1.6) */
    readonly hardCapS: number = 3600,
  ) {
    if (hardCapS < 1800) throw new Error("hardCapS floor is 1800s");
  }

  private key(ref: string, seatKey: SeatKey): string {
    return `${ref}::${seatKey}`;
  }

  track(args: {
    ref: string;
    seatKey: SeatKey;
    at: number;
    envelopeWallClockS: number;
    supervise: Required<SuperviseSpec>;
  }): void {
    this.watches.set(this.key(args.ref, args.seatKey), {
      ref: args.ref,
      seatKey: args.seatKey,
      spawnedAt: args.at,
      renewedAt: args.at,
      envelopeWallClockS: args.envelopeWallClockS,
      supervise: args.supervise,
      turnsSinceNote: 0,
      toolCallsSinceNote: 0,
      tokensSinceNote: 0,
      filesSinceNote: 0,
      // rate-limit from spawn: the first rollup lands ≥60s in, aggregated
      lastNotedAt: args.at,
      raised: new Set(),
      driverStalled: false,
    });
  }

  untrack(ref: string, seatKey: SeatKey): void {
    this.watches.delete(this.key(ref, seatKey));
  }

  watching(ref: string, seatKey: SeatKey): boolean {
    return this.watches.has(this.key(ref, seatKey));
  }

  /** Alarms currently raised for a seat (for clearing on recovery). */
  raisedAlarms(ref: string, seatKey: SeatKey): AlarmType[] {
    return [...(this.watches.get(this.key(ref, seatKey))?.raised ?? [])];
  }

  /** Feed one driver event; real progress renews the lease. */
  onWorkerEvent(ref: string, seatKey: SeatKey, ev: WorkerEvent, atMs: number): void {
    const watch = this.watches.get(this.key(ref, seatKey));
    if (!watch) return;
    switch (ev.kind) {
      case "session_started":
        watch.renewedAt = atMs;
        break;
      case "worker_ready":
        watch.readyAt = atMs;
        watch.renewedAt = atMs;
        break;
      case "turn_completed":
        watch.turnsSinceNote += 1;
        watch.toolCallsSinceNote += ev.toolCalls;
        watch.tokensSinceNote += ev.tokens.input + ev.tokens.output;
        watch.renewedAt = atMs;
        watch.driverStalled = false;
        break;
      case "file_change":
        watch.filesSinceNote += 1;
        watch.renewedAt = atMs;
        watch.driverStalled = false;
        break;
      case "checkpoint":
        watch.renewedAt = atMs;
        break;
      case "stalled":
        watch.driverStalled = true;
        break;
      case "worker_refused":
      case "finished":
        // terminal — the engine untracks; nothing to renew
        break;
    }
  }

  /**
   * Evaluate every lease against its run's SuperviseSpec (§6.1's three
   * clocks plus the hard backstop). Deterministic given the watch state and
   * `nowMs`; call it on a cadence (the engine's tick).
   */
  sweep(nowMs: number): SentinelAction[] {
    const actions: SentinelAction[] = [];
    for (const watch of this.watches.values()) {
      const { supervise } = watch;
      const liveForS = (nowMs - watch.spawnedAt) / 1000;
      const quietForS = (nowMs - watch.renewedAt) / 1000;

      // Ready deadline — the spawn-phase hang (§6.1).
      if (watch.readyAt == null && liveForS > supervise.readyS) {
        if (!watch.raised.has("ready_timeout")) {
          watch.raised.add("ready_timeout");
          actions.push({
            kind: "alarm",
            ref: watch.ref,
            seatKey: watch.seatKey,
            type: "ready_timeout",
            evidence: `no worker_ready ${Math.round(liveForS)}s after spawn (deadline ${supervise.readyS}s)`,
          });
        }
        continue; // a seat that never became ready gets no other clocks
      }

      // Hard wall-clock backstop — survives unchanged; firing means every
      // softer layer failed, so the engine pages on the kill (§6.1).
      if (liveForS > this.hardCapS) {
        actions.push({
          kind: "hard_cap_kill",
          ref: watch.ref,
          seatKey: watch.seatKey,
          liveForS,
        });
        continue;
      }

      // Quiet → stall ladder.
      const quietWindows = Math.floor(quietForS / supervise.leaseS);
      if (watch.driverStalled || quietWindows >= supervise.quietStrikes) {
        if (!watch.raised.has("stall")) {
          watch.raised.add("stall");
          actions.push({
            kind: "alarm",
            ref: watch.ref,
            seatKey: watch.seatKey,
            type: "stall",
            evidence: watch.driverStalled
              ? "driver emitted stalled"
              : `${quietWindows} quiet windows of ${supervise.leaseS}s (quietStrikes=${supervise.quietStrikes})`,
          });
        }
      } else if (quietWindows >= 1) {
        // Strike 1 — a status-check nudge, once per quiet window.
        if (watch.lastNudgeAtWindow !== quietWindows) {
          watch.lastNudgeAtWindow = quietWindows;
          actions.push({
            kind: "status_nudge",
            ref: watch.ref,
            seatKey: watch.seatKey,
            quietForS,
          });
        }
      }

      // Overrun — advisory alarm long before the backstop.
      const overrunAt = supervise.overrunFactor * watch.envelopeWallClockS;
      if (liveForS > overrunAt && !watch.raised.has("overrun")) {
        watch.raised.add("overrun");
        actions.push({
          kind: "alarm",
          ref: watch.ref,
          seatKey: watch.seatKey,
          type: "overrun",
          evidence: `live ${Math.round(liveForS)}s > ${supervise.overrunFactor} × ${watch.envelopeWallClockS}s envelope`,
        });
      }

      // progress_noted rollup — at most one per minute per seat (§6.1).
      const activity =
        watch.turnsSinceNote + watch.filesSinceNote + watch.tokensSinceNote > 0;
      const sinceNote = watch.lastNotedAt == null ? Infinity : (nowMs - watch.lastNotedAt) / 1000;
      if (activity && sinceNote >= 60) {
        actions.push({
          kind: "progress_noted",
          ref: watch.ref,
          seatKey: watch.seatKey,
          turns: watch.turnsSinceNote,
          filesTouched: watch.filesSinceNote,
          tokens: watch.tokensSinceNote,
        });
        watch.lastNotedAt = nowMs;
        watch.turnsSinceNote = 0;
        watch.toolCallsSinceNote = 0;
        watch.tokensSinceNote = 0;
        watch.filesSinceNote = 0;
      }
    }
    return actions;
  }
}
