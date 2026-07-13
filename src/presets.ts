/**
 * Appendix A — today's lifecycles as flow specs. The two legacy lifecycles
 * expressed in the new algebra: the backward-compatibility argument in one
 * file. If the engine can run these two specs identically, cutover changes
 * nothing until the concierge starts writing new shapes (§3.4, Appendix A).
 *
 * Also §8's flow presets: the shapes ro keeps asking for (bake-off, panel
 * review, research fan-out), pre-composed.
 */
import type { FlowSpec, HarnessSpec } from "./spec/types.js";

/**
 * The default reviewed lifecycle (§3.4) — todo → in_progress → in_review →
 * done with ≤3 rework cycles, exactly as compiled into the dispatcher today:
 * implement (3 visits, 3 retries) ↔ review gate (3 bounces), pass → done.
 */
export function reviewedLifecycle(
  implementCast: HarnessSpec = { harness: "pi", effort: "high" },
  reviewCast: HarnessSpec = { harness: "claude", model: "claude-sonnet-5", effort: "high" },
): FlowSpec {
  return {
    version: 1,
    entry: "implement",
    nodes: {
      implement: {
        kind: "worker",
        cast: implementCast,
        onPass: "review",
        onFail: "park",
        maxVisits: 3, // MAX_REWORK_CYCLES = 3, made per-task data (§1.3)
        retries: 3, // MAX_IMPLEMENT_RETRIES = 3
      },
      review: {
        kind: "gate",
        by: { cast: reviewCast, rubric: "criteria-vs-diff" },
        onPass: "done",
        onFail: "implement",
        maxFails: 3,
        maxVisits: 3,
      },
    },
  };
}

/**
 * One-pass work — the same spec minus the gate (§3.4): effort low/medium's
 * "self" review tier, straight to done.
 */
export function onePass(implementCast: HarnessSpec = { harness: "pi", effort: "low" }): FlowSpec {
  return {
    version: 1,
    entry: "implement",
    nodes: {
      implement: {
        kind: "worker",
        cast: implementCast,
        onPass: "done",
        onFail: "park",
        maxVisits: 3,
        retries: 3,
      },
    },
  };
}

/**
 * The INT design flow (§2.1, Appendix A): a design stage with a cheap
 * completeness check (design_check: Haiku, low — MAX_DESIGN_CYCLES = 2) and
 * a human approval gate before implementation — two nodes of data instead
 * of two enum values, a board, and five modules.
 */
export function intDesignFlow(
  designCast: HarnessSpec = { harness: "claude", model: "claude-opus-4-8", effort: "high" },
  implementCast: HarnessSpec = { harness: "pi", effort: "high" },
  reviewCast: HarnessSpec = { harness: "claude", model: "claude-sonnet-5", effort: "high" },
  designDocPath = "docs/design/design.md",
): FlowSpec {
  return {
    version: 1,
    entry: "design",
    nodes: {
      design: {
        kind: "worker",
        cast: designCast,
        artifact: designDocPath,
        onPass: "design_check",
        onFail: "park",
        maxVisits: 3,
        retries: 3,
      },
      design_check: {
        kind: "gate",
        by: {
          cast: { harness: "claude", model: "claude-haiku-4-5-20251001", effort: "low" },
          rubric: "design-completeness",
        },
        onPass: "design_review",
        onFail: "design",
        maxFails: 2, // MAX_DESIGN_CYCLES = 2; exhaustion parks with a ⚠ for a human
        maxVisits: 3,
      },
      design_review: {
        kind: "gate",
        by: "human",
        onPass: "implement",
        onFail: "design",
        maxFails: 2,
        maxVisits: 3,
      },
      implement: {
        kind: "worker",
        cast: implementCast,
        onPass: "review",
        onFail: "park",
        maxVisits: 3,
        retries: 3,
      },
      review: {
        kind: "gate",
        by: { cast: reviewCast, rubric: "criteria-vs-diff" },
        onPass: "done",
        onFail: "implement",
        maxFails: 3,
        maxVisits: 3,
      },
    },
  };
}

/**
 * Fig 3 — the bake-off run of show. Design → human gate → three isolated
 * candidate implementations → a judge join that picks (or synthesises) a
 * winner → fresh review → done. Six nodes of data (§3.5).
 */
export function bakeOff(
  arms: Array<{ cast: HarnessSpec; brief?: string }> = [
    { cast: { harness: "terra", effort: "high" } },
    { cast: { harness: "claude", model: "claude-opus-4-8", effort: "high" } },
    { cast: { harness: "codex", effort: "high" } },
  ],
): FlowSpec {
  return {
    version: 1,
    entry: "design",
    nodes: {
      design: {
        kind: "worker",
        cast: { harness: "claude", model: "claude-opus-4-8", effort: "high" },
        onPass: "approve",
        onFail: "park",
        maxVisits: 3,
        retries: 3,
      },
      approve: {
        kind: "gate",
        by: "human",
        onPass: "implementations",
        onFail: "design",
        maxFails: 2,
        maxVisits: 3,
      },
      implementations: {
        kind: "fanout",
        arms,
        isolation: "worktree-each",
        join: "judge",
        maxVisits: 2,
        retries: 3,
      },
      judge: {
        kind: "join",
        strategy: { judge: { harness: "claude", model: "claude-fable-5", effort: "high" } },
        onPass: "review",
        onFail: "park",
        maxVisits: 2,
      },
      review: {
        kind: "gate",
        by: {
          cast: { harness: "claude", model: "claude-sonnet-5", effort: "high" },
          rubric: "criteria-vs-diff",
        },
        onPass: "done",
        onFail: "park",
        maxFails: 2,
        maxVisits: 3,
      },
    },
  };
}

/**
 * Panel review — correctness, security and taste reviewers running
 * *concurrently* on one diff (§2.3), as a quorum fanout.
 */
export function panelReview(k = 2): FlowSpec {
  return {
    version: 1,
    entry: "implement",
    nodes: {
      implement: {
        kind: "worker",
        cast: { harness: "pi", effort: "high" },
        onPass: "panel",
        onFail: "park",
        maxVisits: 3,
        retries: 3,
      },
      panel: {
        kind: "fanout",
        arms: [
          { cast: { harness: "claude", model: "claude-sonnet-5", effort: "high" }, brief: "review for correctness" },
          { cast: { harness: "claude", model: "claude-sonnet-5", effort: "high" }, brief: "review for security" },
          { cast: { harness: "claude", model: "claude-haiku-4-5-20251001", effort: "medium" }, brief: "review for taste" },
        ],
        isolation: "shared",
        join: "verdict",
        maxVisits: 3,
        retries: 1, // MAX_REVIEW_INFRA_RETRIES = 1 (§1.3)
      },
      verdict: {
        kind: "join",
        strategy: "quorum",
        quorumK: k,
        onPass: "done",
        onFail: "implement",
        maxVisits: 3,
      },
    },
  };
}

/**
 * A flow with no beckett-flow block is compiled from the cast exactly as
 * today (effort → gate), so existing filings never break (§3.2): low/medium
 * effort → self (one pass); high/xhigh/unset → a fresh adversarial review.
 */
export function compileFromCast(implementCast: HarnessSpec, reviewTier?: "self" | "fresh"): FlowSpec {
  const tier =
    reviewTier ??
    (implementCast.effort === "low" || implementCast.effort === "medium" ? "self" : "fresh");
  return tier === "self" ? onePass(implementCast) : reviewedLifecycle(implementCast);
}
