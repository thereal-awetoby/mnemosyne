/**
 * One-time testnet setup for REAL swarm balances (SWARM_STATE=onchain,
 * ALLOCATE_MODE=wnear). Idempotent: every step checks chain state first.
 *
 *   npm run swarm:setup                 register the sub accounts with wNEAR, wrap NEAR if the
 *                                       governor is short, fund each sub up to the seed capital
 *   npm run swarm:setup -- --seed 1000  seed capital per sub, in units (default 1000 = 0.01 wNEAR)
 *
 * Signs with the governor (a FullAccess key it already holds). The sub keys
 * stay report-only and are never used here. Testnet only, tiny amounts.
 */

import "dotenv/config";
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from "near-api-js";
import { txFailure, txHashOf } from "../nearTx.js";
import { SUB_AGENTS, subAccountId } from "../subAgents.js";
import { capitalUnitYocto, fmtWnear, ftBalance, rpcUrl, swarmAsset, unitsToYocto, yoctoToUnits } from "../swarmState.js";

const EXPLORER = "https://testnet.nearblocks.io/txns/";
const GOV = process.env.GOVERNOR_ACCOUNT_ID ?? "";
const KEY = process.env.GOVERNOR_PRIVATE_KEY ?? "";
const CALL_GAS = teraToGas(20);
const NEAR_FMT = (y: bigint) => (Number(y / 10n ** 18n) / 1e6).toFixed(4);

function seedUnits(): number {
  const i = process.argv.indexOf("--seed");
  const n = i >= 0 ? Number(process.argv[i + 1]) : 1000;
  if (!Number.isInteger(n) || n < 0 || n > 3000) throw new Error("--seed must be a whole number of units from 0 to 3000");
  return n;
}

async function main() {
  if (!GOV || !KEY) throw new Error("set GOVERNOR_ACCOUNT_ID / GOVERNOR_PRIVATE_KEY in .env");
  if (!rpcUrl().includes("testnet")) throw new Error("swarm:setup is testnet-only (NEAR_RPC_URL must be a testnet RPC)");
  const asset = swarmAsset();
  const unit = capitalUnitYocto();
  const seed = seedUnits();
  const provider = new JsonRpcProvider({ url: rpcUrl() });
  const gov = new Account(GOV, provider, KeyPairSigner.fromSecretKey(KEY as any));
  const view = async (contractId: string, method: string, args: Record<string, unknown>) => provider.callFunction({ contractId, method, args });

  async function send(receiverId: string, acts: any[], label: string) {
    const res: any = await gov.signAndSendTransaction({ receiverId, actions: acts, waitUntil: "FINAL" });
    const failure = txFailure(res);
    if (failure) throw new Error(`${label}: ${failure}`);
    console.log(`  done  ${label}\n        ${EXPLORER}${txHashOf(res)}`);
  }

  console.log(`\nswarm setup  (token ${asset}, governor ${GOV}, seed ${seed} units = ${fmtWnear(unitsToYocto(seed, unit))} wNEAR per sub)\n`);
  const acct: any = await provider.query({ request_type: "view_account", finality: "final", account_id: GOV } as any);
  console.log(`  governor NEAR balance: ${NEAR_FMT(BigInt(acct.amount))}`);

  // 1. every account that will hold wNEAR must be registered with the token
  const bounds = (await view(asset, "storage_balance_bounds", {})) as { min: string };
  for (const id of [GOV, ...SUB_AGENTS.map((s) => subAccountId(s.id))]) {
    if ((await view(asset, "storage_balance_of", { account_id: id })) !== null) { console.log(`  ok    ${id} already registered with ${asset}`); continue; }
    await send(asset, [actions.functionCall("storage_deposit", { account_id: id, registration_only: true }, CALL_GAS, BigInt(bounds.min))], `register ${id} with ${asset}`);
  }

  // 2. the governor must hold enough wNEAR to seed the subs plus a little to top up later
  const subBalances = new Map<string, bigint>();
  for (const s of SUB_AGENTS) subBalances.set(s.id, await ftBalance(subAccountId(s.id), asset));
  const needed = SUB_AGENTS.reduce((t, s) => { const have = subBalances.get(s.id)!; const want = unitsToYocto(seed, unit); return t + (have < want ? want - have : 0n); }, 0n);
  const reserve = unitsToYocto(1000, unit); // one cycle's worth of top-ups (ALLOCATE_MAX_UNITS default)
  let govW = await ftBalance(GOV, asset);
  const target = needed + reserve;
  if (govW < target) {
    const wrap = target - govW;
    await send(asset, [actions.functionCall("near_deposit", {}, CALL_GAS, wrap)], `wrap ${NEAR_FMT(wrap)} NEAR into wNEAR for the governor`);
    govW = await ftBalance(GOV, asset);
  } else console.log(`  ok    governor already holds ${fmtWnear(govW)} wNEAR`);

  // 3. top each sub up to the seed capital (never above)
  for (const s of SUB_AGENTS) {
    const id = subAccountId(s.id);
    const have = subBalances.get(s.id)!;
    const want = unitsToYocto(seed, unit);
    if (have >= want) { console.log(`  ok    sub ${s.id} ${id} already holds ${yoctoToUnits(have, unit)} units (${fmtWnear(have)} wNEAR)`); continue; }
    const amount = want - have;
    await send(asset, [actions.functionCall("ft_transfer", { receiver_id: id, amount: amount.toString(), memo: "mnemosyne swarm seed" }, CALL_GAS, 1n)], `fund sub ${s.id} ${id} with ${fmtWnear(amount)} wNEAR`);
  }

  console.log("\n  balances");
  console.log(`    governor  ${GOV}: ${fmtWnear(await ftBalance(GOV, asset))} wNEAR`);
  for (const s of SUB_AGENTS) {
    const b = await ftBalance(subAccountId(s.id), asset);
    console.log(`    sub ${s.id}     ${subAccountId(s.id)}: ${yoctoToUnits(b, unit)} units (${fmtWnear(b)} wNEAR)`);
  }
  console.log("\nReady. For real balances:  set SWARM_STATE=onchain   (and for real top-ups: set ALLOCATE_MODE=wnear)\n");
}

main().catch((err) => {
  console.error(`\nswarm:setup failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
