/**
 * The Run Store — §4.5. Append-only JSONL event log per run plus a folded
 * head snapshot. Single writer, fsync'd, crash-truncation tolerant. The log
 * is the source of truth; the head snapshot is cache only, rebuilt from the
 * log at will. If a head snapshot is ever corrupt or stale it is discarded
 * and re-folded — corruption of the *log* is the only fatal case, and it
 * fails loudly at the exact line.
 *
 * Storage layout (§4.5), rooted at an engine-configured directory:
 *   runs/<ref>.jsonl       — the run event log (append-only, fsync'd)
 *   runs/<ref>.head.json   — folded FlowRun snapshot (cache only)
 *   journal/<ref>.log      — human-narrative journal (Herald trace lines)
 *   spend.jsonl            — SpendRecord ledger, keyed by seat
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunEvent, RunEventInput } from "./events.js";
import { foldRun, type FlowRun } from "./fold.js";

/** "#42.1" → a safe file slug. Deterministic, collision-averse enough for refs. */
export function refToSlug(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "run";
}

export class LogCorruptError extends Error {
  constructor(
    public readonly file: string,
    public readonly line: number,
    message: string,
  ) {
    super(`run log corrupt at ${file}:${line} — ${message}`);
    this.name = "LogCorruptError";
  }
}

export interface AppendResult {
  event: RunEvent;
}

export class RunStore {
  readonly runsDir: string;
  readonly journalDir: string;
  readonly spendPath: string;

  constructor(readonly root: string) {
    this.runsDir = path.join(root, "runs");
    this.journalDir = path.join(root, "journal");
    this.spendPath = path.join(root, "spend.jsonl");
    fs.mkdirSync(this.runsDir, { recursive: true });
    fs.mkdirSync(this.journalDir, { recursive: true });
  }

  logPath(ref: string): string {
    return path.join(this.runsDir, `${refToSlug(ref)}.jsonl`);
  }

  headPath(ref: string): string {
    return path.join(this.runsDir, `${refToSlug(ref)}.head.json`);
  }

  journalPath(ref: string): string {
    return path.join(this.journalDir, `${refToSlug(ref)}.log`);
  }

  exists(ref: string): boolean {
    return fs.existsSync(this.logPath(ref));
  }

  /** All run refs with a log on disk (by slug). */
  listRuns(): string[] {
    return fs
      .readdirSync(this.runsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  }

  /**
   * Append one event, stamped with the next seq and the given timestamp,
   * fsync'd before returning — §4.3 step 1: if this write fails, nothing
   * happened.
   */
  append(ref: string, at: string, input: RunEventInput): RunEvent {
    const events = this.readEvents(ref);
    const event = {
      seq: events.length + 1,
      at,
      timestamp: at,
      ticketRef: ref,
      // A ref has exactly one durable run; it is therefore the stable run id.
      runId: ref,
      reason: eventReason(input),
      ...input,
    } as RunEvent;
    const file = this.logPath(ref);
    const fd = fs.openSync(file, "a");
    try {
      fs.writeSync(fd, JSON.stringify(event) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return event;
  }

  /**
   * Tolerant reader: a truncated trailing line (mid-append crash) is
   * dropped; anything malformed before the tail fails loudly at the line.
   */
  readEvents(ref: string): RunEvent[] {
    const file = this.logPath(ref);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    // A well-formed log ends with "\n", so the final split element is "".
    const hadTrailingNewline = lines[lines.length - 1] === "";
    if (hadTrailingNewline) lines.pop();
    const events: RunEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      const isLast = i === lines.length - 1;
      try {
        const parsed = JSON.parse(line) as RunEvent;
        if (typeof parsed.seq !== "number" || typeof parsed.type !== "string") {
          throw new Error("missing seq/type");
        }
        events.push(parsed);
      } catch (err) {
        if (isLast && !hadTrailingNewline) {
          // Crash-truncation: the append never finished; the event never happened.
          break;
        }
        throw new LogCorruptError(file, i + 1, err instanceof Error ? err.message : String(err));
      }
    }
    return events;
  }

  /**
   * Fold the log (using the head snapshot when it is exactly current).
   * A stale or corrupt head is discarded and rebuilt — never trusted.
   */
  fold(ref: string): FlowRun {
    const events = this.readEvents(ref);
    const head = this.readHead(ref);
    if (head && head.lastSeq === events.length) return head;
    const run = foldRun(events);
    this.writeHead(ref, run);
    return run;
  }

  readHead(ref: string): FlowRun | null {
    const file = this.headPath(ref);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as FlowRun;
      if (typeof parsed.lastSeq !== "number" || typeof parsed.status !== "string") return null;
      return parsed;
    } catch {
      return null; // cache only — discard and re-fold
    }
  }

  writeHead(ref: string, run: FlowRun): void {
    const file = this.headPath(ref);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(run));
    fs.renameSync(tmp, file);
  }

  /** Human-narrative journal line — unchanged idiom, gains node context (§5.5). */
  journal(ref: string, at: string, line: string): void {
    fs.appendFileSync(this.journalPath(ref), `${at} ${line}\n`);
  }

  readJournal(ref: string): string[] {
    const file = this.journalPath(ref);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  }

  /** SpendRecord ledger — now keyed by seat, not stage (§4.5). */
  recordSpend(record: {
    ref: string;
    seatKey: string;
    at: string;
    usd: number;
    tokens: number;
    turns: number;
    wallClockS: number;
    outcome: string;
  }): void {
    fs.appendFileSync(this.spendPath, JSON.stringify(record) + "\n");
  }

  readSpend(): Array<Record<string, unknown>> {
    if (!fs.existsSync(this.spendPath)) return [];
    return fs
      .readFileSync(this.spendPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

/** A required concise reason makes each JSONL record independently useful. */
function eventReason(event: RunEventInput): string {
  switch (event.type) {
    case "seat_spawned": return "spawned";
    case "checkpoint_committed": return event.note ?? "checkpoint";
    case "seat_timeout":
    case "seat_aborted": return event.reason;
    case "error_recorded": return event.code;
    case "signal_received": return event.signal.blockedReason ?? event.subtype;
    case "gate_decided": return event.verdict;
    case "alarm_raised": return event.alarm.evidence;
    case "parked": return event.reason;
    case "run_cancelled": return event.reason ?? "cancelled";
    case "worker_refused": return event.observed.reason ?? "worker_refused";
    case "join_resolved": return event.reason ?? event.outcome;
    case "edge_taken": return event.why;
    case "budget_hit": return event.ceiling;
    case "run_done": return event.outcome;
    default: return event.type;
  }
}
