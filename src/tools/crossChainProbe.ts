/**
 * Why did 1Click answer 400? Sends a few dry price requests that each change one
 * thing, checks 1Click's token list for our asset ids, and says in plain words
 * what to set. PRICES ONLY: nothing is sent, signed or deposited, and no private
 * key leaves this machine (the key is only used to work out your own account
 * name; only that name is shown).
 *
 *   set CROSS_CHAIN_RECIPIENT=0x1234567890abcdef1234567890abcdef12345678
 *   npm run crosschain:probe
 *
 * Diagnostic only: it is not an allocation, never reads a memory record and the
 * cycle never calls it. See docs/CROSS_CHAIN.md.
 */

import "dotenv/config";
import { refundAccount } from "../allocate/cross_chain.js";
import { PROBE_BURN_RECIPIENT, runProbe, type ProbeInput } from "../allocate/crossChainProbe.js";
import { implicitAccountId } from "../nearTx.js";
import { capitalUnitYocto, fmtWnear, unitsToYocto } from "../swarmState.js";

const fmtNear = (yocto: string) => `${fmtWnear(BigInt(yocto))} wNEAR`;

async function main() {
  const sender = refundAccount(process.env);
  if (!sender) throw new Error("set GOVERNOR_ACCOUNT_ID in .env (or CROSS_CHAIN_SENDER)");
  const recipient = (process.env.CROSS_CHAIN_RECIPIENT ?? "").trim() || PROBE_BURN_RECIPIENT;
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error(`CROSS_CHAIN_RECIPIENT must be "0x" followed by 40 hex characters (0-9, a-f), for example 0x1234567890abcdef1234567890abcdef12345678. You gave: ${recipient}`);

  let implicit: string | null = null;
  try {
    const key = (process.env.GOVERNOR_PRIVATE_KEY ?? "").trim();
    if (key) implicit = implicitAccountId(key);
  } catch { /* no usable key: the variants that need it are skipped */ }

  const units = Number(process.env.CROSS_CHAIN_UNITS ?? "100");
  const amount = unitsToYocto(Number.isInteger(units) && units > 0 ? units : 100, capitalUnitYocto()).toString();
  const input: ProbeInput = { recipient, sender, implicit, amount, slippageBps: Number(process.env.CROSS_CHAIN_SLIPPAGE_BPS ?? "50") || 50, now: Date.now() };

  console.log(`\n1Click probe  (prices only: nothing is sent, signed or deposited)`);
  console.log(`  recipient   ${recipient}${process.env.CROSS_CHAIN_RECIPIENT ? "" : "   (not set: using the burn address; a price check cannot send to it)"}`);
  console.log(`  refund now  ${sender}`);
  console.log(`  mainnet-style refund account from your governor key: ${implicit ?? "(no GOVERNOR_PRIVATE_KEY, so those variants are skipped)"}\n`);

  const out = await runProbe(input);

  console.log("token list");
  if (!out.tokens.reachable) console.log(`  could not read it: ${out.tokens.error}`);
  else {
    console.log(`  ${out.tokens.count} tokens listed`);
    console.log(`  wNEAR on NEAR (our origin)        ${out.tokens.wrapNear ? "listed" : "NOT LISTED"}`);
    console.log(`  our Base USDC id (our destination) ${out.tokens.ourDest ? "listed" : "NOT LISTED"}`);
    if (out.tokens.baseUsdc.length) console.log(`  1Click lists USDC on Base as       ${out.tokens.baseUsdc.join(", ")}`);
  }

  console.log("\nprice requests");
  for (const r of out.results) {
    const refund = r.refund.length > 24 ? r.refund.slice(0, 10) + "..." + r.refund.slice(-6) : r.refund;
    console.log(`  ${r.key}  ${r.label}`);
    console.log(`     ${fmtNear(r.amount)}, refund ${refund}  ->  ${r.ok ? "OK" : "FAILED"}${r.status ? " " + r.status : ""}: ${r.message}`);
  }

  console.log("\nwhat this means");
  for (const l of out.diagnosis.lines) console.log(`  ${l}`);
  const env = Object.entries(out.diagnosis.env);
  if (env.length) {
    console.log("\nin the cmd window where you run the check, type:");
    for (const [k, v] of env) console.log(`  set ${k}=${v}`);
    console.log("  npm run crosschain:check");
  }
  console.log("");
  if (!out.results.some((r) => r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\ncrosschain:probe failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
