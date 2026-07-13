#!/usr/bin/env node
/**
 * The operator surface. Read verbs go straight to the store; mutation goes
 * through the HTTP API (or boots the whole stack with `serve`), so the CLI
 * is no longer read-only.
 *
 * local reads:
 *   run-of-show lint <spec.json> [--max-workers N]
 *   run-of-show status <ref> [--root DIR]
 *   run-of-show journal <ref> [--root DIR] [--tail N]
 *   run-of-show events <ref> [--root DIR] [--tail N]
 *
 * the server:
 *   run-of-show serve [--root DIR] [--repo DIR] [--port N] [--worker "cmd arg…"]
 *
 * against a server (--api http://127.0.0.1:PORT):
 *   run-of-show board
 *   run-of-show file --title T [--body B] [--criteria C]… [--needs R]…
 *                    [--parent R] [--flow spec.json] [--no-auto-staff]
 *   run-of-show ticket <ref>
 *   run-of-show staff <ref>
 *   run-of-show nudge <ref> "text" [--node N]
 *   run-of-show gate <ref> --node N --verdict pass|fail [--note T]
 *   run-of-show pause <ref> | resume <ref> [--extra-visits N] | cancel <ref> [--reason T]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { lintFlowSpec } from "./spec/lint.js";
import { maxVisitsOf } from "./spec/types.js";
import { RunStore } from "./run/store.js";
import { Tracker } from "./tracker/tracker.js";
import { TrackerServer } from "./server.js";
import { GitWorktreeSpawnAdapter, GitMergeProvider } from "./adapters/git.js";
import { ProcessSpawnAdapter } from "./adapters/process.js";
import { systemClock, type Announcement } from "./engine/ports.js";

const argv = process.argv.slice(2);

function arg(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function args(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] != null) out.push(argv[i + 1]!);
  }
  return out;
}

function has(flag: string): boolean {
  return argv.includes(flag);
}

function rootDir(): string {
  return arg("--root") ?? path.join(os.homedir(), ".beckett");
}

function apiBase(): string {
  return arg("--api") ?? process.env["RUN_OF_SHOW_API"] ?? "http://127.0.0.1:7770";
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function api(method: string, pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${apiBase()}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) fail(`API ${res.status}: ${data.error ?? "unknown error"}`);
  return data;
}

const refPath = (ref: string, action?: string) =>
  `/tickets/${encodeURIComponent(ref)}${action ? `/${action}` : ""}`;

const [command, target] = argv;

switch (command) {
  case "lint": {
    if (!target) fail("usage: run-of-show lint <spec.json>");
    const data = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
    const maxWorkers = arg("--max-workers");
    const result = lintFlowSpec(data, maxWorkers ? { maxWorkers: Number(maxWorkers) } : {});
    if (result.ok) {
      console.log(`OK — ${Object.keys(result.spec!.nodes).length} nodes, entry "${result.spec!.entry}"`);
      if (result.requiresConfirm) console.log("note: a seat requires the confirm-before-cast handshake");
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
  case "serve": {
    const root = rootDir();
    const repo = arg("--repo") ?? process.cwd();
    const port = Number(arg("--port") ?? 7770);
    const workerCmd = arg("--worker");
    if (!workerCmd) {
      fail(
        'serve needs --worker "cmd arg…" — the command spawned per seat in its worktree (speaks the JSONL driver protocol; see src/adapters/process.ts)',
      );
    }
    const git = new GitWorktreeSpawnAdapter(repo, systemClock);
    const [cmd, ...cmdArgs] = workerCmd.split(/\s+/);
    const spawner = new ProcessSpawnAdapter(git, () => ({ cmd: cmd!, args: cmdArgs }));
    const sink = {
      deliver: (a: Announcement) =>
        console.log(`[${a.severity.toUpperCase()}] → ${a.target}: ${a.text}`),
    };
    const tracker = new Tracker(root, spawner, new GitMergeProvider(git), sink, {
      clock: systemClock,
      maxWorkers: Number(arg("--max-workers") ?? 4),
      ownerDM: arg("--owner-dm") ?? "owner",
    });
    spawner.connect((ref, seatKey, ev) => tracker.engine.deliverWorkerEvent(ref, seatKey, ev));
    void tracker.recover().then(async () => {
      const server = new TrackerServer(tracker);
      const bound = await server.listen(port);
      console.log(`run-of-show tracker listening on http://127.0.0.1:${bound} (root ${root}, repo ${repo})`);
    });
    break;
  }
  case "board": {
    void api("GET", "/tickets").then((data) => {
      const tickets = (data as { tickets: Array<Record<string, unknown>> }).tickets;
      for (const t of tickets) {
        console.log(
          `${String(t["ref"]).padEnd(8)} ${String(t["state"]).padEnd(13)} ${t["title"]}${t["stateReason"] ? `  (${t["stateReason"]})` : ""}`,
        );
      }
    });
    break;
  }
  case "file": {
    const title = arg("--title");
    if (!title) fail("usage: run-of-show file --title T [--body B] [--criteria C]… [--needs R]…");
    const flowFile = arg("--flow");
    void api("POST", "/tickets", {
      title,
      ...(arg("--body") !== undefined ? { body: arg("--body") } : {}),
      ...(args("--criteria").length ? { criteria: args("--criteria") } : {}),
      ...(args("--needs").length ? { needs: args("--needs") } : {}),
      ...(arg("--parent") !== undefined ? { parent: arg("--parent") } : {}),
      ...(arg("--channel") !== undefined ? { originChannel: arg("--channel") } : {}),
      ...(flowFile ? { flow: JSON.parse(fs.readFileSync(flowFile, "utf8")) } : {}),
      ...(has("--no-auto-staff") ? { autoStaff: false } : {}),
    }).then((data) => console.log(JSON.stringify((data as { ticket: unknown }).ticket, null, 2)));
    break;
  }
  case "ticket": {
    if (!target) fail("usage: run-of-show ticket <ref>");
    void api("GET", refPath(target)).then((d) => console.log(JSON.stringify(d, null, 2)));
    break;
  }
  case "staff": {
    if (!target) fail("usage: run-of-show staff <ref>");
    void api("POST", refPath(target, "staff")).then((d) => console.log(JSON.stringify(d, null, 2)));
    break;
  }
  case "nudge": {
    const text = argv[2];
    if (!target || !text) fail('usage: run-of-show nudge <ref> "text" [--node N]');
    void api("POST", refPath(target, "nudge"), {
      text,
      ...(arg("--node") !== undefined ? { node: arg("--node") } : {}),
    }).then((d) => console.log(JSON.stringify(d)));
    break;
  }
  case "gate": {
    const node = arg("--node");
    const verdict = arg("--verdict");
    if (!target || !node || !verdict) fail("usage: run-of-show gate <ref> --node N --verdict pass|fail");
    void api("POST", refPath(target, "gate"), {
      node,
      verdict,
      ...(arg("--note") !== undefined ? { note: arg("--note") } : {}),
    }).then((d) => console.log(JSON.stringify(d, null, 2)));
    break;
  }
  case "pause":
  case "cancel": {
    if (!target) fail(`usage: run-of-show ${command} <ref>`);
    void api("POST", refPath(target, command), {
      ...(arg("--reason") !== undefined ? { reason: arg("--reason") } : {}),
    }).then((d) => console.log(JSON.stringify(d, null, 2)));
    break;
  }
  case "resume": {
    if (!target) fail("usage: run-of-show resume <ref> [--extra-visits N] [--extra-usd N]");
    const grant: Record<string, number> = {};
    if (arg("--extra-visits")) grant["extraVisits"] = Number(arg("--extra-visits"));
    if (arg("--extra-usd")) grant["extraUsd"] = Number(arg("--extra-usd"));
    void api("POST", refPath(target, "resume"), Object.keys(grant).length ? { grant } : {}).then(
      (d) => console.log(JSON.stringify(d, null, 2)),
    );
    break;
  }
  default:
    fail(
      "usage: run-of-show <lint|status|journal|events|serve|board|file|ticket|staff|nudge|gate|pause|resume|cancel> ...",
    );
}
