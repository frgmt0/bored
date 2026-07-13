/**
 * An adaptive flow script: the workflow's shape is computed for the ticket
 * at hand instead of one rigid structure for every task.
 *
 *   - "hotfix" in the title      → one pass, low effort, tight budget
 *   - "areas:" in the body       → one fanout arm per listed area, all-merge,
 *                                  then a fresh review of the joined diff
 *   - three or more criteria     → the full reviewed lifecycle, high effort
 *   - otherwise                  → reviewed lifecycle, medium effort
 *
 * The hooks below act as a scripted concierge: one automatic extra visit
 * when a rework loop parks, and an auto-filed follow-up ticket when a run
 * finishes with leftover TODOs mentioned in its park detail.
 */
export default ({ ticket, flow, presets }) => {
  const title = ticket.title ?? "";
  const body = ticket.body ?? "";

  if (/hotfix/i.test(title)) {
    const spec = presets.onePass({ harness: "pi", effort: "low" });
    spec.budget = { usd: 2 };
    return spec;
  }

  const areas = /areas:\s*([^\n]+)/i.exec(body)?.[1];
  if (areas) {
    const arms = areas.split(",").map((area) => ({
      cast: { harness: "pi", effort: "high" },
      brief: `own the ${area.trim()} half of this task`,
    }));
    return flow()
      .fanout("split", { arms, join: "land" })
      .join("land", { strategy: "all-merge", onPass: "review" })
      .gate("review", {
        by: {
          cast: { harness: "claude", model: "claude-sonnet-5", effort: "high" },
          rubric: "criteria-vs-diff, every area present",
        },
        onPass: "done",
        onFail: "park",
      })
      .budget({ usd: 40, maxConcurrent: Math.min(arms.length, 4) })
      .build();
  }

  const effort = (ticket.criteria?.length ?? 0) >= 3 ? "high" : "medium";
  return presets.reviewedLifecycle({ harness: "pi", effort });
};

export const hooks = {
  async onEvent({ event, actions }) {
    // one free extension when the rework loop exhausts — then a human owns it
    if (event.type === "parked" && event.reason === "max_visits_exhausted") {
      await actions.resume({ extraVisits: 1 });
    }
  },
};
