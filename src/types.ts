/**
 * Shared types for Mnemosyne.
 *
 * These mirror the memory schema in docs/BUILD_PLAN.md (section 8).
 * MemoryRecord is the public record whose hash is committed on NEAR;
 * PrivateDecision only points at the private blob kept locally.
 */

import type { TeeEvidence } from "./private/decide.js";

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
  /** 1 = Phases 1-5 (stub decide). 2 = Phase 6: adds decision_path,
   *  private_commitment and (for near-ai-tee) public TEE evidence. */
  schema_version: 1 | 2;
  /** How the decision was made: inside a NEAR AI Cloud TEE, or by the
   *  deterministic local rule (no API key). Never overclaimed. */
  decision_path?: "near-ai-tee" | "local-policy";
  /** sha256(salt:canonical(private blob)). The blob and salt stay in
   *  data/runtime/private/; this binds them without revealing them. */
  private_commitment?: string;
  /** Public TEE evidence: hashes, enclave signature, attestation results.
   *  Contains nothing from the prompt or reasoning. */
  tee?: TeeEvidence | null;
}

/** Handle to the PRIVATE part of a decision (Phase 6). The reasoning
 * itself is produced inside the TEE and stored only in private_file. */
export interface PrivateDecision {
  cycle_id: string;
  path: "near-ai-tee" | "local-policy";
  /** Local file holding the full private blob + salt (never published). */
  private_file: string;
  guard_adjustments: number;
}

export interface CycleResult {
  memoryRecord: MemoryRecord;
  privateDecision: PrivateDecision;
  committed: boolean;
  /** On-chain report() outcome per active sub (only when committed). */
  reports?: Array<{ sub: SubId; status: "reported" | "skipped" | "failed"; error?: string }>;
}
