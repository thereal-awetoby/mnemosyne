/**
 * Swarm state for the READ step.
 *
 *   SWARM_STATE unset or "simulated"   fixed scenario (calm | stressed | recovery).
 *                                      The offline default, so demos and CI need no network.
 *   SWARM_STATE=onchain                each sub's capital is its REAL wNEAR balance on
 *                                      NEAR testnet (ft_balance_of on wrap.testnet).
 *
 * In on-chain mode only the balances are real. Mnemosyne is a non-trading
 * governor, so there is no profit and loss to read from the chain:
 * lastCycleLoss still comes from SWARM_SCENARIO and is labelled simulated.
 *
 * Capital is counted in "units". One unit is CAPITAL_UNIT_YOCTO yocto of wNEAR
 * (default 1e19 = 0.00001 wNEAR), so the default 1000-unit allocation is
 * 0.01 wNEAR. Testnet only, tiny on purpose.
 *
 * Fail-closed: in on-chain mode a balance that cannot be read throws. It never
 * quietly falls back to simulated numbers.
 */

import { JsonRpcProvider } from "near-api-js";
import { readFakeSwarmState, SUB_AGENTS, subAccountId, type FakeSubState } from "./subAgents.js";

export type SwarmSource = "simulated" | "onchain";

export function swarmSource(): SwarmSource {
  const v = (process.env.SWARM_STATE ?? "simulated").trim().toLowerCase();
  if (v === "" || v === "simulated") return "simulated";
  if (v === "onchain") return "onchain";
  throw new Error(`unknown SWARM_STATE "${v}" (simulated | onchain)`);
}

export const swarmAsset = (): string => process.env.SWARM_ASSET || process.env.X402_ASSET || "wrap.testnet";
export const rpcUrl = (): string => process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";

export function capitalUnitYocto(): bigint {
  const raw = process.env.CAPITAL_UNIT_YOCTO;
  if (!raw || !raw.trim()) return 10n ** 19n;
  if (!/^[1-9][0-9]*$/.test(raw.trim())) throw new Error("CAPITAL_UNIT_YOCTO must be a positive whole number of yoctoNEAR");
  return BigInt(raw.trim());
}

export function yoctoToUnits(yocto: bigint, unit: bigint = capitalUnitYocto()): number {
  const u = yocto / unit;
  return u > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(u);
}

export const unitsToYocto = (units: number | bigint, unit: bigint = capitalUnitYocto()): bigint => BigInt(units) * unit;

/** "0.01000" style amount of wNEAR for display. */
export function fmtWnear(yocto: bigint): string {
  return (Number(yocto / 10n ** 15n) / 1e9).toFixed(5);
}

/** wNEAR balance of an account, in yocto. Throws on any RPC problem. */
export async function ftBalance(accountId: string, asset: string = swarmAsset()): Promise<bigint> {
  const provider = new JsonRpcProvider({ url: rpcUrl() });
  const res: any = await provider.callFunction({ contractId: asset, method: "ft_balance_of", args: { account_id: accountId } });
  if (typeof res !== "string" || !/^[0-9]+$/.test(res)) throw new Error(`unexpected ft_balance_of answer for ${accountId}: ${JSON.stringify(res)}`);
  return BigInt(res);
}

export interface SwarmSnapshot {
  source: SwarmSource;
  state: FakeSubState[];
  /** real balances per sub (on-chain mode only) */
  balances: Record<string, { account: string; yocto: string }> | null;
  unit_yocto: string;
  asset: string;
}

export async function readSwarm(deps: { balanceOf?: (accountId: string) => Promise<bigint> } = {}): Promise<SwarmSnapshot> {
  const source = swarmSource();
  const simulated = readFakeSwarmState();
  const unit = capitalUnitYocto();
  const base = { unit_yocto: unit.toString(), asset: swarmAsset() };
  if (source === "simulated") return { source, state: simulated, balances: null, ...base };

  const balanceOf = deps.balanceOf ?? ((id: string) => ftBalance(id));
  const balances: Record<string, { account: string; yocto: string }> = {};
  const state: FakeSubState[] = [];
  for (const s of SUB_AGENTS) {
    const account = subAccountId(s.id);
    let yocto: bigint;
    try {
      yocto = await balanceOf(account);
    } catch (err) {
      throw new Error(`could not read the real balance of ${account}: ${(err as Error).message}`);
    }
    balances[s.id] = { account, yocto: yocto.toString() };
    state.push({ sub: s.id, capital: yoctoToUnits(yocto, unit), lastCycleLoss: simulated.find((x) => x.sub === s.id)!.lastCycleLoss });
  }
  return { source, state, balances, ...base };
}
