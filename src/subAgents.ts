/**
 * Sub-agent mandates (docs/BUILD_PLAN.md section 9).
 *
 * Each sub has its own NEAR account. The cycle runner only ever holds a
 * `report`-only function-call key for each sub (SUB_<X>_PRIVATE_KEY in
 * .env) -- never a FullAccess key. See docs/PHASE3_KEYS.md.
 *
 * Swarm "state" (capital, last-cycle loss) is still simulated -- clearly
 * labeled as such -- until there is a real position source to read.
 */

import type { SubId } from "./types.js";

export interface SubAgentProfile {
  id: SubId;
  mandate: string;
  description: string;
  /** Default testnet account; override with SUB_<X>_ACCOUNT_ID in .env. */
  defaultAccountId: string;
}

export const SUB_AGENTS: SubAgentProfile[] = [
  {
    id: "A",
    mandate: "mean_reversion_only",
    description: "One style only (e.g. mean-reversion style logic).",
    defaultAccountId: "mnemosyne-sub-a.testnet",
  },
  {
    id: "B",
    mandate: "inventory_liquidity_only",
    description: "Inventory / liquidity style only.",
    defaultAccountId: "mnemosyne-sub-b.testnet",
  },
  {
    id: "C",
    mandate: "defensive_reduce_only",
    description: "Defensive / reduce-risk only. May only shrink risk.",
    // The original mnemosyne-sub-c.testnet was bricked (FullAccess deleted
    // before a working key existed). sub-c2 replaced it; the contract's
    // SUB_ACCOUNTS list was updated to match.
    defaultAccountId: "mnemosyne-sub-c2.testnet",
  },
  {
    id: "D",
    mandate: "volatility_capped",
    description: "May grow or shrink like A and B, but its position and loss stay a fixed share of its OWN target -- a relative ceiling, not a fixed number of units.",
    defaultAccountId: "mnemosyne-sub-d.testnet",
  },
];

export function subAccountId(sub: SubId): string {
  const fromEnv = process.env[`SUB_${sub}_ACCOUNT_ID`];
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : SUB_AGENTS.find((s) => s.id === sub)!.defaultAccountId;
}

/** The sub's report-only secret key, or undefined if not configured. */
export function subPrivateKey(sub: SubId): string | undefined {
  const k = process.env[`SUB_${sub}_PRIVATE_KEY`];
  return k && k.trim() ? k.trim() : undefined;
}

/** Simulated per-cycle "state" for each sub-agent, standing in for real
 * balances/positions read from NEAR in a later phase. */
export interface FakeSubState {
  sub: SubId;
  capital: number;
  lastCycleLoss: number;
}

/**
 * SIMULATED swarm state. SWARM_SCENARIO picks one of a few fixed situations
 * so the decision path has something to reason about:
 *   calm      (default) every sub at 1000, no losses
 *   stressed  B lost 60 last cycle, C lost 120 (past the pause threshold)
 *   recovery  A had a clean cycle and has room to grow, C is shrinking
 */
// D's loss numbers are deliberately kept below the pause threshold in every
// scenario: its mandate refuses through refuse.ts's own ratio check (see
// below), not through the governor's forced-pause-on-loss path that B and C
// also hit. Two independently demoable REFUSE subs, via two different
// mechanisms (C: an absolute ceiling; D: a ratio of its own target).
const SCENARIOS: Record<string, Record<SubId, { capital: number; lastCycleLoss: number }>> = {
  calm: { A: { capital: 1000, lastCycleLoss: 0 }, B: { capital: 1000, lastCycleLoss: 0 }, C: { capital: 1000, lastCycleLoss: 0 }, D: { capital: 1000, lastCycleLoss: 0 } },
  stressed: { A: { capital: 1000, lastCycleLoss: 10 }, B: { capital: 1000, lastCycleLoss: 60 }, C: { capital: 900, lastCycleLoss: 120 }, D: { capital: 950, lastCycleLoss: 30 } },
  recovery: { A: { capital: 800, lastCycleLoss: 0 }, B: { capital: 1000, lastCycleLoss: 20 }, C: { capital: 700, lastCycleLoss: 5 }, D: { capital: 850, lastCycleLoss: 0 } },
};

export function swarmScenario(): string {
  const name = (process.env.SWARM_SCENARIO ?? "calm").toLowerCase();
  if (!SCENARIOS[name]) throw new Error(`unknown SWARM_SCENARIO "${name}" (calm | stressed | recovery)`);
  return name;
}

export function readFakeSwarmState(): FakeSubState[] {
  const sc = SCENARIOS[swarmScenario()];
  return SUB_AGENTS.map((s) => ({ sub: s.id, ...sc[s.id] }));
}
