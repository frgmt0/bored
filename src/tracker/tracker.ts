/**
 * The Tracker — the layer that makes this a Plane replacement rather than
 * just a dispatcher: real tickets with the todo/in_progress/in_review/done
 * state model, the #N / #N.x tree, cross-task `needs` dependencies with
 * promote-on-done (§1.5's "cross-ticket DAG promotion: blockedBy → promote
 * on done"), and ticket states projected live from the run record via the
 * per-ticket state_map (§1.1).
 *
 * The tracker owns a StageManager: filing a ready ticket opens a run; every
 * run event re-projects the ticket's column; a run finishing promotes the
 * tickets that were waiting on it.
 */
import { compileFromCast } from "../presets.js";
import type { FlowSpec, HarnessSpec } from "../spec/types.js";
import { mustLint } from "../spec/lint.js";
import type { FlowRun } from "../run/fold.js";
import type { RunEvent } from "../run/events.js";
import {
  StageManager,
  type ResumeGrant,
  type StageManagerOptions,
} from "../engine/stageManager.js";
import type {
  AnnounceSink,
  MergeProvider,
  NudgeReceipt,
  SpawnAdapter,
} from "../engine/ports.js";
import {
  fileTicketSchema,
  isTerminal,
  type FileTicketInput,
  type Ticket,
  type TicketState,
} from "./ticket.js";
import { TicketStore } from "./store.js";
import { loadFlowScript, type FlowHooks, type HookActions } from "../authoring/script.js";

const DEFAULT_CAST: HarnessSpec = { harness: "claude", model: "claude-sonnet-5", effort: "high" };

export interface TicketStatus {
  ticket: Ticket;
  run?: FlowRun;
  /** unmet needs (with their current states) — why a backlog ticket waits */
  blockedOn: Array<{ ref: string; state: TicketState }>;
  /** open tickets whose needs include this one */
  blocking: string[];
}

export class Tracker {
  readonly engine: StageManager;
  readonly tickets: TicketStore;
  /** serialised async work (auto-staffing promoted tickets, script hooks) */
  private work: Promise<void> = Promise.resolve();
  /** per-ticket flow-script hooks — in-memory, reloaded on recover() */
  private hooks = new Map<string, FlowHooks>();

  constructor(
    root: string,
    spawner: SpawnAdapter,
    merger: MergeProvider,
    announceSink: AnnounceSink,
    opts: StageManagerOptions,
  ) {
    this.tickets = new TicketStore(root);
    this.engine = new StageManager(root, spawner, merger, announceSink, {
      ...opts,
      onEvent: (ref, event, run) => {
        this.handleRunEvent(ref, event, run);
        opts.onEvent?.(ref, event, run);
      },
    });
  }

  /** Await all queued background work (promotion staffing). */
  async settle(): Promise<void> {
    let last: Promise<void>;
    do {
      last = this.work;
      await last;
    } while (last !== this.work); // staffing may queue more staffing
  }

  // ── filing (§1.5: the #N / #N.x tree with needs) ────────────────────────

  async file(input: FileTicketInput): Promise<Ticket> {
    const parsed = fileTicketSchema.parse(input);
    if (parsed.flow && parsed.flowScript) {
      throw new Error("provide flow OR flowScript, not both");
    }
    if (parsed.flow) mustLint(parsed.flow); // fail at filing, not staffing
    // Scripted authoring: run the script with the ticket context; the shape
    // is computed for this task, then linted and frozen like any other spec.
    let scriptHooks: FlowHooks | undefined;
    if (parsed.flowScript) {
      const loaded = await loadFlowScript(parsed.flowScript, {
        title: parsed.title,
        ...(parsed.body !== undefined ? { body: parsed.body } : {}),
        ...(parsed.criteria !== undefined ? { criteria: parsed.criteria } : {}),
      });
      parsed.flow = loaded.flow;
      parsed.stateMap ??= loaded.stateMap;
      parsed.flowScript = loaded.scriptPath;
      scriptHooks = loaded.hooks;
    }
    const now = new Date().toISOString();

    const ticket = this.tickets.update((tasks): Ticket => {
      // Allocate the ref inside the lock so refs never collide.
      let ref: string;
      if (parsed.parent != null) {
        const parent = tasks.tickets[parsed.parent];
        if (!parent) throw new Error(`parent ${parsed.parent} does not exist`);
        if (parent.parent != null) {
          throw new Error(`parent ${parsed.parent} is itself a child; the tree is #N / #N.x`);
        }
        const child = tasks.nextChild[parsed.parent] ?? 1;
        tasks.nextChild[parsed.parent] = child + 1;
        ref = `${parsed.parent}.${child}`;
        parent.children.push(ref);
      } else {
        ref = `#${tasks.nextId}`;
        tasks.nextId += 1;
      }

      // Needs may only reference existing tickets — the cross-task DAG is
      // therefore acyclic by construction (a new node cannot be depended on
      // yet, so no edge can ever point forward).
      const needs = parsed.needs ?? [];
      for (const need of needs) {
        const target = tasks.tickets[need];
        if (!target) throw new Error(`needs ${need}: no such ticket`);
        if (target.state === "cancelled") {
          throw new Error(`needs ${need}: ticket is cancelled and will never complete`);
        }
      }
      const unmet = needs.filter((n) => tasks.tickets[n]!.state !== "done");

      const ticket: Ticket = {
        ref,
        title: parsed.title,
        ...(parsed.body !== undefined ? { body: parsed.body } : {}),
        ...(parsed.criteria !== undefined ? { criteria: parsed.criteria } : {}),
        state: unmet.length > 0 ? "backlog" : "todo",
        ...(unmet.length > 0
          ? { stateReason: `waiting on ${unmet.join(", ")}` }
          : {}),
        ...(parsed.originChannel !== undefined ? { originChannel: parsed.originChannel } : {}),
        ...(parsed.parent !== undefined ? { parent: parsed.parent } : {}),
        children: [],
        needs,
        ...(parsed.flow !== undefined ? { flow: parsed.flow as FlowSpec } : {}),
        ...(parsed.flowScript !== undefined ? { flowScript: parsed.flowScript } : {}),
        ...(parsed.cast !== undefined ? { cast: parsed.cast as HarnessSpec } : {}),
        ...(parsed.stateMap !== undefined
          ? { stateMap: parsed.stateMap as Record<string, TicketState> }
          : {}),
        autoStaff: parsed.autoStaff ?? true,
        staffed: false,
        createdAt: now,
        updatedAt: now,
      };
      tasks.tickets[ref] = ticket;
      return ticket;
    });
    if (scriptHooks) this.hooks.set(ticket.ref, scriptHooks);

    if (ticket.state === "todo" && ticket.autoStaff) {
      await this.staff(ticket.ref);
      return this.get(ticket.ref);
    }
    return ticket;
  }

  // ── staffing: a ready ticket becomes a run ──────────────────────────────

  async staff(ref: string): Promise<Ticket> {
    const ticket = this.get(ref);
    if (ticket.staffed) throw new Error(`${ref} is already staffed`);
    if (isTerminal(ticket.state)) throw new Error(`${ref} is ${ticket.state}`);
    const unmet = this.unmetNeeds(ticket);
    if (unmet.length > 0) {
      throw new Error(`${ref} still waits on ${unmet.map((u) => u.ref).join(", ")}`);
    }
    // A flow with no beckett-flow block is compiled from the cast (§3.2).
    const flow = ticket.flow ?? compileFromCast(ticket.cast ?? DEFAULT_CAST);
    this.mutate(ref, (t) => {
      t.staffed = true;
      t.state = "in_progress";
      delete t.stateReason;
    });
    await this.engine.open(ref, flow, {
      ...(ticket.body !== undefined ? { body: ticket.body } : {}),
      ...(ticket.criteria !== undefined ? { criteria: ticket.criteria } : {}),
      ...(ticket.originChannel !== undefined ? { originChannel: ticket.originChannel } : {}),
    });
    this.reproject(ref);
    return this.get(ref);
  }

  // ── reads ───────────────────────────────────────────────────────────────

  get(ref: string): Ticket {
    const ticket = this.tickets.get(ref);
    if (!ticket) throw new Error(`no ticket ${ref}`);
    return ticket;
  }

  list(): Ticket[] {
    return this.tickets.list();
  }

  status(ref: string): TicketStatus {
    const ticket = this.get(ref);
    const blocking = this.tickets
      .list()
      .filter((t) => t.needs.includes(ref) && !isTerminal(t.state))
      .map((t) => t.ref);
    return {
      ticket,
      ...(ticket.staffed ? { run: this.engine.status(ref) } : {}),
      blockedOn: this.unmetNeeds(ticket),
      blocking,
    };
  }

  // ── operator verbs (pass through to the run, then re-project) ──────────

  nudge(ref: string, text: string, node?: string): NudgeReceipt {
    this.assertStaffed(ref);
    return this.engine.nudge(ref, text, node);
  }

  /** Steer the in-flight seat now: abort with WIP, re-staff with the steer. */
  async interrupt(ref: string, text: string, node?: string): Promise<NudgeReceipt> {
    this.assertStaffed(ref);
    return this.engine.interrupt(ref, text, node);
  }

  async pause(ref: string): Promise<Ticket> {
    this.assertStaffed(ref);
    await this.engine.pause(ref);
    return this.get(ref);
  }

  async resume(ref: string, grant?: ResumeGrant): Promise<Ticket> {
    this.assertStaffed(ref);
    await this.engine.resume(ref, grant);
    return this.get(ref);
  }

  async decideGate(
    ref: string,
    node: string,
    verdict: "pass" | "fail",
    note?: string,
  ): Promise<Ticket> {
    this.assertStaffed(ref);
    await this.engine.decideHumanGate(ref, node, verdict, note);
    return this.get(ref);
  }

  async cancel(ref: string, reason?: string): Promise<Ticket> {
    const ticket = this.get(ref);
    if (ticket.staffed && !isTerminal(ticket.state)) {
      await this.engine.cancel(ref, reason);
    } else {
      this.mutate(ref, (t) => {
        t.state = "cancelled";
        if (reason !== undefined) t.stateReason = reason;
      });
    }
    return this.get(ref);
  }

  async tick(): Promise<void> {
    await this.engine.tick();
  }

  /** Boot: replay runs, re-project every ticket, run missed promotions. */
  async recover(): Promise<void> {
    // Reload flow-script hooks before replay so the scripted concierge
    // hears the recovery events too. A script that fails to load is
    // journalled and skipped — the run itself is unaffected.
    for (const ticket of this.tickets.list()) {
      if (!ticket.flowScript || isTerminal(ticket.state)) continue;
      try {
        const loaded = await loadFlowScript(ticket.flowScript, {
          title: ticket.title,
          ...(ticket.body !== undefined ? { body: ticket.body } : {}),
          ...(ticket.criteria !== undefined ? { criteria: ticket.criteria } : {}),
        });
        if (loaded.hooks) this.hooks.set(ticket.ref, loaded.hooks);
      } catch (err) {
        this.engine.store.journal(
          ticket.ref,
          new Date().toISOString(),
          `flow-script reload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await this.engine.recoverAll();
    for (const ticket of this.tickets.list()) {
      if (ticket.staffed) this.reproject(ticket.ref);
    }
    // Promotions that landed while the process was down.
    for (const ticket of this.tickets.list()) {
      if (ticket.state === "done") this.promoteDependents(ticket.ref);
    }
    await this.settle();
  }

  // ── projection: run record → ticket column ─────────────────────────────

  private handleRunEvent(ref: string, event: RunEvent, run: FlowRun): void {
    if (!this.tickets.get(ref)) return; // runs opened outside the tracker
    this.reprojectFrom(ref, run);
    if (event.type === "run_done") this.promoteDependents(ref);
    // Flow-script hooks: the scripted concierge sees every event, off the
    // event path so its operator verbs never re-enter the engine mid-append.
    const hooks = this.hooks.get(ref);
    if (hooks?.onEvent) {
      const onEvent = hooks.onEvent;
      this.work = this.work.then(async () => {
        try {
          await onEvent({ ref, event, run, actions: this.hookActions(ref) });
        } catch (err) {
          // hook failures are announced in the journal, never crash the run
          this.engine.store.journal(
            ref,
            new Date().toISOString(),
            `flow-script hook error on ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }
  }

  private hookActions(ref: string): HookActions {
    return {
      nudge: (text, node) => this.nudge(ref, text, node),
      interrupt: (text, node) => this.interrupt(ref, text, node),
      pause: async () => {
        await this.pause(ref);
      },
      resume: async (grant) => {
        await this.resume(ref, grant);
      },
      decideGate: async (node, verdict, note) => {
        await this.decideGate(ref, node, verdict, note);
      },
      cancel: async (reason) => {
        await this.cancel(ref, reason);
      },
      file: async (input) => {
        const ticket = await this.file(input as FileTicketInput);
        return { ref: ticket.ref };
      },
    };
  }

  /** Tickets with live flow-script hooks (introspection, tests). */
  hookRefs(): string[] {
    return [...this.hooks.keys()];
  }

  private reproject(ref: string): void {
    this.reprojectFrom(ref, this.engine.status(ref));
  }

  private reprojectFrom(ref: string, run: FlowRun): void {
    const ticket = this.tickets.get(ref);
    if (!ticket) return;
    const projected = projectState(ticket, run);
    if (ticket.state === projected.state && ticket.stateReason === projected.reason) return;
    this.mutate(ref, (t) => {
      t.state = projected.state;
      if (projected.reason !== undefined) t.stateReason = projected.reason;
      else delete t.stateReason;
    });
  }

  /**
   * §1.5: blockedBy → promote on done. Every open ticket waiting on `ref`
   * whose needs are now all met moves backlog → todo; autoStaff tickets are
   * staffed in the background (awaitable via settle()).
   */
  private promoteDependents(doneRef: string): void {
    const promoted: string[] = [];
    for (const ticket of this.tickets.list()) {
      if (ticket.staffed || isTerminal(ticket.state)) continue;
      if (!ticket.needs.includes(doneRef)) continue;
      const unmet = this.unmetNeeds(ticket);
      if (unmet.length > 0) {
        this.mutate(ticket.ref, (t) => {
          t.stateReason = `waiting on ${unmet.map((u) => u.ref).join(", ")}`;
        });
        continue;
      }
      this.mutate(ticket.ref, (t) => {
        t.state = "todo";
        delete t.stateReason;
      });
      promoted.push(ticket.ref);
    }
    for (const ref of promoted) {
      const ticket = this.tickets.get(ref);
      if (!ticket?.autoStaff) continue;
      // Staffing opens a run (async); serialise it off the event path.
      this.work = this.work.then(async () => {
        const current = this.tickets.get(ref);
        if (!current || current.staffed || isTerminal(current.state)) return;
        await this.staff(ref);
      });
    }
  }

  private unmetNeeds(ticket: Ticket): Array<{ ref: string; state: TicketState }> {
    return ticket.needs
      .map((ref) => ({ ref, state: this.tickets.get(ref)?.state ?? ("cancelled" as TicketState) }))
      .filter((n) => n.state !== "done");
  }

  private assertStaffed(ref: string): void {
    if (!this.get(ref).staffed) throw new Error(`${ref} has no run yet (state: ${this.get(ref).state})`);
  }

  private mutate(ref: string, fn: (t: Ticket) => void): void {
    this.tickets.update((tasks) => {
      const ticket = tasks.tickets[ref];
      if (!ticket) throw new Error(`no ticket ${ref}`);
      fn(ticket);
      ticket.updatedAt = new Date().toISOString();
    });
  }
}

/**
 * Project a run onto the tracker's eight-value state union. The ticket's
 * state_map wins; otherwise node kind decides (workers/fanouts/joins are
 * in_progress, gates are in_review), and any park a human must resolve
 * reads as in_review — exactly today's "park in in_review for a human".
 */
export function projectState(
  ticket: Ticket,
  run: FlowRun,
): { state: TicketState; reason?: string } {
  if (run.status === "done") return { state: "done" };
  if (run.status === "cancelled") {
    return { state: "cancelled", ...(run.parked?.detail ? { reason: run.parked.detail } : {}) };
  }
  const parkedReason = run.parked
    ? `${run.parked.reason}${run.parked.detail ? `: ${run.parked.detail}` : ""}`
    : undefined;
  const activeNode = run.parked?.node ?? run.cursors[0]?.node;
  if (activeNode != null) {
    const mapped = ticket.stateMap?.[activeNode];
    if (mapped) return { state: mapped, ...(parkedReason ? { reason: parkedReason } : {}) };
    const def = run.spec.nodes[activeNode];
    if (def?.kind === "gate") {
      return { state: "in_review", ...(parkedReason ? { reason: parkedReason } : {}) };
    }
    if (run.status === "parked") {
      return { state: "in_review", reason: parkedReason! };
    }
    return { state: "in_progress" };
  }
  if (run.status === "parked") return { state: "in_review", reason: parkedReason! };
  return { state: "in_progress" };
}
