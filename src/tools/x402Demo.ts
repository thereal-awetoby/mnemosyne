/**
 * Plays an EXTERNAL agent paying Mnemosyne for a memory check via x402.
 *
 *   npm run server          (terminal 1)
 *   npm run x402:demo       (terminal 2)
 *   npm run x402:demo -- "your own situation text"
 *
 * The agent has no account with Mnemosyne and no API key. It pays from a NEAR
 * implicit account (id = hex of its public key). Set EXTERNAL_AGENT_SECRET_KEY
 * in .env to reuse one identity; otherwise a fresh one is made each run.
 */

import "dotenv/config";
import { b64json, canonicalJson, fromB64json, generateNearKeyPair, implicitAccountId, publicKeyOfSecret, sha256Hex } from "../x402/crypto.js";
import { postWithPayment, type Payer } from "../x402/client.js";
import type { PaymentRequired } from "../x402/types.js";

const BASE = (process.env.MNEMOSYNE_URL ?? "http://localhost:8402").replace(/\/$/, "");
const QUERY =
  process.argv.slice(2).join(" ") ||
  "I am about to delete the old full access key on my agent account before the replacement key is tested";
const MAX_PRICE = 10n ** 22n; // agent's own spending limit: 0.01 NEAR per call

function payer(): Payer {
  const sk = process.env.EXTERNAL_AGENT_SECRET_KEY || generateNearKeyPair().secretKey;
  return { secretKey: sk, accountId: implicitAccountId(publicKeyOfSecret(sk)) };
}

const line = (s = "") => console.log(s);
const near = (yocto: string) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toFixed(6)} NEAR`;

async function main() {
  const agent = payer();
  line(`\nExternal agent ${agent.accountId.slice(0, 12)}... (NEAR implicit account) -> ${BASE}`);
  line(`Situation: "${QUERY}"\n`);

  // 1. Ask without paying.
  line("[1] POST /memory/check with no payment");
  const r1 = await fetch(`${BASE}/memory/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY }),
  });
  const quote = fromB64json<PaymentRequired>(r1.headers.get("payment-required") ?? b64json(await r1.json()));
  const req = quote.accepts[0];
  line(`    -> HTTP ${r1.status} Payment Required`);
  line(`       price ${near(req.amount)} to ${req.payTo} on ${req.network} (${req.extra.mock ? "MOCK settlement" : "real settlement"})`);

  // 2. Pay and retry.
  line("\n[2] Sign the quoted price with the agent's key, retry with PAYMENT-SIGNATURE");
  const paid = await postWithPayment<any>(`${BASE}/memory/check`, { query: QUERY }, agent, {
    maxAmount: MAX_PRICE,
  });
  if (paid.status !== 200) {
    line(`    -> HTTP ${paid.status}: ${JSON.stringify(paid.body)}`);
    process.exitCode = 1;
    return;
  }
  const { receipt_id, ...answer } = paid.body;
  line(`    -> HTTP 200`);
  line(`       match:      ${answer.match}${answer.match ? `  (citation ${answer.citation_id}, ${answer.category}, score ${answer.score})` : ""}`);
  if (answer.advice) line(`       advice:     ${answer.advice}`);
  line(`       settlement: ${paid.settlement?.transaction}${paid.settlement && (paid.settlement as any).mock ? " (mock)" : ""}`);
  line(`       receipt:    ${receipt_id}`);

  // 3. Check the receipt matches what we were told.
  line(`\n[3] GET /memory/receipt/${receipt_id}`);
  const receipt: any = await (await fetch(`${BASE}/memory/receipt/${receipt_id}`)).json();
  const answerOk = receipt.answer_sha256 === sha256Hex(canonicalJson(answer));
  const queryOk = receipt.request_sha256 === sha256Hex(canonicalJson({ query: QUERY }));
  line(`    -> paid ${near(receipt.amount)} by ${String(receipt.payer).slice(0, 12)}..., citation ${receipt.citation_id}`);
  line(`       answer hash matches what we received: ${answerOk ? "YES" : "NO"}`);
  line(`       query hash matches what we sent:      ${queryOk ? "YES" : "NO"}  (the query text itself is not stored)`);

  // 4. Try to reuse the same payment.
  line("\n[4] Replay the exact same PAYMENT-SIGNATURE");
  const replay = await fetch(`${BASE}/memory/check`, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": paid.paymentHeader },
    body: JSON.stringify({ query: QUERY }),
  });
  const replayBody: any = await replay.json();
  line(`    -> HTTP ${replay.status}: ${replayBody.error}`);

  const ok = answerOk && queryOk && replay.status === 402;
  line(`\n${ok ? "DEMO OK" : "DEMO FAILED"} -- 402 -> pay -> answer -> receipt verified -> replay rejected\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`\ndemo failed: ${(err as Error).message}`);
  console.error(`Is the server running? Start it with: npm run server\n`);
  process.exitCode = 1;
});
