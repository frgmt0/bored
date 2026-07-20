/**
 * The tracker API — the "store + API to drive it all" the review asked for.
 * A dependency-free node:http server over the Tracker: every mutation the
 * TypeScript API offers is reachable over HTTP, so nothing requires
 * importing the library to operate a board.
 *
 *   GET  /health
 *   GET  /tickets                      → all tickets (the board)
 *   POST /tickets                      → file (FileTicketInput body)
 *   GET  /tickets/:ref                 → TicketStatus (ticket + run + deps)
 *   POST /tickets/:ref/staff           → open the run for a todo ticket
 *   POST /tickets/:ref/nudge           → {text, node?, mode?: enqueue|interrupt}
 *   POST /tickets/:ref/pause
 *   POST /tickets/:ref/resume          → {grant?}
 *   POST /tickets/:ref/gate            → {node, verdict, note?}
 *   POST /tickets/:ref/cancel          → {reason?}
 *   GET  /tickets/:ref/events?tail=N   → run event log
 *   GET  /tickets/:ref/journal?tail=N  → human narrative
 *
 * Refs arrive URL-encoded ("#3.1" → %233.1). Errors are {error} with
 * 400/404/409. The server owns the engine tick cadence (≤30s, §6).
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Tracker } from "./tracker/tracker.js";

const TICKET_ROUTE = /^\/tickets\/([^/]+)(?:\/([a-z]+))?$/;

export interface TrackerServerOptions {
  /** engine tick cadence in ms; ≤30s keeps the §6 announce invariant */
  tickMs?: number;
}

export class TrackerServer {
  readonly server: http.Server;
  private ticker: NodeJS.Timeout | null = null;

  constructor(
    readonly tracker: Tracker,
    private readonly opts: TrackerServerOptions = {},
  ) {
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve());
    });
    const tickMs = this.opts.tickMs ?? 15_000;
    this.ticker = setInterval(() => void this.tracker.tick(), tickMs);
    this.ticker.unref();
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/tickets") {
      if (method === "GET") return send(res, 200, { tickets: this.tracker.list() });
      if (method === "POST") {
        try {
          const body = await readJson(req);
          const ticket = await this.tracker.file(body as never);
          return send(res, 201, { ticket });
        } catch (err) {
          return send(res, 400, { error: message(err) });
        }
      }
      return send(res, 405, { error: "method not allowed" });
    }

    const match = TICKET_ROUTE.exec(url.pathname);
    if (!match) return send(res, 404, { error: "not found" });
    const ref = decodeURIComponent(match[1]!);
    const action = match[2];

    try {
      this.tracker.get(ref);
    } catch {
      return send(res, 404, { error: `no ticket ${ref}` });
    }

    try {
      if (action == null) {
        if (method !== "GET") return send(res, 405, { error: "method not allowed" });
        return send(res, 200, this.tracker.status(ref));
      }
      if (method === "GET" && action === "events") {
        const events = this.tracker.engine.store.readEvents(ref);
        const tail = Number(url.searchParams.get("tail") ?? events.length);
        return send(res, 200, { events: events.slice(-tail) });
      }
      if (method === "GET" && action === "journal") {
        const lines = this.tracker.engine.store.readJournal(ref);
        const tail = Number(url.searchParams.get("tail") ?? lines.length);
        return send(res, 200, { journal: lines.slice(-tail) });
      }
      if (method !== "POST") return send(res, 405, { error: "method not allowed" });
      const body = (await readJson(req)) as Record<string, unknown>;
      switch (action) {
        case "staff":
          return send(res, 200, { ticket: await this.tracker.staff(ref) });
        case "nudge": {
          if (typeof body["text"] !== "string") return send(res, 400, { error: "text required" });
          const mode = body["mode"];
          if (mode !== undefined && mode !== "enqueue" && mode !== "interrupt") {
            return send(res, 400, { error: 'mode must be "enqueue" or "interrupt"' });
          }
          const node = typeof body["node"] === "string" ? body["node"] : undefined;
          const receipt =
            mode === "interrupt"
              ? await this.tracker.interrupt(ref, body["text"], node)
              : this.tracker.nudge(ref, body["text"], node);
          return send(res, 200, {
            receipt: receipt.receipt,
            ...(receipt.steerId ? { steerId: receipt.steerId } : {}),
          });
        }
        case "pause":
          return send(res, 200, { ticket: await this.tracker.pause(ref) });
        case "resume":
          return send(res, 200, {
            ticket: await this.tracker.resume(ref, body["grant"] as never),
          });
        case "gate": {
          const { node, verdict, note } = body as {
            node?: string;
            verdict?: string;
            note?: string;
          };
          if (typeof node !== "string" || (verdict !== "pass" && verdict !== "fail")) {
            return send(res, 400, { error: "node and verdict (pass|fail) required" });
          }
          return send(res, 200, {
            ticket: await this.tracker.decideGate(ref, node, verdict, note),
          });
        }
        case "cancel":
          return send(res, 200, {
            ticket: await this.tracker.cancel(
              ref,
              typeof body["reason"] === "string" ? body["reason"] : undefined,
            ),
          });
        default:
          return send(res, 404, { error: `unknown action ${action}` });
      }
    } catch (err) {
      const msg = message(err);
      const status = /no ticket|does not exist/.test(msg)
        ? 404
        : /already|is (done|cancelled|parked|running)|not parked|not running|no run yet|still waits/.test(msg)
          ? 409
          : 400;
      return send(res, status, { error: msg });
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("body is not valid JSON");
  }
}
