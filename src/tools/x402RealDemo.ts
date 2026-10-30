/**
 * An EXTERNAL agent pays Mnemosyne with a REAL testnet wNEAR payment, using
 * the standard x402 NEAR client (@fastnear/x402 -> @x402/near), not our code.
 *
 *   terminal 1:  set X402_RAIL=near-testnet  &&  npm run server
 *   terminal 2:  npm run x402:demo:real
 *
 * Needs X402_PAYER_ACCOUNT_ID / X402_PAYER_PRIVATE_KEY (from
 * `npm run x402:setup -- --new-payer`). The payer needs wNEAR but no NEAR:
 * the server's relayer pays gas.
 */

import "dotenv/config";
import { createNearX402Client } from "@fastnear/x402";
import { createLocalNearSigner } from "@fastnear/x402/node";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { JsonRpcProvider } from "near-api-js";
import { canonicalJson, sha256Hex } from "../x402/crypto.js";

const BASE = (process.env.MNEMOSYNE_URL ?? "http://localhost:8402").replace(/\/$/, "");
const RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const PAYER_ID = process.env.X402_PAYER_ACCOUNT_ID ?? "";
const PAYER_KEY = process.env.X402_PAYER_PRIVATE_KEY ?? "";
const EXPECT_ASSET = process.env.X402_ASSET || "wrap.testnet";
const EXPECT_PAY_TO = process.env.MNEMOSYNE_PAY_TO || process.env.GOVERNOR_ACCOUNT_ID || "mnemosyne-gov.testnet";
const MAX_PRICE = 10n ** 22n; // agent's own spending cap per call: 0.01 wNEAR
const QUERY =
  process.argv.slice(2).join(" ") ||
  "I am about to delete the old full access key on my agent account before the replacement key is tested";

const line = (s = "") => console.log(s);
const w = (units: string | bigint) => `${(Number(BigInt(units) / 10n ** 18n) / 1e6).toFixed(6)} wNEAR`;
const provider = new JsonRpcProvider({ url: RPC_URL });
const wBalance = async (id: string) => BigInt((await provider.callFunction({ contractId: EXPECT_ASSET, method: "ft_balance_of", args: { account_id: id } })) as string);
const post = (headers: Record<string, string> = {}) =>
  fetch(`${BASE}/memory/check`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ query: QUERY }), redirect: "error" });

async function main() {
  if (!PAYER_ID || !PAYER_KEY) throw new Error("set X402_PAYER_ACCOUNT_ID and X402_PAYER_PRIVATE_KEY (npm run x402:setup -- --new-payer)");
  line(`\nExternal agent ${PAYER_ID.slice(0, 12)}... pays ${BASE} with real testnet ${EXPECT_ASSET}`);
  line(`Situation: "${QUERY}"\n`);

  // 1. Ask without paying.
  line("[1] POST /memory/check with no payment");
  const r1 = await post();
  const header = r1.headers.get("payment-required");
  if (r1.status !== 402 || !header) throw new Error(`expected 402 + PAYMENT-REQUIRED, got ${r1.status}`);
  const quote = decodePaymentRequiredHeader(header);
  const req = quote.accepts[0];
  line(`    -> HTTP 402: ${w(req.amount)} (${req.asset}) to ${req.payTo} on ${req.network}`);

  // The agent's own guardrails: refuse anything it didn't expect.
  if (req.scheme !== "exact" || req.network !== "near:testnet") throw new Error(`refusing ${req.scheme} on ${req.network}`);
  if (req.asset !== EXPECT_ASSET) throw new Error(`refusing unexpected asset ${req.asset}`);
  if (req.payTo !== EXPECT_PAY_TO) throw new Error(`refusing unexpected recipient ${req.payTo}`);
  if (BigInt(req.amount) > MAX_PRICE) throw new Error(`price ${req.amount} above cap ${MAX_PRICE}`);
  if (quote.resource?.url !== `${BASE}/memory/check`) throw new Error(`quote is for ${quote.resource?.url}, not the URL we called`);

  // 2. Sign with the standard NEAR x402 client and retry.
  line("\n[2] Sign a NEP-366 delegate action (ft_transfer) with the standard x402 NEAR client, retry");
  const before = { payTo: await wBalance(req.payTo), payer: await wBalance(PAYER_ID) };
  const client = createNearX402Client({
    signer: createLocalNearSigner({ accountId: PAYER_ID, secretKey: PAYER_KEY as any, rpcUrls: { "near:testnet": RPC_URL } }),
    network: "near:testnet",
  });
  const payment = await client.createPaymentPayload(quote);
  const paymentHeader = encodePaymentSignatureHeader(payment);
  const r2 = await post({ "PAYMENT-SIGNATURE": paymentHeader });
  const body: any = await r2.json();
  if (r2.status !== 200) throw new Error(`paid request failed: HTTP ${r2.status} ${JSON.stringify(body)}`);
  const settle = decodePaymentResponseHeader(r2.headers.get("payment-response") ?? "");
  const { receipt_id, ...answer } = body;
  line(`    -> HTTP 200`);
  line(`       match:      ${answer.match}${answer.match ? `  (citation ${answer.citation_id}, ${answer.category}, score ${answer.score})` : ""}`);
  if (answer.advice) line(`       advice:     ${answer.advice}`);
  line(`       settlement: ${settle.transaction}`);
  line(`       explorer:   https://testnet.nearblocks.io/txns/${settle.transaction}`);
  line(`       receipt:    ${receipt_id}`);

  // 3. Check the money really moved on-chain.
  line("\n[3] Check balances on NEAR testnet");
  const after = { payTo: await wBalance(req.payTo), payer: await wBalance(PAYER_ID) };
  const received = after.payTo - before.payTo;
  const spent = before.payer - after.payer;
  line(`    -> payTo  +${w(received)}   payer  -${w(spent)}`);
  const moneyOk = spent === BigInt(req.amount) && received >= BigInt(req.amount);

  // 4. Receipt matches what we were told.
  line(`\n[4] GET /memory/receipt/${receipt_id}`);
  const receipt: any = await (await fetch(`${BASE}/memory/receipt/${receipt_id}`)).json();
  const receiptOk =
    receipt.settlement === settle.transaction && receipt.mock === false &&
    receipt.answer_sha256 === sha256Hex(canonicalJson(answer)) &&
    receipt.request_sha256 === sha256Hex(canonicalJson({ query: QUERY }));
  line(`    -> real settlement ${receipt.settlement}, mock=${receipt.mock}, hashes match: ${receiptOk ? "YES" : "NO"}`);

  // 5. The same signed payment can't be used twice.
  line("\n[5] Replay the exact same PAYMENT-SIGNATURE");
  const r3 = await post({ "PAYMENT-SIGNATURE": paymentHeader });
  const replayBody: any = await r3.json();
  line(`    -> HTTP ${r3.status}: ${replayBody.error ?? JSON.stringify(replayBody).slice(0, 120)}`);
  const replayOk = r3.status === 402 && (await wBalance(PAYER_ID)) === after.payer;
  line(`       payer charged again: ${replayOk ? "NO" : "YES (problem!)"}`);

  const ok = moneyOk && receiptOk && replayOk;
  line(`\n${ok ? "REAL DEMO OK" : "REAL DEMO FAILED"} -- 402 -> signed delegate -> on-chain wNEAR transfer -> answer -> receipt -> replay rejected\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`\nreal demo failed: ${(err as Error).message}`);
  console.error("Is the server running with X402_RAIL=near-testnet?\n");
  process.exitCode = 1;
});
