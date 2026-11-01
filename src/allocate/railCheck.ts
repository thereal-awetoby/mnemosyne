/**
 * Rail check: prove the real wNEAR top-up works on testnet without waiting for
 * the governor to choose INCREASE (it is told that protecting capital beats
 * growth, so it often will not).
 *
 * It sends a tiny transfer (1 unit by default, 100 at most) with the SAME code
 * and the SAME memo format a cycle uses, and it keeps the same rule: no memory,
 * no money. It refuses unless
 *   - the chain holds a memory commit, and
 *   - the newest committed hash matches a record on this machine that still
 *     recomputes to its own decision_hash and sits inside its own limits.
 * The memo carries that hash's prefix, so the transfer can be matched to the
 * commit that allowed it.
 *
 * This is a check, not a governor decision. It is never called by a cycle.
 */

import { SUB_AGENTS, subAccountId } from "../subAgents.js";
import { capitalUnitYocto, fmtWnear, unitsToYocto, yoctoToUnits } from "../swarmState.js";
import type { SubId } from "../types.js";
import { assertMemoryGate, defaultIsRegistered, defaultTransfer, maxUnitsPerCycle, memoFor, type AllocateDeps } from "./index.js";

/** A check never moves more than this, whatever ALLOCATE_MAX_UNITS says. */
export const RAIL_CHECK_MAX_UNITS = 100;

export class RailCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailCheckError";
  }
}

export interface RailCheckDeps extends Pick<AllocateDeps, "unitYocto" | "isRegistered" | "transfer"> {
  /** the on-chain head of the memory contract */
  head: () => Promise<{ latest_hash: string | null; commit_count: number }>;
  /** public records saved on this machine by earlier cycles */
  localRecords: () => any[];
  /** wNEAR balance in yocto */
  balanceOf: (accountId: string) => Promise<bigint>;
  governorId: string;
}

export interface RailCheckReport {
  decision_hash: string;
  cycle_id: string;
  sub: SubId;
  account: string;
  units: number;
  wnear: string;
  memo: string;
  tx: string;
  /** the token's own transfer log carries the memo */
  memo_in_logs: boolean;
  before_units: number;
  after_units: number;
}

export async function runRailCheck(opts: { sub: string; units: number }, deps: RailCheckDeps): Promise<RailCheckReport> {
  const unit = deps.unitYocto ?? capitalUnitYocto();
  const sub = opts.sub.trim().toUpperCase() as SubId;
  const profile = SUB_AGENTS.find((a) => a.id === sub);
  if (!profile) throw new RailCheckError(`unknown sub "${opts.sub}" (use A or B)`);
  if (profile.mandate === "defensive_reduce_only") throw new RailCheckError(`sub ${sub} is reduce-only and is never topped up (use A or B)`);

  const cap = Math.min(RAIL_CHECK_MAX_UNITS, maxUnitsPerCycle());
  if (!Number.isInteger(opts.units) || opts.units < 1 || opts.units > cap) {
    throw new RailCheckError(`--units must be a whole number from 1 to ${cap}`);
  }

  // 1. no memory, no money
  const head = await deps.head();
  if (!head.latest_hash || head.commit_count === 0) throw new RailCheckError("the chain holds no memory commit yet: run npm run cycle first. No memory, no money.");
  const record = deps.localRecords().find((r) => r?.decision_hash === head.latest_hash);
  if (!record) {
    throw new RailCheckError(`the newest on-chain memory commit (${head.latest_hash.slice(0, 19)}...) has no record on this machine, so the transfer could not be matched to it. Run npm run cycle here first.`);
  }
  assertMemoryGate({ record, commit: { committed: true }, state: [], source: "onchain" }); // throws AllocationGateError

  // 2. the usual checks of the real rail
  const account = subAccountId(sub);
  const yocto = unitsToYocto(opts.units, unit);
  const govBalance = await deps.balanceOf(deps.governorId);
  if (govBalance < yocto) throw new RailCheckError(`the governor holds ${fmtWnear(govBalance)} wNEAR and needs ${fmtWnear(yocto)} (run npm run swarm:setup)`);
  if (!(await (deps.isRegistered ?? defaultIsRegistered)(account))) throw new RailCheckError(`${account} is not registered with the token (run npm run swarm:setup)`);

  // 3. send, then read the balance again
  const before = await deps.balanceOf(account);
  const memo = memoFor(record.decision_hash);
  const { tx, logs = [] } = await (deps.transfer ?? defaultTransfer)(account, yocto, memo);
  const after = await deps.balanceOf(account);

  return {
    decision_hash: record.decision_hash,
    cycle_id: String(record.cycle_id ?? ""),
    sub,
    account,
    units: opts.units,
    wnear: fmtWnear(yocto),
    memo,
    tx,
    memo_in_logs: logs.some((l) => l.includes(memo)),
    before_units: yoctoToUnits(before, unit),
    after_units: yoctoToUnits(after, unit),
  };
}
