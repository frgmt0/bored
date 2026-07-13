/**
 * The ticket entity — the tracker layer bored was missing. A real ticket
 * with the eight-value state union from §1.1 of the design doc (backlog,
 * todo, design, design_review, in_progress, in_review, done, cancelled —
 * done/cancelled terminal), the #N / #N.x tree with `needs` cross-task
 * dependencies from §1.5, and a per-ticket state_map renaming run nodes
 * onto tracker columns (§1.1's "each board carries a state_map").
 */
import { z } from "zod";
import type { FlowSpec, HarnessSpec, NodeId } from "../spec/types.js";
import { flowSpecSchema, harnessSpecSchema } from "../spec/schema.js";

export const TICKET_STATES = [
  "backlog",
  "todo",
  "design",
  "design_review",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

export type TicketState = (typeof TICKET_STATES)[number];

export const TERMINAL_STATES: readonly TicketState[] = ["done", "cancelled"];

export function isTerminal(state: TicketState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface Ticket {
  /** "#N" for top-level, "#N.x" for children — the user-facing tree ref (§1.5) */
  ref: string;
  title: string;
  body?: string;
  criteria?: string[];
  state: TicketState;
  /** why the ticket sits where it does (park reason, unmet needs, …) */
  stateReason?: string;
  originChannel?: string;
  /** tree structure: "#N" for a "#N.x" child */
  parent?: string;
  children: string[];
  /** cross-task dependencies: refs that must be done before this staffs */
  needs: string[];
  /** the run of show; when absent, compiled from `cast` at staffing (§3.2) */
  flow?: FlowSpec;
  cast?: HarnessSpec;
  /** node → tracker column; falls back to node-kind defaults */
  stateMap?: Record<NodeId, TicketState>;
  /** staff automatically once needs are met */
  autoStaff: boolean;
  /** a run has been opened for this ticket (the run ref IS the ticket ref) */
  staffed: boolean;
  createdAt: string;
  updatedAt: string;
}

export const ticketStateSchema = z.enum(TICKET_STATES);

/** What a filing provides; everything else is allocated by the tracker. */
export const fileTicketSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().optional(),
    criteria: z.array(z.string()).optional(),
    originChannel: z.string().optional(),
    parent: z.string().optional(),
    needs: z.array(z.string()).optional(),
    flow: flowSpecSchema.optional(),
    cast: harnessSpecSchema.optional(),
    stateMap: z.record(z.string(), ticketStateSchema).optional(),
    autoStaff: z.boolean().optional(),
  })
  .strict();

export type FileTicketInput = z.infer<typeof fileTicketSchema>;
