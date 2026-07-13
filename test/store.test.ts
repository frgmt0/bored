/**
 * §4.5 — the Run Store: append-only JSONL, fsync'd, crash-truncation
 * tolerant; head snapshot is cache only; corruption of the log is the only
 * fatal case and it fails loudly at the exact line.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LogCorruptError, RunStore, refToSlug } from "../src/run/store.js";
import { foldRun } from "../src/run/fold.js";
import type { RunEventInput } from "../src/run/events.js";
import * as presets from "../src/presets.js";

function tmpStore(): RunStore {
  return new RunStore(fs.mkdtempSync(path.join(os.tmpdir(), "ros-store-")));
}

const opened: RunEventInput = {
  type: "run_opened",
  taskRef: "#7.1",
  spec: presets.onePass(),
};

describe("refToSlug", () => {
  it("maps refs to safe, stable file names", () => {
    expect(refToSlug("#42.1")).toBe("42.1");
    expect(refToSlug("a/b c#d")).toBe("a_b_c_d");
    expect(refToSlug("###")).toBe("run");
  });
});

describe("RunStore append/read", () => {
  it("stamps monotonically increasing seqs and round-trips events", () => {
    const store = tmpStore();
    const e1 = store.append("#7.1", "2026-07-13T00:00:00.000Z", opened);
    const e2 = store.append("#7.1", "2026-07-13T00:00:01.000Z", {
      type: "node_entered",
      node: "implement",
      visit: 1,
    });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    const read = store.readEvents("#7.1");
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual(e1);
    expect(read[1]).toEqual(e2);
  });

  it("drops a truncated trailing line (mid-append crash) — the event never happened", () => {
    const store = tmpStore();
    store.append("#7.1", "2026-07-13T00:00:00.000Z", opened);
    store.append("#7.1", "2026-07-13T00:00:01.000Z", { type: "node_entered", node: "implement", visit: 1 });
    const file = store.logPath("#7.1");
    fs.appendFileSync(file, '{"seq":3,"at":"2026-07-13T00:00:02.000Z","type":"seat_spa'); // no newline
    const read = store.readEvents("#7.1");
    expect(read).toHaveLength(2);
    // and the next append lands cleanly after the tolerant read
    const e3 = store.append("#7.1", "2026-07-13T00:00:03.000Z", { type: "node_entered", node: "implement", visit: 2 });
    expect(e3.seq).toBe(3);
  });

  it("fails loudly at the exact line on mid-file corruption", () => {
    const store = tmpStore();
    store.append("#7.1", "2026-07-13T00:00:00.000Z", opened);
    store.append("#7.1", "2026-07-13T00:00:01.000Z", { type: "node_entered", node: "implement", visit: 1 });
    const file = store.logPath("#7.1");
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines[0] = '{"seq":1,GARBAGE';
    fs.writeFileSync(file, lines.join("\n"));
    expect(() => store.readEvents("#7.1")).toThrow(LogCorruptError);
    try {
      store.readEvents("#7.1");
    } catch (err) {
      expect((err as LogCorruptError).line).toBe(1);
    }
  });
});

describe("RunStore head snapshot", () => {
  it("is used when exactly current, rebuilt when stale, discarded when corrupt", () => {
    const store = tmpStore();
    store.append("#7.1", "2026-07-13T00:00:00.000Z", opened);
    const head1 = store.fold("#7.1");
    expect(head1.lastSeq).toBe(1);
    expect(fs.existsSync(store.headPath("#7.1"))).toBe(true);

    // stale: append bypassing head maintenance, then fold again
    store.append("#7.1", "2026-07-13T00:00:01.000Z", { type: "node_entered", node: "implement", visit: 1 });
    const head2 = store.fold("#7.1");
    expect(head2.lastSeq).toBe(2);
    expect(head2.visits["implement"]).toBe(1);

    // corrupt: garbage head is silently discarded and re-folded
    fs.writeFileSync(store.headPath("#7.1"), "NOT JSON");
    const head3 = store.fold("#7.1");
    expect(head3.lastSeq).toBe(2);
    expect(head3).toEqual(foldRun(store.readEvents("#7.1")));
  });
});

describe("RunStore journal and spend ledger", () => {
  it("appends narrative lines and spend records", () => {
    const store = tmpStore();
    store.journal("#7.1", "2026-07-13T00:00:00.000Z", "entered implement (visit 1)");
    store.journal("#7.1", "2026-07-13T00:00:05.000Z", "seat implement#v1 spawned");
    expect(store.readJournal("#7.1")).toHaveLength(2);
    expect(store.readJournal("#7.1")[0]).toContain("entered implement");

    store.recordSpend({
      ref: "#7.1",
      seatKey: "implement#v1",
      at: "2026-07-13T00:01:00.000Z",
      usd: 1.5,
      tokens: 42_000,
      turns: 9,
      wallClockS: 320,
      outcome: "complete",
    });
    const spend = store.readSpend();
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({ seatKey: "implement#v1", usd: 1.5 });
  });
});
