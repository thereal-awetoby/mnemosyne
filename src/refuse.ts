// Phase 4: local REFUSE logic for sub-agents.
//
// Each sub-agent evaluates the governor's directive against its own
// hardcoded mandate rules and may refuse to act even when the governor
// says KEEP. The result (ACT / REFUSE + reason) is then written on-chain
// by the sub itself via report() -- see src/report.ts.

import type { SubAction } from "./types.js";

export type GovernorDirective = {
  sub: string;
  status: SubAction; // KEEP | INCREASE | CUT | PAUSE
  target_capital: number;
  max_position: number;
  max_loss_cycle: number;
  mandate: string;
  /** Capital the sub holds right now. Needed for the reduce-only rule;
   *  if absent, a reduce-only sub refuses (fail-closed). */
  current_capital?: number;
};

export type SubRuntimeDecision = {
  sub: string;
  action: "ACT" | "REFUSE";
  reason: string;
};

// Hardcoded per-mandate rules. Sub C is defensive/reduce-only, so it gets a
// tighter ceiling than A and B on purpose -- a defensive agent should refuse
// sooner, not later -- and it may never take on MORE capital.
const MANDATE_RULES: Record<
  string,
  { maxPosition: number; maxLossCycle: number; reduceOnly: boolean }
> = {
  mean_reversion_only: { maxPosition: 200, maxLossCycle: 50, reduceOnly: false },
  inventory_liquidity_only: { maxPosition: 200, maxLossCycle: 50, reduceOnly: false },
  defensive_reduce_only: { maxPosition: 150, maxLossCycle: 30, reduceOnly: true },
};

function refuse(sub: string, reason: string): SubRuntimeDecision {
  return { sub, action: "REFUSE", reason };
}

export function evaluateSubDecision(directive: GovernorDirective): SubRuntimeDecision {
  const { sub } = directive;
  const rules = MANDATE_RULES[directive.mandate];

  // Unknown mandate -> fail-closed.
  if (!rules) return refuse(sub, `unknown mandate "${directive.mandate}", fail-closed`);

  // Malformed numbers -> fail-closed (Number("abc") is NaN, NaN > x is false,
  // which would otherwise silently pass every ceiling check).
  for (const k of ["target_capital", "max_position", "max_loss_cycle"] as const) {
    const v = directive[k];
    if (!Number.isFinite(v) || v < 0) return refuse(sub, `invalid ${k} "${v}", fail-closed`);
  }

  // Contradictory directive -- refuse rather than guess.
  if (directive.status === "PAUSE" && directive.target_capital !== 0) {
    return refuse(sub, "contradictory directive: PAUSE with nonzero target_capital");
  }

  if (rules.reduceOnly) {
    if (directive.status === "INCREASE") {
      return refuse(sub, "reduce-only mandate: INCREASE not allowed");
    }
    if (directive.current_capital === undefined || !Number.isFinite(directive.current_capital)) {
      return refuse(sub, "reduce-only mandate: current capital unknown, fail-closed");
    }
    if (directive.target_capital > directive.current_capital) {
      return refuse(
        sub,
        `reduce-only mandate: target_capital ${directive.target_capital} > current ${directive.current_capital}`
      );
    }
  }

  if (directive.max_position > rules.maxPosition) {
    return refuse(sub, `max_position ${directive.max_position} exceeds mandate ceiling ${rules.maxPosition}`);
  }
  if (directive.max_loss_cycle > rules.maxLossCycle) {
    return refuse(sub, `max_loss_cycle ${directive.max_loss_cycle} exceeds mandate ceiling ${rules.maxLossCycle}`);
  }

  return { sub, action: "ACT", reason: "within mandate" };
}
