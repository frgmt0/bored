# run-of-show

A per-task **dynamic workflow engine with a ticket tracker on top** — both
layers of the *Run of Show* design proposal (OPS-151 → OPS-152, rev 2):

- **the execution layer** (dispatcher replacement): every task carries a
  small, validated DAG — the **flow spec** — interpreted by a generic,
  event-sourced **stage manager**. Stages, iteration budgets, parallel
  fan-out, join rules and human gates are data, not dispatcher source.
- **the tracker layer** (Plane replacement): a real **ticket entity** on the
  `#N / #N.x` tree, **cross-task `needs` dependencies** with
  promote-on-done, the **eight-value state model** (backlog / todo / design /
  design_review / in_progress / in_review / done / cancelled) projected live
  from the run record, an **HTTP API + CLI** to drive it all, and a **real
  agent-spawn adapter** that runs actual worker processes in git worktrees.

The engine holds the design's two reliability invariants:

1. **Every abnormal event reaches a human surface within sixty seconds** —
   the Herald classifies every run event trace/status/page and delivers
   synchronously after the fsync'd append.
2. **Every worker can prove where it is before it does anything** — each seat
   receives a hashed stage manifest (branch, base sha, position in the plan,
   remaining budget) and must complete the `worker_ready` handshake or refuse.

## The node algebra (§3)

Four node kinds, a closed set. No expressions, no conditionals beyond
pass/fail edges:

| kind     | what it is                                                              |
| -------- | ----------------------------------------------------------------------- |
| `worker` | one cast seat in the task worktree; `onPass`/`onFail` edges, `maxVisits` re-entry cap, same-visit `retries` |
| `gate`   | a decision point: `by: "human"` (parked, zero tokens) or a cheap model check with a rubric; `maxFails` bounces |
| `fanout` | N parallel arms of *this* task, each in an isolated worktree forked from one captured base |
| `join`   | how arms become one line again: `all-merge`, `first`, `quorum`, or a `judge` cast seat |

Every loop is bounded by construction: all caps are finite positive integers
at the schema layer — `Infinity` (and "alarms: off") is simply not
representable — and the linter refuses unknown edges, unreachable nodes,
orphaned/shared joins, arm escape, insane budgets and blocked casts.

## Layout — one module per design component (§4)

```
src/
  spec/types.ts        the FlowSpec data model (§3.2)
  spec/schema.ts       zod validation at filing time
  spec/lint.ts         the Flow Linter (§3.3) — pure, no I/O
  run/events.ts        the closed twenty-event run vocabulary (§4.4)
  run/fold.ts          FlowRun = fold(event log) — pure, deterministic (§5.1)
  run/store.ts         the Run Store (§4.5): append-only fsync'd JSONL + head cache
  engine/ports.ts      the three internal contracts (§4.2) + world-facing ports
  engine/manifest.ts   the stage manifest + readiness handshake (§6.4)
  engine/scheduler.ts  the Seat Scheduler: caps, FIFO, (run,node,visit,arm) dedup
  engine/sentinel.ts   leases, quiet→stall, overrun, ready deadline (§6.1)
  engine/herald.ts     trace/status/page routing, ≤60s invariant (§6.3)
  engine/stageManager.ts  the interpreter: §4.3's append→fold→decide→gate→act→announce
  adapters/simulated.ts   hand-cranked workers + fake worktrees (tests, simulations)
  adapters/git.ts         real git worktrees, branches and merges
  adapters/process.ts     REAL workers: child processes + the JSONL driver protocol
  tracker/ticket.ts    the ticket entity: #N/#N.x refs, needs, states (§1.1/§1.5)
  tracker/store.ts     tasks.json — the local, locked, versioned registry
  tracker/tracker.ts   filing, staffing, promote-on-done, state projection
  server.ts            the HTTP API over the tracker
  presets.ts           Appendix A: today's lifecycles as specs, plus §8 shapes
  cli.ts               lint/status/journal/events + serve/board/file/nudge/gate/…
examples/              §7 — the three simulated deployments, runnable
test/                  150+ tests, unit through end-to-end
```

Storage layout under the engine root (default `~/.beckett` for the CLI):
`runs/<ref>.jsonl` (the source of truth), `runs/<ref>.head.json` (cache only),
`journal/<ref>.log`, `spend.jsonl`.

## Running it as a tracker (server + real workers)

```bash
# boot the board over a repo; every seat spawns your worker command in its
# own git worktree, speaking the JSONL driver protocol (adapters/process.ts)
npx run-of-show serve --root ~/.beckett --repo /path/to/repo \
  --worker "node my-worker.cjs" --port 7770

# file work over the wire (auto-staffs when its needs are met)
npx run-of-show file --title "notification prefs API" --body "…" --criteria "stores prefs"
npx run-of-show file --title "prefs UI" --needs "#1"     # promotes when #1 is done
npx run-of-show board
npx run-of-show gate "#1" --node design_review --verdict pass
npx run-of-show nudge "#1" "prefer the small fix" --node implement
```

A worker is any executable: it gets `BECKETT_MANIFEST` (the §6.4 stage
manifest, written into `.beckett/stage-manifest.json` in its worktree) and
`BECKETT_BRIEF`, proves where it is (`worker_ready` with the manifest hash +
the branch/sha it observes via git), emits progress events on stdout, and
finishes with a done-signal. A process that dies silently is alarmed,
retried, and parked by the engine — never lost.

## Using it as a primitive

```ts
import {
  StageManager, GitWorktreeSpawnAdapter, GitMergeProvider, systemClock,
} from "run-of-show";

const adapter = new GitWorktreeSpawnAdapter(repoRoot, systemClock);
const engine = new StageManager(root, adapter, new GitMergeProvider(adapter), mySink, {
  clock: systemClock,
  maxWorkers: 8,
  ownerDM: "dm:ro",
});
adapter.connect((ref, seatKey, ev) => engine.deliverWorkerEvent(ref, seatKey, ev));

await engine.open("#42.1", spec, { originChannel: "discord:ops", body, criteria });
// on a ≤30s cadence:
await engine.tick();
// on boot:
await engine.recoverAll();
// operator verbs:
engine.nudge("#42.1", "prefer the small fix", "implement");
await engine.decideHumanGate("#42.1", "design_review", "pass");
await engine.pause("#42.1"); await engine.resume("#42.1", { extraVisits: 1 });
```

The `SpawnAdapter` is the port a real deployment fills with its harness
drivers (claude/codex/pi): provision a worktree, spawn a worker against a
`SeatRequest` (brief + manifest + envelope), pipe its driver events back into
`deliverWorkerEvent`. The shipped `SimulatedSpawnAdapter` speaks the same
event vocabulary with hand-cranked workers; `GitWorktreeSpawnAdapter` runs
the same seats over real worktrees/branches/merges.

## The simulated deployments (§7)

Three deployments run stage-by-stage with real specs, event logs and worker
manifests — as runnable scripts *and* as asserted tests (the same scenario
code backs both, so the demo can't drift from the proof):

```
npm run deploy:one-pass   # §7.1 a one-pass README fix: 1 seat, 7 events, $0.35
npm run deploy:fanout     # §7.2 backend+frontend fan-out → all-merge → review
npm run deploy:recovery   # §7.3 stall → abort+retry → engine reboot re-staff → rework → done
npm run deploy:all
```

## Testing

```
npm test        # 125 tests across 14 files
npm run typecheck
```

Coverage highlights:

- **Linter**: every refusal class in §3.3, plus proof the shipped presets validate.
- **Run Store**: crash-truncation tolerance, loud mid-file corruption, stale/corrupt head rebuild.
- **Fold**: determinism, prefix consistency, full bookkeeping.
- **Worker/gate/fanout/join semantics**: pass/fail edges, retry ladders, cap
  parks and resume grants, human + model gates, all four join strategies, the
  silent arm, the half-merged join, fail-fast sibling abort.
- **Budgets**: usd/wall-clock ceilings pre-spawn and mid-run, per-run
  `maxConcurrent` FIFO queueing, global `max_workers` across runs, dedup.
- **Sentinel**: the three clocks + hard backstop; a slow worker never dies,
  a dead one always does; `progress_noted` rollups at most 1/min/seat.
- **Handshake**: manifest hash determinism, branch/sha mismatch refusal + re-staff.
- **Herald**: full classification table; the ≤60s invariant audited across a failing run.
- **Crash recovery (property test)**: a reviewed run and a fanout run are
  killed after *every* event of their logs; the rebooted engine drives each
  to the same outcome with no duplicated verdicts.
- **Real git integration**: worktree provisioning, base capture, both-files
  merge, and a genuine conflict parking the half-merged join.
- **Appendix A equivalence**: OPS reviewed lifecycle, one-pass, and INT design
  flow walk the same stages with the same caps as today's constants
  (`MAX_REWORK_CYCLES`, `MAX_IMPLEMENT_RETRIES`, `MAX_DESIGN_CYCLES`).
- **Tracker layer**: ref allocation and the one-level tree, needs validation,
  promote-on-done (single, multiple, and autoStaff:false needs), state
  projection across all three lifecycles incl. the INT state_map, tracker
  recovery with missed promotions, and the versioned/locked registry.
- **Real workers**: an actual node child process handshakes against real git
  state, commits real output and completes the run; silent exits alarm and
  re-staff; refusals walk the refusal path; nudges arrive over stdin.
- **HTTP API**: the full lifecycle driven over the wire (file, staff, nudge,
  gate verdicts, pause/resume, cancel, deps promotion) with 400/404/409
  error mapping.

## CLI

```
npx run-of-show lint spec.json [--max-workers 8]
npx run-of-show status  "#42.1" --root ~/.beckett
npx run-of-show journal "#42.1" --tail 20
npx run-of-show events  "#42.1" --tail 20
```

## Fidelity notes

Built from the design PDF (rev 2, 12 July 2026), pages 1–22 (§1 through
§6.1) — the uploaded file ends there; §6.2–§10 and Appendix A were
reconstructed from the TOC, §1.6, §3.4, §4.4 and §6.1's forward references.
Deliberate implementation choices, all documented in-code:

- **Arm branches use a dot separator** (`beckett/task-42.1.arm-2`, not
  `…/arm-2`): git's ref hierarchy cannot hold both `a/b` and `a/b/c`.
- **`retries: 0` is representable** — "one pass, no retries" was an explicit
  §2.2 ask; every other counter keeps its ≥1 floor.
- **`DoneSignal.data`** carries verdict-shaped structured output (`{pass}`
  for gate seats, `{winner}`/`{synthesis}` for judges) — the "harness-native
  structured output" channel of §1.4, typed.
- **`run_opened` carries `body`/`criteria`** so briefs are derivable from the
  log alone.
- **Escalation ladder (§6.2 reconstruction)**: quiet window 1 → status-check
  nudge; `quietStrikes` windows → stall alarm → abort with WIP checkpoint →
  same-visit retry → exhausted → park (paged). Overrun stays advisory; the
  hard backstop kill pages; ready-timeout and refusals ride the same ladder.
- **Grants are per-node**: resuming a cap-exhaustion park with `extraVisits`
  arms the parked node only; each cap needs its own authority.
