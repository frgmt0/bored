/** Shared renderer: print a deployment report stage by stage, with data. */
import type { DeploymentReport } from "./scenarios.js";

export function render(title: string, report: DeploymentReport): void {
  const { run, events, journal, stages, rig } = report;
  const bar = "─".repeat(74);
  console.log(`\n${bar}\n  ${title} — ${report.ref}\n${bar}`);

  console.log("\nSTAGES");
  stages.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

  console.log("\nRUN RECORD (the fold)");
  console.log(`  status   ${run.status}${run.outcome ? ` (${run.outcome})` : ""}`);
  console.log(`  visits   ${JSON.stringify(run.visits)}`);
  console.log(
    `  spend    $${run.spend.usd.toFixed(2)} total — ${Object.entries(run.spend.byNode)
      .map(([n, v]) => `${n} $${v.toFixed(2)}`)
      .join(", ")}`,
  );
  console.log(`  seats    ${Object.keys(run.seats).length}`);
  if (run.parked) console.log(`  parked   ${run.parked.reason} at ${run.parked.node ?? "-"}`);

  console.log("\nEVENT LOG (the twenty-word vocabulary, §4.4)");
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  console.log(
    `  ${events.length} events: ` +
      [...counts.entries()].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(", "),
  );

  console.log("\nANNOUNCEMENTS (the Herald, §6.3)");
  for (const a of rig.sink.announcements.filter((a) => a.ref === report.ref)) {
    console.log(`  [${a.severity.toUpperCase().padEnd(6)}] → ${a.target}: ${a.text}`);
  }

  console.log("\nJOURNAL (last 12 lines)");
  for (const line of journal.slice(-12)) console.log(`  ${line}`);
  console.log();
}
