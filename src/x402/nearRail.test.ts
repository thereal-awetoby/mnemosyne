/**
 * Real-rail tests (X402_RAIL=near-testnet) without touching the network.
 *
 * What is real here: the official @x402/near facilitator verification and
 * settlement code, the standard x402 client that builds payments, and real
 * ed25519-signed NEP-366 delegate actions. What is simulated: the chain
 * (balances, access keys, nonces, block height) behind the facilitator's
 * FacilitatorNearSigner interface. The live testnet run is
 * `npm run x402:demo:real`.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { KeyPairSigner } from "@near-js/signers";
import { actionCreators, buildDelegateAction, encodeSignedDelegate } from "@near-js/transactions";
import {
  decodeSignedDelegateB64, parseFtTransferArgs, toBase64,
  type ClientNearSigner, type FacilitatorNearSigner,
} from "@x402/near";
import { createNearX402Client } from "@fastnear/x402";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { createMnemosyneServer } from "./server.js";
import { createNearExactRail } from "./rails.js";
import { generateNearKeyPair, implicitAccountId, b64json } from "./crypto.js";
import { base58Encode } from "../nearTx.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SEED = join(ROOT, "data/seed-memory.json");
const TOKEN = "wrap.testnet";
const PAY_TO = "mnemosyne-gov.testnet";
const RELAYER = "relayer.testnet";
const PRICE = 10n ** 21n; // 0.001 wNEAR
const QUERY = "about to delete the full access key on the account before the replacement key works";

// ------------------------------------------------------------ simulated chain

class FakeChain implements FacilitatorNearSigner {
  height = 1_000_000n;
  balances = new Map<string, bigint>([[PAY_TO, 0n]]);
  registered = new Set<string>([PAY_TO]);
  keys = new Map<string, { nonce: bigint; kind: "FullAccess" | "FunctionCall" }>(); // `${account}|${pk}`
  failNextSettlement = false;
  submitted = 0;

  getRelayerIds() { return [RELAYER]; }
  async getCurrentBlockHeight() { return this.height; }
  async viewAccount({ accountId }: { accountId: string }) {
    if (accountId === TOKEN) return { codeHash: "Ec1oJs7ybGGbqzTnmnYD9BQxXmh7jRLXm3H44h1A9JgE" };
    const exists = [...this.keys.keys()].some((k) => k.startsWith(accountId + "|")) || this.balances.has(accountId);
    return exists ? { codeHash: "11111111111111111111111111111111" } : null;
  }
  async viewAccessKey({ accountId, publicKey }: { accountId: string; publicKey: string }) {
    const k = this.keys.get(`${accountId}|${publicKey}`);
    return k ? { nonce: k.nonce, permissionKind: k.kind } : null;
  }
  async ftBalanceOf({ accountId }: { accountId: string }) { return this.balances.get(accountId) ?? 0n; }
  async storageBalanceOf({ accountId }: { accountId: string }) {
    return { supported: true as const, registered: this.registered.has(accountId) };
  }
  async submitSignedDelegateAction({ signedDelegateAction }: { signedDelegateAction: string }) {
    this.submitted++;
    const d = decodeSignedDelegateB64(signedDelegateAction);
    const tx = base58Encode(randomBytes(32));
    if (!d.verifySignature()) return { transaction: tx, innerReceipt: { kind: "failure" as const, error: "InvalidSignature" } };
    const key = this.keys.get(`${d.delegate.senderId}|${d.delegate.publicKey}`);
    if (!key || d.delegate.nonce <= key.nonce) return { transaction: tx, innerReceipt: { kind: "failure" as const, error: "DelegateActionInvalidNonce" } };
    key.nonce = d.delegate.nonce; // the chain consumes the nonce
    if (this.failNextSettlement) {
      this.failNextSettlement = false;
      return { transaction: tx, innerReceipt: { kind: "failure" as const, error: "Smart contract panicked: simulated" } };
    }
    const args = parseFtTransferArgs(d.delegate.functionCall!.args);
    const from = d.delegate.senderId;
    const amount = BigInt(args.amount);
    const bal = this.balances.get(from) ?? 0n;
    if (bal < amount) return { transaction: tx, innerReceipt: { kind: "failure" as const, error: "not enough balance" } };
    this.balances.set(from, bal - amount);
    this.balances.set(args.receiver_id, (this.balances.get(args.receiver_id) ?? 0n) + amount);
    this.height += 1n;
    return { transaction: tx, innerReceipt: { kind: "success" as const, value: "" } };
  }

  addPayer(opts: { balance?: bigint; kind?: "FullAccess" | "FunctionCall"; register?: boolean } = {}) {
    const kp = generateNearKeyPair();
    const accountId = implicitAccountId(kp.publicKey);
    this.keys.set(`${accountId}|${kp.publicKey}`, { nonce: 5n, kind: opts.kind ?? "FullAccess" });
    this.balances.set(accountId, opts.balance ?? 10n * PRICE);
    if (opts.register !== false) this.registered.add(accountId);
    return { accountId, secretKey: kp.secretKey, publicKey: kp.publicKey };
  }
}

/** Same construction as @x402/near's createClientNearSigner, minus the RPC:
 *  nonce and block height come from the simulated chain. Lets tests tamper. */
function offlineSigner(chain: FakeChain, payer: { accountId: string; secretKey: string; publicKey: string },
  tamper: { amount?: string; payTo?: string; token?: string; deposit?: bigint; extraAction?: boolean } = {}): ClientNearSigner {
  const signer = KeyPairSigner.fromSecretKey(payer.secretKey as any);
  return {
    async createSignedDelegateAction({ paymentRequirements: req }) {
      const publicKey = await signer.getPublicKey();
      const nonce = chain.keys.get(`${payer.accountId}|${payer.publicKey}`)!.nonce + 1n;
      const transfer = actionCreators.functionCall("ft_transfer",
        { receiver_id: tamper.payTo ?? req.payTo, amount: tamper.amount ?? req.amount }, 30_000_000_000_000n, tamper.deposit ?? 1n);
      const delegateAction = buildDelegateAction({
        actions: tamper.extraAction ? [transfer, transfer] : [transfer],
        maxBlockHeight: chain.height + 300n, nonce, publicKey,
        receiverId: tamper.token ?? req.asset, senderId: payer.accountId,
      });
      const [, signed] = await signer.signDelegateAction(delegateAction);
      return toBase64(encodeSignedDelegate(signed));
    },
  };
}

// -------------------------------------------------------------------- fixture

let chain: FakeChain;
let base = "";
let close = () => {};
let dataDir = "";

before(async () => {
  chain = new FakeChain();
  dataDir = mkdtempSync(join(tmpdir(), "mnemo-nearrail-"));
  const rail = await createNearExactRail({
    network: "near:testnet", asset: TOKEN, amount: PRICE.toString(), payTo: PAY_TO, maxTimeoutSeconds: 300,
    relayer: { accountId: RELAYER, secretKey: "" }, rpcUrl: "http://unused.invalid", facilitatorSigner: chain,
  });
  const created = createMnemosyneServer({
    dataDir, seedPath: SEED, publicUrl: "http://mnemosyne.test",
    payTo: PAY_TO, network: "near:testnet", asset: TOKEN, priceAmount: PRICE.toString(), maxTimeoutSeconds: 300,
    mockSettlement: false, rail,
  });
  await new Promise<void>((r) => created.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  close = () => { created.server.closeAllConnections(); created.server.close(); };
});
after(() => { close(); rmSync(dataDir, { recursive: true, force: true }); });

async function check(headers: Record<string, string> = {}, query = QUERY) {
  const r = await fetch(base + "/memory/check", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ query }) });
  return { status: r.status, headers: r.headers, body: (await r.json()) as any };
}
async function quote() {
  const r = await check();
  assert.equal(r.status, 402);
  return decodePaymentRequiredHeader(r.headers.get("payment-required")!);
}
/** Build a payment exactly like a real agent: the standard x402 NEAR client. */
async function pay(signer: ClientNearSigner, mutate?: (p: any) => void) {
  const client = createNearX402Client({ signer, network: "near:testnet" });
  const payload: any = await client.createPaymentPayload(await quote());
  mutate?.(payload);
  return encodePaymentSignatureHeader(payload);
}

// ---------------------------------------------------------------------- tests

test("402 quote uses the official NEAR exact terms: wNEAR, payTo, near:testnet", async () => {
  const q = await quote();
  assert.equal(q.x402Version, 2);
  assert.equal(q.resource.url, "http://mnemosyne.test/memory/check");
  const req = q.accepts[0];
  assert.equal(req.scheme, "exact");
  assert.equal(req.network, "near:testnet");
  assert.equal(req.asset, TOKEN);
  assert.equal(req.amount, PRICE.toString());
  assert.equal(req.payTo, PAY_TO);
  const h: any = await (await fetch(base + "/health")).json();
  assert.equal(h.payment_rail, "near-exact");
  assert.equal(h.mock_settlement, false);
});

test("real payment: verified, transferred on chain, answered, receipted", async () => {
  const payer = chain.addPayer();
  const before = { payer: chain.balances.get(payer.accountId)!, payTo: chain.balances.get(PAY_TO)! };
  const r = await check({ "PAYMENT-SIGNATURE": await pay(offlineSigner(chain, payer)) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.match, true);
  assert.equal(r.body.citation_id, "M-001");
  const settle = decodePaymentResponseHeader(r.headers.get("payment-response")!);
  assert.equal(settle.success, true);
  assert.match(settle.transaction, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(settle.payer, payer.accountId);
  assert.equal(chain.balances.get(payer.accountId), before.payer - PRICE, "payer charged exactly once");
  assert.equal(chain.balances.get(PAY_TO), before.payTo + PRICE, "payTo received the price");

  const rec: any = await (await fetch(`${base}/memory/receipt/${r.body.receipt_id}`)).json();
  assert.equal(rec.mock, false);
  assert.equal(rec.settlement, settle.transaction);
  assert.equal(rec.explorer, `https://testnet.nearblocks.io/txns/${settle.transaction}`);
  assert.equal(rec.asset, TOKEN);
  assert.equal(rec.payer, payer.accountId);
});

test("replaying a settled payment is refused and charges nothing", async () => {
  const payer = chain.addPayer();
  const header = await pay(offlineSigner(chain, payer));
  assert.equal((await check({ "PAYMENT-SIGNATURE": header })).status, 200);
  const bal = chain.balances.get(payer.accountId);
  const again = await check({ "PAYMENT-SIGNATURE": header });
  assert.equal(again.status, 402);
  assert.match(again.body.error, /nonce/);
  assert.equal(again.body.match, undefined);
  assert.equal(chain.balances.get(payer.accountId), bal);
});

test("8 concurrent uses of one signed payment settle exactly once", async () => {
  const payer = chain.addPayer();
  const header = await pay(offlineSigner(chain, payer));
  const bal = chain.balances.get(payer.accountId)!;
  const rs = await Promise.all(Array.from({ length: 8 }, () => check({ "PAYMENT-SIGNATURE": header })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(chain.balances.get(payer.accountId), bal - PRICE);
});

test("the official verifier refuses every bad payment, before any transfer", async () => {
  const cases: Array<[string, () => Promise<string>, RegExp]> = [
    ["underpay", async () => pay(offlineSigner(chain, chain.addPayer(), { amount: "1" })), /amount_mismatch/],
    ["wrong recipient", async () => pay(offlineSigner(chain, chain.addPayer(), { payTo: "attacker.testnet" })), /recipient_mismatch/],
    ["wrong token", async () => pay(offlineSigner(chain, chain.addPayer(), { token: "fake-usdc.testnet" })), /token_contract_mismatch/],
    ["no 1-yocto deposit", async () => pay(offlineSigner(chain, chain.addPayer(), { deposit: 0n })), /attached_deposit/],
    ["two actions", async () => pay(offlineSigner(chain, chain.addPayer(), { extraAction: true })), /action_count/],
    ["broke payer", async () => pay(offlineSigner(chain, chain.addPayer({ balance: PRICE - 1n }))), /insufficient_funds/],
    ["function-call key", async () => pay(offlineSigner(chain, chain.addPayer({ kind: "FunctionCall" }))), /function_call_key_not_allowed/],
    ["tampered signature", async () => {
      const h = await pay(offlineSigner(chain, chain.addPayer()));
      const p = JSON.parse(Buffer.from(h, "base64").toString());
      const raw = Buffer.from(p.payload.signedDelegateAction, "base64");
      raw[raw.length - 5] ^= 0xff; // flip a signature byte
      p.payload.signedDelegateAction = raw.toString("base64");
      return Buffer.from(JSON.stringify(p)).toString("base64");
    }, /signature/],
  ];
  for (const [name, make, reason] of cases) {
    const submittedBefore = chain.submitted;
    const r = await check({ "PAYMENT-SIGNATURE": await make() });
    assert.equal(r.status, 402, name);
    assert.match(r.body.error, reason, `${name}: got ${r.body.error}`);
    assert.equal(r.body.match, undefined, `${name}: no answer leaked`);
    assert.equal(chain.submitted, submittedBefore, `${name}: nothing submitted on chain`);
  }
});

test("payTo not registered with the token -> refused", async () => {
  chain.registered.delete(PAY_TO);
  try {
    const r = await check({ "PAYMENT-SIGNATURE": await pay(offlineSigner(chain, chain.addPayer())) });
    assert.equal(r.status, 402);
    assert.match(r.body.error, /not_registered_for_storage/);
  } finally {
    chain.registered.add(PAY_TO);
  }
});

test("on-chain failure after verify: no answer, no receipt, no charge", async () => {
  const payer = chain.addPayer();
  const header = await pay(offlineSigner(chain, payer));
  const bal = chain.balances.get(payer.accountId);
  const auditBefore: any = await (await fetch(base + "/audit")).json();
  chain.failNextSettlement = true;
  const r = await check({ "PAYMENT-SIGNATURE": header });
  assert.equal(r.status, 402);
  assert.equal(r.body.match, undefined);
  assert.equal(chain.balances.get(payer.accountId), bal);
  const auditAfter: any = await (await fetch(base + "/audit")).json();
  assert.equal(auditAfter.paid_checks_total, auditBefore.paid_checks_total);
});

test("payment quoted for another resource, or the mock scheme, is refused", async () => {
  const other = await pay(offlineSigner(chain, chain.addPayer()), (p) => { p.resource = { ...p.resource, url: "http://evil.test/memory/check" }; });
  const r1 = await check({ "PAYMENT-SIGNATURE": other });
  assert.equal(r1.status, 402);
  assert.equal(r1.body.error, "payment not bound to this resource");

  const mockStyle = b64json({ x402Version: 2, accepted: { scheme: "exact" }, payload: { authorization: {}, publicKey: "x", signature: "y" } });
  const r2 = await check({ "PAYMENT-SIGNATURE": mockStyle });
  assert.equal(r2.status, 402);
});

test("audit and receipts show real tx links and never the query", async () => {
  const b: any = await (await fetch(base + "/audit")).json();
  assert.equal(b.payment_rail, "near-exact");
  assert.equal(b.mock_settlement, false);
  assert.ok(b.paid_checks_total >= 3);
  for (const r of b.recent) assert.match(r.explorer, /^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.ok(!JSON.stringify(b).includes("delete the full access"));
});
