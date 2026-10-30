/**
 * Shared types for Mnemosyne.
 *
 * These mirror the memory schema in docs/BUILD_PLAN.md (section 8).
 * This phase (Phase 1 — skeleton) only uses these in-memory / in a local
 * JSON log. Nothing here touches NEAR yet.
 */

export type SubId = "A" | "B" | "C";

export type SubAction = "KEEP" | "INCREASE" | "CUT" | "PAUSE";

export interface SubDecision {
  sub: SubId;
  action: SubAction;
  /** Only present when action is not PAUSE. Kept as strings — these will
   * eventually be NEAR-denominated amounts, and strings avoid float
   * rounding issues once real numbers are involved. */
  target_capital?: string;
  max_position?: string;
  max_loss_cycle?: string;
  mandate?: string;
  /** Present when action is PAUSE (or any refusal). */
  reason_code?: string;
}

export interface SwarmRisk {
  max_total_exposure: string;
  max_daily_loss: string;
}

/** The PUBLIC part of a decision — this is what will eventually go
 * on-chain as the memory commitment (hash of this object, plus the
 * object's own public fields). No private reasoning lives here. */
export interface MemoryRecord {
  cycle_id: string;
  governor: string;
  decision_hash: string;
  prev_memory_hash: string | null;
  decisions: SubDecision[];
  swarm_risk: SwarmRisk;
  schema_version: 1;
}

/** The PRIVATE part of a decision — full reasoning. In this phase it's
 * just kept in local memory/logs, clearly labeled. Phase 6 moves this
 * behind a private execution path (NEAR AI Cloud / isolated worker) and
 * stops writing it anywhere public. */
export interface PrivateDecision {
  cycle_id: string;
  reasoning: string;
  raw_inputs: Record<string, unknown>;
}

export interface CycleResult {
  memoryRecord: MemoryRecord;
  privateDecision: PrivateDecision;
  committed: boolean;
  /** On-chain report() outcome per active sub (only when committed). */
  reports?: Array<{ sub: SubId; status: "reported" | "skipped" | "failed"; error?: string }>;
}
