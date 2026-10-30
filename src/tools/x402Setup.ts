/**
 * One-time testnet setup for real x402 settlement (X402_RAIL=near-testnet).
 * Idempotent: every step checks chain state first and skips what's done.
 *
 *   npm run x402:setup                  register payTo with the token; show balances
 *   npm run x402:setup -- --new-payer   also create + fund a demo payer agent
 *
 * Needs a funded full-access account to sign with (the relayer):
 *   X402_RELAYER_ACCOUNT_ID / X402_RELAYER_PRIVATE_KEY, or by default
 *   GOVERNOR_ACCOUNT_ID / GOVERNOR_PRIVATE_KEY.
 *
 * Amounts are deliberately tiny and testnet-only.
 */

import "dotenv/config";
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from "near-api-js";
import { generateNearKeyPair, implicitAccountId } from "../x402/crypto.js";
import { txFailure, txHashOf } from "../nearTx.js";

const RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const ASSET = process.env.X402_ASSET || "wrap.testnet";
const PAY_TO = process.env.GOVERNOR_ACCOUNT_ID || "mnemosyne-gov.testnet";
const RELAYER_ID = process.env.X402_RELAYER_ACCOUNT_ID || process.env.GOVERNOR_ACCOUNT_ID || "";
const RELAYER_KEY = process.env.X402_RELAYER_PRIVATE_KEY || process.env.GOVERNOR_PRIVATE_KEY || "";

const NEAR = 10n ** 24n;
const PAYER_FUND = 50n * 10n ** 21n;   // 0.05 NEAR sent to a new demo payer
const PAYER_WRAP = 20n * 10n ** 21n;   // 0.02 NEAR wrapped into wNEAR (= 20 checks at 0.001)
const EXPLORER = "https://testnet.nearblocks.io/txns/";

const provider = new JsonRpcProvider({ url: RPC_URL });
const fmt = (y: bigint) => `${(Number(y / 10n ** 18n) / 1e6).toFixed(6)}`;

async function view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({ contractId, method, args })) as T;
}
async function nearBalance(accountId: string): Promise<bigint | null> {
  try {
    const r: any = await provider.query({ request_type: "view_account", finality: "final", account_id: accountId } as any);
    return BigInt(r.amount);
  } catch {
    return null;
  }
}
const registered = async (id: string) => (await view<unknown>(ASSET, "storage_balance_of", { account_id: id })) !== null;
const wBalance = async (id: string) => BigInt(await view<string>(ASSET, "ft_balance_of", { account_id: id }));

async function send(signer: Account, receiverId: string, acts: any[], label: string): Promise<void> {
  const res: any = await signer.signAndSendTransaction({ receiverId, actions: acts, waitUntil: "FINAL" });
  const failure = txFailure(res);
  if (failure) throw new Error(`${label}: ${failure}`);
  console.log(`  done  ${label}\n        ${EXPLORER}${txHashOf(res)}`);
}

async function ensureRegistered(signer: Account, accountId: string, who: string) {
  if (await registered(accountId)) {
    console.log(`  ok    ${who} ${accountId} already registered with ${ASSET}`);
    return;
  }
  const bounds = await view<{ min: string }>(ASSET, "storage_balance_bounds", {});
  await send(signer, ASSET, [
    actions.functionCall("storage_deposit", { account_id: accountId, registration_only: true }, teraToGas(30), BigInt(bounds.min)),
  ], `register ${who} ${accountId} with ${ASSET} (${fmt(BigInt(bounds.min))} NEAR storage)`);
}

async function main() {
  const newPayer = process.argv.includes("--new-payer");
  if (!RELAYER_ID || !RELAYER_KEY) {
    throw new Error("set X402_RELAYER_ACCOUNT_ID/X402_RELAYER_PRIVATE_KEY or GOVERNOR_ACCOUNT_ID/GOVERNOR_PRIVATE_KEY in .env");
  }
  if (!RPC_URL.includes("testnet")) throw new Error("x402:setup is testnet-only (NEAR_RPC_URL must be a testnet RPC)");
  const relayer = new Account(RELAYER_ID, provider, KeyPairSigner.fromSecretKey(RELAYER_KEY as any));

  console.log(`\nx402 testnet setup  (token ${ASSET}, payTo ${PAY_TO}, relayer ${RELAYER_ID})\n`);
  const relayerNear = await nearBalance(RELAYER_ID);
  if (relayerNear === null) throw new Error(`relayer ${RELAYER_ID} does not exist on testnet`);
  console.log(`  relayer NEAR balance: ${fmt(relayerNear)}`);
  if (relayerNear < NEAR / 10n) console.log("  WARNING: relayer has < 0.1 NEAR; it pays gas for every settlement");

  // 1. payTo must be registered with the token or ft_transfer to it fails.
  await ensureRegistered(relayer, PAY_TO, "payTo");

  // 2. Optional demo payer: implicit account, funded, registered, wrapped.
  if (newPayer) {
    const kp = generateNearKeyPair();
    const payerId = implicitAccountId(kp.publicKey);
    console.log(`\n  new demo payer ${payerId}`);
    await send(relayer, payerId, [actions.transfer(PAYER_FUND)], `fund payer with ${fmt(PAYER_FUND)} NEAR`);
    const payer = new Account(payerId, provider, KeyPairSigner.fromSecretKey(kp.secretKey as any));
    await ensureRegistered(payer, payerId, "payer");
    await send(payer, ASSET, [actions.functionCall("near_deposit", {}, teraToGas(30), PAYER_WRAP)], `wrap ${fmt(PAYER_WRAP)} NEAR -> wNEAR`);
    console.log("\n  Add to .env (testnet demo payer; it can only spend its own tiny wNEAR balance):");
    console.log(`    X402_PAYER_ACCOUNT_ID=${payerId}`);
    console.log(`    X402_PAYER_PRIVATE_KEY=${kp.secretKey}`);
  }

  // 3. Summary.
  console.log("\n  balances");
  console.log(`    payTo  ${PAY_TO}: ${fmt(await wBalance(PAY_TO))} wNEAR`);
  const payerId = process.env.X402_PAYER_ACCOUNT_ID;
  if (payerId && !newPayer) {
    console.log(`    payer  ${payerId}: ${(await registered(payerId)) ? fmt(await wBalance(payerId)) + " wNEAR" : "NOT registered with " + ASSET}`);
  }
  console.log("\nReady. Start the real rail with:  set X402_RAIL=near-testnet  then  npm run server\n");
}

main().catch((err) => {
  console.error(`\nx402:setup failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
