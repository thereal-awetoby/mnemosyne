// Phase 4: local REFUSE logic for sub-agents.
//
// Each sub-agent evaluates the governor's directive against its own
// hardcoded mandate ceiling and may refuse to act even when the
// governor says KEEP. This is LOCAL-ONLY for now: refusals are
// computed and printed, but not yet written on-chain via the
// contract's report() method -- that needs each sub's own NEAR
// signing key wired into near-api-js, which is a separate step
// (see HANDOFF.md "Not done yet").

export type GovernorDirective = {
  sub: string;
  status: "KEEP" | "PAUSE";
  target_capital: number;
  max_position: number;
  max_loss_cycle: number;
  mandate: string;
};

export type SubRuntimeDecision = {
  sub: string;
  action: "ACT" | "REFUSE";
  reason: string;
};

// Hardcoded per-mandate ceilings. Sub C is defensive/reduce-only, so
// it gets a tighter loss ceiling than A and B on purpose -- a
// defensive agent should refuse sooner, not later.
const MANDATE_CEILINGS: Record<
  string,
  { maxPosition: number; maxLossCycle: number }
> = {
  mean_reversion_only: { maxPosition: 200, maxLossCycle: 50 },
  inventory_liquidity_only: { maxPosition: 200, maxLossCycle: 50 },
  defensive_reduce_only: { maxPosition: 150, maxLossCycle: 30 },
};

export function evaluateSubDecision(
  directive: GovernorDirective
): SubRuntimeDecision {
  const ceiling = MANDATE_CEILINGS[directive.mandate];

  // Unknown mandate -> fail-closed. A sub should never silently act
  // under a mandate it doesn't recognize.
  if (!ceiling) {
    return {
      sub: directive.sub,
      action: "REFUSE",
      reason: `unknown mandate "${directive.mandate}" -- no ceiling on file, fail-closed`,
    };
  }

  // Contradictory directive from the governor -- refuse rather than
  // guess what was meant.
  if (directive.status === "PAUSE" && directive.target_capital !== 0) {
    return {
      sub: directive.sub,
      action: "REFUSE",
      reason: "contradictory directive: PAUSE with nonzero target_capital",
    };
  }

  if (directive.max_position > ceiling.maxPosition) {
    return {
      sub: directive.sub,
      action: "REFUSE",
      reason: `max_position ${directive.max_position} exceeds mandate ceiling ${ceiling.maxPosition}`,
    };
  }

  if (directive.max_loss_cycle > ceiling.maxLossCycle) {
    return {
      sub: directive.sub,
      action: "REFUSE",
      reason: `max_loss_cycle ${directive.max_loss_cycle} exceeds mandate ceiling ${ceiling.maxLossCycle}`,
    };
  }

  return {
    sub: directive.sub,
    action: "ACT",
    reason: "within mandate ceiling",
  };
}
