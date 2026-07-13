/**
 * The HTTP API: every mutation is reachable over the wire — file, staff,
 * nudge, gate, pause/resume, cancel — plus board and per-ticket reads.
 * Runs against a live server on an ephemeral port with simulated workers.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CollectingSink,
  ManualClock,
  SimulatedMergeProvider,
  SimulatedSpawnAdapter,
  Tracker,
  TrackerServer,
  presets,
} from "../src/index.js";

interface ServerRig {
  base: string;
  server: TrackerServer;
  tracker: Tracker;
  adapter: SimulatedSpawnAdapter;
}

let rig: ServerRig;

async function call(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${rig.base}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

const enc = (ref: string) => encodeURIComponent(ref);

beforeEach(async () => {
  const clock = new ManualClock();
  const adapter = new SimulatedSpawnAdapter(clock);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ros-server-"));
  const tracker = new Tracker(root, adapter, new SimulatedMergeProvider(), new CollectingSink(), {
    clock,
    ownerDM: "dm",
  });
  adapter.connect((ref, seatKey, ev) => tracker.engine.deliverWorkerEvent(ref, seatKey, ev));
  const server = new TrackerServer(tracker, { tickMs: 60_000 });
  const port = await server.listen(0);
  rig = { base: `http://127.0.0.1:${port}`, server, tracker, adapter };
});

afterEach(async () => {
  await rig.server.close();
});

describe("the tracker API", () => {
  it("health, file, board, ticket status", async () => {
    expect((await call("GET", "/health")).data).toEqual({ ok: true });

    const created = await call("POST", "/tickets", {
      title: "api-filed work",
      body: "over the wire",
      criteria: ["works"],
      flow: presets.onePass(),
    });
    expect(created.status).toBe(201);
    const ticket = created.data["ticket"] as { ref: string; state: string };
    expect(ticket.ref).toBe("#1");
    expect(ticket.state).toBe("in_progress"); // auto-staffed

    const board = await call("GET", "/tickets");
    expect((board.data["tickets"] as unknown[]).length).toBe(1);

    const status = await call("GET", `/tickets/${enc("#1")}`);
    expect(status.status).toBe(200);
    expect((status.data["run"] as { status: string }).status).toBe("running");
    expect(status.data["blockedOn"]).toEqual([]);
  });

  it("drives a full reviewed lifecycle over the wire, gate verdict included", async () => {
    await call("POST", "/tickets", {
      title: "human-gated",
      body: "b",
      flow: {
        version: 1,
        entry: "implement",
        nodes: {
          implement: {
            kind: "worker",
            cast: { harness: "pi", effort: "high" },
            onPass: "approve",
            onFail: "park",
          },
          approve: { kind: "gate", by: "human", onPass: "done", onFail: "implement" },
        },
      },
    });
    const seat = rig.adapter.seat("implement");
    await seat.ready();

    // steer it over the wire
    const nudged = await call("POST", `/tickets/${enc("#1")}/nudge`, { text: "small diff please" });
    expect(nudged.data["receipt"]).toBe("delivered");
    expect(seat.nudges).toContain("small diff please");

    await seat.complete();
    // parked at the human gate → in_review column
    const parked = await call("GET", `/tickets/${enc("#1")}`);
    expect((parked.data["ticket"] as { state: string }).state).toBe("in_review");

    const gated = await call("POST", `/tickets/${enc("#1")}/gate`, {
      node: "approve",
      verdict: "pass",
      note: "lgtm",
    });
    expect(gated.status).toBe(200);
    expect((gated.data["ticket"] as { state: string }).state).toBe("done");

    const events = await call("GET", `/tickets/${enc("#1")}/events?tail=3`);
    const eventFeed = events.data["events"] as Array<{
      type: string;
      ticketRef: string;
      runId: string;
      timestamp: string;
      reason: string;
    }>;
    expect(eventFeed.map((event) => event.type)).toContain("run_done");
    expect(eventFeed.every((event) => event.ticketRef === "#1" && event.runId === "#1" && Boolean(event.timestamp) && Boolean(event.reason))).toBe(true);
    const journal = await call("GET", `/tickets/${enc("#1")}/journal?tail=1`);
    expect((journal.data["journal"] as string[])[0]).toContain("run done");
  });

  it("pause and resume over the wire", async () => {
    await call("POST", "/tickets", { title: "pausable", body: "b", flow: presets.onePass() });
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    const paused = await call("POST", `/tickets/${enc("#1")}/pause`);
    expect((paused.data["ticket"] as { state: string }).state).toBe("in_review");
    const resumed = await call("POST", `/tickets/${enc("#1")}/resume`, {});
    expect((resumed.data["ticket"] as { state: string }).state).toBe("in_progress");
    const seat2 = rig.adapter.seat("implement", { attempt: 2 });
    await seat2.ready();
    await seat2.complete();
    expect(rig.tracker.get("#1").state).toBe("done");
  });

  it("cancel over the wire", async () => {
    await call("POST", "/tickets", { title: "doomed", body: "b", flow: presets.onePass() });
    const cancelled = await call("POST", `/tickets/${enc("#1")}/cancel`, { reason: "descoped" });
    expect((cancelled.data["ticket"] as { state: string }).state).toBe("cancelled");
  });

  it("filing with needs over the wire; dependents promote when the API completes work", async () => {
    await call("POST", "/tickets", { title: "a", body: "b", flow: presets.onePass() });
    const dep = await call("POST", "/tickets", {
      title: "b",
      body: "b",
      flow: presets.onePass(),
      needs: ["#1"],
    });
    expect((dep.data["ticket"] as { state: string }).state).toBe("backlog");
    const seat = rig.adapter.seat("implement");
    await seat.ready();
    await seat.complete();
    await rig.tracker.settle();
    const promoted = await call("GET", `/tickets/${enc("#2")}`);
    expect((promoted.data["ticket"] as { state: string }).state).toBe("in_progress");
  });

  it("maps errors to 400/404/409", async () => {
    expect((await call("GET", `/tickets/${enc("#42")}`)).status).toBe(404);
    expect((await call("POST", "/tickets", { title: "" })).status).toBe(400);
    expect((await call("POST", "/tickets", { titel: "typo" })).status).toBe(400);

    await call("POST", "/tickets", { title: "x", body: "b", flow: presets.onePass() });
    // staffing an already-staffed ticket conflicts
    expect((await call("POST", `/tickets/${enc("#1")}/staff`)).status).toBe(409);
    // resuming a running ticket conflicts
    expect((await call("POST", `/tickets/${enc("#1")}/resume`, {})).status).toBe(409);
    // gate verdict validation
    expect(
      (await call("POST", `/tickets/${enc("#1")}/gate`, { node: "x", verdict: "maybe" })).status,
    ).toBe(400);
    // unknown action
    expect((await call("POST", `/tickets/${enc("#1")}/frobnicate`, {})).status).toBe(404);
    // non-JSON body
    const res = await fetch(`${rig.base}/tickets`, { method: "POST", body: "not json{" });
    expect(res.status).toBe(400);
  });
});
