/**
 * The Seat Scheduler — §4. Admission control: global max_workers, per-run
 * budget.maxConcurrent, FIFO queueing, dedup by (run, node, visit, arm).
 * It schedules *intents*, not fully-built requests — provisioning happens at
 * admit time so a queued seat still forks from a fresh base.
 */
import type { NodeId } from "../spec/types.js";
import { seatKeyOf, type SeatKey } from "../run/events.js";

export interface SeatIntent {
  ref: string;
  node: NodeId;
  visit: number;
  arm?: number;
  attempt: number;
  /** per-run cap at request time (budget.maxConcurrent) */
  runCap?: number;
}

export type AdmitResult = "admitted" | "queued" | "dedup";

function dedupKey(intent: Pick<SeatIntent, "ref" | "node" | "visit" | "arm">): string {
  return `${intent.ref}::${seatKeyOf(intent.node, intent.visit, intent.arm)}`;
}

export class SeatScheduler {
  private live = new Map<string, SeatIntent>();
  private queue: SeatIntent[] = [];

  constructor(readonly maxWorkers: number) {}

  liveCount(ref?: string): number {
    if (ref == null) return this.live.size;
    let n = 0;
    for (const intent of this.live.values()) if (intent.ref === ref) n++;
    return n;
  }

  queuedCount(ref?: string): number {
    return ref == null
      ? this.queue.length
      : this.queue.filter((i) => i.ref === ref).length;
  }

  private fits(intent: SeatIntent): boolean {
    if (this.live.size >= this.maxWorkers) return false;
    if (intent.runCap != null && this.liveCount(intent.ref) >= intent.runCap) return false;
    return true;
  }

  /**
   * Ask for a seat. "dedup" means a seat with this identity is already live
   * or queued — the request is a replay (§4.3 step 5) and nothing happens.
   */
  request(intent: SeatIntent): AdmitResult {
    const key = dedupKey(intent);
    if (this.live.has(key)) return "dedup";
    if (this.queue.some((i) => dedupKey(i) === key)) return "dedup";
    if (this.fits(intent)) {
      this.live.set(key, intent);
      return "admitted";
    }
    this.queue.push(intent);
    return "queued";
  }

  /**
   * A seat finished/aborted: free the slot and pop every queued intent that
   * now fits (FIFO — first filed, first staffed).
   */
  release(ref: string, seatKey: SeatKey): SeatIntent[] {
    this.live.delete(`${ref}::${seatKey}`);
    const admitted: SeatIntent[] = [];
    const remaining: SeatIntent[] = [];
    for (const intent of this.queue) {
      if (this.fits(intent)) {
        this.live.set(dedupKey(intent), intent);
        admitted.push(intent);
      } else {
        remaining.push(intent);
      }
    }
    this.queue = remaining;
    return admitted;
  }

  /** Drop queued intents for one node/visit (straggler arms standing down). */
  dropQueued(ref: string, node: NodeId, visit: number): SeatIntent[] {
    const dropped = this.queue.filter(
      (i) => i.ref === ref && i.node === node && i.visit === visit,
    );
    this.queue = this.queue.filter(
      (i) => !(i.ref === ref && i.node === node && i.visit === visit),
    );
    return dropped;
  }

  /** Drop every live/queued entry for a run (cancel / park). */
  evictRun(ref: string): void {
    for (const key of [...this.live.keys()]) {
      if (key.startsWith(`${ref}::`)) this.live.delete(key);
    }
    this.queue = this.queue.filter((i) => i.ref !== ref);
  }
}
