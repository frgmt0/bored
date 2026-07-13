/**
 * run-of-show — a per-task dynamic workflow engine, as a service primitive.
 *
 * Implements the OPS-152 design (rev 2): concierge-authored flow specs
 * (worker / gate / fanout / join) interpreted by a durable, event-sourced
 * stage manager with leases, alarms, heralded announcements and explicit
 * worker handshakes.
 */

// The flow-spec data model + linter (§3)
export * from "./spec/types.js";
export * from "./spec/schema.js";
export * from "./spec/lint.js";

// The run-event vocabulary, fold and store (§4.4, §4.5, §5.1)
export * from "./run/events.js";
export * from "./run/fold.js";
export * from "./run/store.js";

// The engine (§4, §5, §6)
export * from "./engine/ports.js";
export * from "./engine/manifest.js";
export * from "./engine/scheduler.js";
export * from "./engine/sentinel.js";
export * from "./engine/herald.js";
export * from "./engine/stageManager.js";

// Adapters
export * from "./adapters/simulated.js";
export * from "./adapters/git.js";

// Appendix A + §8 presets
export * as presets from "./presets.js";
