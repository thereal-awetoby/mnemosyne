/**
 * Sub-agent mandates (docs/BUILD_PLAN.md section 9).
 *
 * Phase 1: these are just descriptions + a fake "state" the governor can
 * read. No real keys, no real chain calls. Phase 3 wires these to real
 * NEAR function-call keys; Phase 4 adds real local REFUSE logic.
 */

import type { SubId } from "./types.js";

export interface SubAgentProfile {
  id: SubId;
  mandate: string;
  description: string;
}

export const SUB_AGENTS: SubAgentProfile[] = [
  {
    id: "A",
    mandate: "mean_reversion_only",
    description: "One style only (e.g. mean-reversion style logic).",
  },
  {
    id: "B",
    mandate: "inventory_liquidity_only",
    description: "Inventory / liquidity style only.",
  },
  {
    id: "C",
    mandate: "defensive_reduce_only",
    description: "Defensive / reduce-risk only. May only shrink risk.",
  },
];

/** Fake per-cycle "state" for each sub-agent, standing in for real
 * balances/positions read from NEAR in a later phase. */
export interface FakeSubState {
  sub: SubId;
  capital: number;
  lastCycleLoss: number;
}

export function readFakeSwarmState(): FakeSubState[] {
  return SUB_AGENTS.map((s) => ({
    sub: s.id,
    capital: 1000,
    lastCycleLoss: 0,
  }));
}
