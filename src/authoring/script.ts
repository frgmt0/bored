/**
 * Flow scripts — workflows authored as JavaScript, not just JSON. A `.js`/
 * `.mjs`/`.cjs` file default-exports a (possibly async) function that
 * receives the ticket context plus the authoring toolkit and returns the
 * flow — so the shape is *computed for the task at hand* (branch on the
 * title, derive fanout arms from data, compose presets) instead of one
 * rigid structure for every ticket.
 *
 *   // adaptive.flow.mjs
 *   export default ({ ticket, flow, presets }) => {
 *     if (/hotfix/i.test(ticket.title)) return presets.onePass();
 *     return flow()
 *       .worker("implement", { cast: {...}, onPass: "review" })
 *       .gate("review", { by: {...}, onPass: "done", onFail: "implement" })
 *       .build();
 *   };
 *   export const stateMap = { implement: "in_progress", review: "in_review" };
 *   export const hooks = {
 *     async onEvent({ event, actions }) {
 *       if (event.type === "parked" && event.reason === "max_visits_exhausted") {
 *         await actions.resume({ extraVisits: 1 }); // a scripted concierge
 *       }
 *     },
 *   };
 *
 * The returned spec goes through the full linter — scripting controls
 * shape and management, never loosens the bounded-execution guarantees.
 * Hooks run with operator authority (the same verbs a human concierge
 * has), serialised off the event path; runaway hook loops are fenced by
 * the same budgets and caps as everything else, so scripted flows should
 * set a budget.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { mustLint } from "../spec/lint.js";
import type { FlowSpec } from "../spec/types.js";
import * as presets from "../presets.js";
import { flow, FlowBuilder } from "./builder.js";
import type { TicketState } from "../tracker/ticket.js";
import type { FlowRun } from "../run/fold.js";
import type { RunEvent } from "../run/events.js";
import type { NudgeReceipt } from "../engine/ports.js";
import type { ResumeGrant } from "../engine/stageManager.js";

/** What a flow script's default export receives. */
export interface FlowScriptContext {
  ticket: {
    title: string;
    body?: string;
    criteria?: string[];
  };
  /** the fluent builder: flow().worker(...).build() */
  flow: typeof flow;
  FlowBuilder: typeof FlowBuilder;
  /** the shipped shapes, composable */
  presets: typeof presets;
}

/** Everything a hook may do — a scripted concierge's operator verbs. */
export interface HookActions {
  nudge(text: string, node?: string): NudgeReceipt;
  pause(): Promise<void>;
  resume(grant?: ResumeGrant): Promise<void>;
  decideGate(node: string, verdict: "pass" | "fail", note?: string): Promise<void>;
  cancel(reason?: string): Promise<void>;
  /** file follow-up work (needs may reference this ticket) */
  file(input: {
    title: string;
    body?: string;
    criteria?: string[];
    needs?: string[];
    flow?: FlowSpec;
    autoStaff?: boolean;
  }): Promise<{ ref: string }>;
}

export interface HookContext {
  ref: string;
  event: RunEvent;
  run: FlowRun;
  actions: HookActions;
}

export interface FlowHooks {
  /** invoked (serialised, off the event path) after every run event */
  onEvent?: (ctx: HookContext) => void | Promise<void>;
}

export interface LoadedFlow {
  flow: FlowSpec;
  stateMap?: Record<string, TicketState>;
  hooks?: FlowHooks;
  /** the resolved absolute path, stored on the ticket for recovery */
  scriptPath: string;
}

type ScriptResult =
  | FlowSpec
  | {
      flow: FlowSpec;
      stateMap?: Record<string, TicketState>;
      hooks?: FlowHooks;
    };

interface FlowScriptModule {
  default?: (ctx: FlowScriptContext) => ScriptResult | Promise<ScriptResult>;
  stateMap?: Record<string, TicketState>;
  hooks?: FlowHooks;
}

/**
 * Load and run a flow script. The returned flow is linted; a script that
 * produces an unbounded or malformed graph fails at filing time exactly
 * like a bad JSON spec would. Values returned from the function win over
 * module-level exports.
 */
export async function loadFlowScript(
  scriptPath: string,
  ticket: FlowScriptContext["ticket"],
): Promise<LoadedFlow> {
  const resolved = path.resolve(scriptPath);
  // cache-bust so edited scripts reload without restarting the tracker
  const url = `${pathToFileURL(resolved).href}?t=${Date.now()}`;
  let module: FlowScriptModule;
  try {
    module = (await import(url)) as FlowScriptModule;
  } catch (err) {
    throw new Error(
      `flow script ${resolved} failed to load: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // CJS interop: `module.exports = { default: fn, hooks }` arrives as the
  // whole exports object in the namespace's default slot — unwrap it.
  if (
    typeof module.default === "object" &&
    module.default !== null &&
    typeof (module.default as unknown as FlowScriptModule).default === "function"
  ) {
    module = module.default as unknown as FlowScriptModule;
  }
  if (typeof module.default !== "function") {
    throw new Error(`flow script ${resolved} must default-export a function(ctx) → flow`);
  }
  const result = await module.default({ ticket, flow, FlowBuilder, presets });
  const isWrapped = result != null && typeof result === "object" && "flow" in result && !("version" in result);
  const rawFlow = isWrapped ? (result as { flow: FlowSpec }).flow : (result as FlowSpec);
  const linted = mustLint(rawFlow);
  const stateMap = (isWrapped ? (result as { stateMap?: Record<string, TicketState> }).stateMap : undefined) ?? module.stateMap;
  const hooks = (isWrapped ? (result as { hooks?: FlowHooks }).hooks : undefined) ?? module.hooks;
  return {
    flow: linted,
    ...(stateMap !== undefined ? { stateMap } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
    scriptPath: resolved,
  };
}
