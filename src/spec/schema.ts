/**
 * Zod schemas for the flow spec — "all of this validates with zod at filing
 * time, like castings do today" (§3.2).
 *
 * Schema-level guarantees the linter builds on:
 *  - every counter (maxVisits, retries, maxFails, quorumK) is a finite
 *    positive integer — `Infinity` is simply not representable (§3.3);
 *  - supervision thresholds are finite numbers; "alarms: off" is not
 *    representable (§3.3) — floors are enforced by the linter.
 */
import { z } from "zod";
import type { FlowSpec } from "./types.js";

export const effortSchema = z.enum(["low", "medium", "high", "xhigh"]);

export const harnessSpecSchema = z
  .object({
    harness: z.string().min(1),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
  })
  .strict();

const finitePosInt = z.number().int().positive().finite();
/** retries may be zero — "one shot, no infra retries" is a legitimate ask (§2.2). */
const finiteNonNegInt = z.number().int().nonnegative().finite();

const nodeIdSchema = z.string().min(1);

export const workerNodeSchema = z
  .object({
    kind: z.literal("worker"),
    cast: harnessSpecSchema,
    brief: z.string().optional(),
    artifact: z.string().optional(),
    onPass: nodeIdSchema,
    onFail: nodeIdSchema,
    maxVisits: finitePosInt.optional(),
    retries: finiteNonNegInt.optional(),
  })
  .strict();

export const gateNodeSchema = z
  .object({
    kind: z.literal("gate"),
    by: z.union([
      z.literal("human"),
      z.object({ cast: harnessSpecSchema, rubric: z.string().min(1) }).strict(),
    ]),
    onPass: nodeIdSchema,
    onFail: nodeIdSchema,
    maxFails: finitePosInt.optional(),
    maxVisits: finitePosInt.optional(),
  })
  .strict();

export const fanoutNodeSchema = z
  .object({
    kind: z.literal("fanout"),
    arms: z
      .array(z.object({ cast: harnessSpecSchema, brief: z.string().optional() }).strict())
      .min(2, "a fanout needs at least two arms"),
    isolation: z.enum(["worktree-each", "shared"]),
    join: nodeIdSchema,
    maxVisits: finitePosInt.optional(),
    retries: finiteNonNegInt.optional(),
  })
  .strict();

export const joinNodeSchema = z
  .object({
    kind: z.literal("join"),
    strategy: z.union([
      z.enum(["all-merge", "first", "quorum"]),
      z.object({ judge: harnessSpecSchema }).strict(),
    ]),
    quorumK: finitePosInt.optional(),
    onPass: nodeIdSchema,
    onFail: nodeIdSchema,
    maxVisits: finitePosInt.optional(),
  })
  .strict();

export const flowNodeSchema = z.discriminatedUnion("kind", [
  workerNodeSchema,
  gateNodeSchema,
  fanoutNodeSchema,
  joinNodeSchema,
]);

export const superviseSpecSchema = z
  .object({
    leaseS: z.number().positive().finite().optional(),
    quietStrikes: finitePosInt.optional(),
    overrunFactor: z.number().positive().finite().optional(),
    checkpointS: z.number().positive().finite().optional(),
    readyS: z.number().positive().finite().optional(),
  })
  .strict();

export const flowBudgetSchema = z
  .object({
    maxConcurrent: finitePosInt.optional(),
    usd: z.number().positive().finite().optional(),
    wallClockS: z.number().positive().finite().optional(),
  })
  .strict();

export const flowSpecSchema = z
  .object({
    version: z.literal(1),
    entry: nodeIdSchema,
    nodes: z.record(nodeIdSchema, flowNodeSchema),
    budget: flowBudgetSchema.optional(),
    supervise: superviseSpecSchema.optional(),
  })
  .strict();

/** Parse unknown data into a FlowSpec, throwing on schema violations. */
export function parseFlowSpec(data: unknown): FlowSpec {
  return flowSpecSchema.parse(data) as FlowSpec;
}
