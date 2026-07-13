/**
 * The ticket registry — tasks.json: "a local, locked, versioned registry"
 * (§1.5). Same durability posture as the run store: atomic tmp+rename
 * writes, a version counter bumped on every write for optimistic
 * concurrency, and an advisory directory lock so two processes never
 * interleave a read-modify-write.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Ticket } from "./ticket.js";

export interface TasksFile {
  /** bumped on every write; readers can detect concurrent mutation */
  version: number;
  /** allocator for top-level "#N" refs */
  nextId: number;
  /** allocator for "#N.x" child refs, keyed by parent ref */
  nextChild: Record<string, number>;
  tickets: Record<string, Ticket>;
}

const EMPTY: TasksFile = { version: 0, nextId: 1, nextChild: {}, tickets: {} };

export class VersionConflictError extends Error {
  constructor(expected: number, found: number) {
    super(`tasks.json version conflict: expected ${expected}, found ${found}`);
    this.name = "VersionConflictError";
  }
}

export class TicketStore {
  readonly file: string;
  private readonly lockDir: string;

  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.file = path.join(root, "tasks.json");
    this.lockDir = path.join(root, "tasks.json.lock");
  }

  read(): TasksFile {
    if (!fs.existsSync(this.file)) return structuredClone(EMPTY);
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as TasksFile;
    if (typeof parsed.version !== "number" || typeof parsed.tickets !== "object") {
      throw new Error(`tasks.json is corrupt at ${this.file}`);
    }
    return parsed;
  }

  /**
   * Locked read-modify-write. `mutate` receives the current file and
   * returns the value to expose to the caller; the (possibly mutated) file
   * is written back atomically with the version bumped.
   */
  update<T>(mutate: (tasks: TasksFile) => T): T {
    this.acquireLock();
    try {
      const tasks = this.read();
      const before = tasks.version;
      const result = mutate(tasks);
      const onDisk = fs.existsSync(this.file)
        ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as TasksFile).version
        : 0;
      if (onDisk !== before) throw new VersionConflictError(before, onDisk);
      tasks.version = before + 1;
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
      fs.renameSync(tmp, this.file);
      return result;
    } finally {
      this.releaseLock();
    }
  }

  get(ref: string): Ticket | undefined {
    return this.read().tickets[ref];
  }

  list(): Ticket[] {
    return Object.values(this.read().tickets);
  }

  private acquireLock(): void {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // A crashed holder leaves a stale lock; break it after 10s of age.
        try {
          const age = Date.now() - fs.statSync(this.lockDir).mtimeMs;
          if (age > 10_000) {
            fs.rmdirSync(this.lockDir);
            continue;
          }
        } catch {
          continue; // raced with the holder's release — retry
        }
        if (Date.now() > deadline) {
          throw new Error(`could not lock ${this.file} within 5s`);
        }
        // spin briefly; contention is rare and short (single-write registry)
        const until = Date.now() + 25;
        while (Date.now() < until) {
          /* busy-wait a hair — keeps the store dependency-free and sync */
        }
      }
    }
  }

  private releaseLock(): void {
    try {
      fs.rmdirSync(this.lockDir);
    } catch {
      // already released / broken by a peer — nothing to do
    }
  }
}
