#!/usr/bin/env node
/**
 * A minimal operator surface: lint a spec, render a run's status DAG,
 * tail a journal, dump the event log — "which is more visibility than the
 * Plane board offers now, not less" (§5.5).
 *
 *   run-of-show lint <spec.json> [--max-workers N]
 *   run-of-show status <ref> [--root DIR]
 *   run-of-show journal <ref> [--root DIR] [--tail N]
 *   run-of-show events <ref> [--root DIR] [--tail N]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { lintFlowSpec } from "./spec/lint.js";
import { maxVisitsOf } from "./spec/types.js";
import { RunStore } from "./run/store.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function rootDir(): string {
  return arg("--root") ?? path.join(os.homedir(), ".beckett");
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const [, , command, target] = process.argv;

switch (command) {
  case "lint": {
    if (!target) fail("usage: run-of-show lint <spec.json>");
    const data = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
    const maxWorkers = arg("--max-workers");
    const result = lintFlowSpec(data, maxWorkers ? { maxWorkers: Number(maxWorkers) } : {});
    if (result.ok) {
      console.log(`OK — ${Object.keys(result.spec!.nodes).length} nodes, entry "${result.spec!.entry}"`);
      if (result.requiresConfirm) {
        console.log("note: a seat requires the confirm-before-cast handshake");
      }
      process.exit(0);
    }
    for (const issue of result.errors) {
      console.error(`ERROR [${issue.code}]${issue.node ? ` at ${issue.node}` : ""}: ${issue.message}`);
    }
    process.exit(1);
  }
  case "status": {
    if (!target) fail("usage: run-of-show status <ref>");
    const store = new RunStore(rootDir());
    if (!store.exists(target)) fail(`no run "${target}" under ${rootDir()}`);
    const run = store.fold(target);
    console.log(`${run.taskRef} — ${run.status.toUpperCase()}${run.outcome ? ` (${run.outcome})` : ""}`);
    console.log(`opened ${run.openedAt}${run.closedAt ? `, closed ${run.closedAt}` : ""}`);
    console.log(`spend $${run.spend.usd.toFixed(2)}  seats ${Object.keys(run.seats).length}`);
    if (run.parked) {
      console.log(`parked: ${run.parked.reason}${run.parked.node ? ` at ${run.parked.node}` : ""} since ${run.parked.since}`);
    }
    console.log("nodes:");
    for (const [id, node] of Object.entries(run.spec.nodes)) {
      const visits = run.visits[id] ?? 0;
      const cursorsHere = run.cursors.filter((c) => c.node === id);
      const marks = [
        id === run.spec.entry ? "entry" : null,
        visits ? `visits ${visits}/${maxVisitsOf(node)}` : "unvisited",
        cursorsHere.length
          ? `cursor${cursorsHere.length > 1 ? "s" : ""}: ${cursorsHere
              .map((c) => `${c.phase}${c.arm != null ? `(arm ${c.arm})` : ""}`)
              .join(", ")}`
          : null,
        run.spend.byNode[id] ? `$${run.spend.byNode[id]!.toFixed(2)}` : null,
      ].filter(Boolean);
      console.log(`  ${id} [${node.kind}] — ${marks.join(" · ")}`);
    }
    if (run.activeAlarms.length) {
      console.log("alarms:");
      for (const a of run.activeAlarms) console.log(`  ${a.type}${a.seatKey ? ` on ${a.seatKey}` : ""}: ${a.evidence}`);
    }
    break;
  }
  case "journal": {
    if (!target) fail("usage: run-of-show journal <ref>");
    const store = new RunStore(rootDir());
    const lines = store.readJournal(target);
    const tail = Number(arg("--tail") ?? lines.length);
    for (const line of lines.slice(-tail)) console.log(line);
    break;
  }
  case "events": {
    if (!target) fail("usage: run-of-show events <ref>");
    const store = new RunStore(rootDir());
    const events = store.readEvents(target);
    const tail = Number(arg("--tail") ?? events.length);
    for (const ev of events.slice(-tail)) console.log(JSON.stringify(ev));
    break;
  }
  default:
    fail("usage: run-of-show <lint|status|journal|events> ...");
}
