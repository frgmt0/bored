/**
 * The stage manifest — §6.4. The machine-readable handshake that makes the
 * worker's picture of its environment explicit instead of an inference from
 * its cwd (§1.6): its branch, worktree, stage, position in the larger plan,
 * and remaining budget, stated somewhere it can read. The worker proves it
 * is in the right place (worker_ready) or declines to start
 * (worker_refused) — "every worker can prove where it is before it does
 * anything" (§6).
 */
import { createHash } from "node:crypto";
import type { NodeId, SuperviseSpec } from "../spec/types.js";
import type { SeatKey } from "../run/events.js";

export interface StageManifest {
  taskRef: string;
  seatKey: SeatKey;
  node: NodeId;
  nodeKind: string;
  visit: number;
  arm?: number;
  attempt: number;
  /** where they sit */
  worktree: string;
  branch: string;
  baseSha: string;
  /** the worker's position in the larger plan */
  flow: {
    entry: NodeId;
    position: NodeId;
    onPass?: string;
    onFail?: string;
  };
  /** what is left to spend when this seat starts */
  budget: {
    remainingUsd?: number;
    remainingWallClockS?: number;
  };
  /** advisory envelope, as today */
  envelope: { turnCap: number; wallClockS: number };
  supervise: Required<SuperviseSpec>;
  /** sha256 of the canonical manifest body — the handshake token */
  manifestHash: string;
}

export type ManifestBody = Omit<StageManifest, "manifestHash">;

/** Canonical JSON: stable key order so the hash is deterministic. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function manifestHashOf(body: ManifestBody): string {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}

export function buildManifest(body: ManifestBody): StageManifest {
  return { ...body, manifestHash: manifestHashOf(body) };
}

export type HandshakeVerdict =
  | { ok: true }
  | { ok: false; mismatch: "manifest_hash" | "branch" | "base_sha"; expected: string; observed: string };

/**
 * The engine-side check of a worker_ready claim: the worker echoes the
 * manifest hash and reports the branch/sha it actually observes.
 */
export function verifyReadiness(
  manifest: StageManifest,
  claim: { manifestHash: string; observedBranch: string; observedSha: string },
): HandshakeVerdict {
  if (claim.manifestHash !== manifest.manifestHash) {
    return {
      ok: false,
      mismatch: "manifest_hash",
      expected: manifest.manifestHash,
      observed: claim.manifestHash,
    };
  }
  if (claim.observedBranch !== manifest.branch) {
    return { ok: false, mismatch: "branch", expected: manifest.branch, observed: claim.observedBranch };
  }
  if (claim.observedSha !== manifest.baseSha) {
    return { ok: false, mismatch: "base_sha", expected: manifest.baseSha, observed: claim.observedSha };
  }
  return { ok: true };
}
