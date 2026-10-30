/**
 * x402 memory API tests:  npm test
 * Runs a real HTTP server on a random port with a temp data dir. No network,
 * no NEAR, no near-api-js needed.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createMnemosyneServer } from "./server.js";
import { MockFacilitator, authorizationMessage } from "./facilitator.js";
import { buildPayment, postWithPayment, type Payer } from "./client.js";
import { b64json, canonicalJson, fromB64json, generateNearKeyPair, implicitAccountId, sha256Hex, signMessage } from "./crypto.js";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "./types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SEED = join(ROOT, "data/seed-memory.json");
const ADMIN = "test-admin-token";
const MATCHING = "about to delete the full access key on the account before the replacement key works";

let base = "";
let dataDir = "";
let close: () => void = () => {};
let requirements: PaymentRequirements;
let checkUrl = "";

function newPayer(): Payer {
  const kp = generateNearKeyPair();
  return { secretKey: kp.secretKey, accountId: implicitAccountId(kp.publicKey) };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}

const payHeader = (p: PaymentPayload) => ({ "PAYMENT-SIGNATURE": b64json(p) });

/** Re-sign after tampering with the authorization (so only the tampered
 *  field is wrong, not the signature). */
function resign(p: PaymentPayload, secretKey: string): PaymentPayload {
  return { ...p, payload: { ...p.payload, signature: signMessage(secretKey, authorizationMessage(p.payload.authorization)) } };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mnemo-x402-"));
  const created = createMnemosyneServer({
    dataDir,
    seedPath: SEED,
    publicUrl: "http://mnemosyne.test",
    payTo: "mnemosyne-gov.testnet",
    network: "near:testnet",
    asset: "NEAR",
    priceAmount: "1000000000000000000000",
    maxTimeoutSeconds: 300,
    facilitator: new MockFacilitator(dataDir),
    mockSettlement: true,
    adminToken: ADMIN,
    runCycle: async () => ({ committed: true, decision_hash: "sha256:x" }),
  });
  requirements = created.requirements;
  checkUrl = "http://mnemosyne.test/memory/check";
  await new Promise<void>((r) => created.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  close = () => created.server.close();
});

after(() => {
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("health is free", async () => {
  const r = await fetch(base + "/health");
  assert.equal(r.status, 200);
  const b: any = await r.json();
  assert.equal(b.ok, true);
  assert.equal(b.memory_entries, 6);
  assert.equal(b.mock_settlement, true);
});

test("no payment -> 402 with x402 v2 PAYMENT-REQUIRED header matching body", async () => {
  const r = await post("/memory/check", { query: MATCHING });
  assert.equal(r.status, 402);
  const header = r.headers.get("payment-required");
  assert.ok(header, "PAYMENT-REQUIRED header present");
  const q = fromB64json<PaymentRequired>(header!);
  assert.deepEqual(q, r.body);
  assert.equal(q.x402Version, 2);
  assert.equal(q.resource.url, checkUrl);
  assert.equal(q.accepts[0].payTo, "mnemosyne-gov.testnet");
  assert.equal(q.accepts[0].amount, "1000000000000000000000");
  assert.equal(q.accepts[0].extra.mock, true);
  assert.equal(r.body.match, undefined, "no answer leaks without payment");
});

test("bad body is rejected before asking for money", async () => {
  assert.equal((await post("/memory/check", {})).status, 400);
  assert.equal((await post("/memory/check", "not json")).status, 400);
  assert.equal((await post("/memory/check", { query: "x".repeat(2001) })).status, 400);
});

test("valid payment -> answer + settlement + receipt; private detail never leaks", async () => {
  const payer = newPayer();
  const r = await postWithPayment<any>(base + "/memory/check", { query: MATCHING }, payer, { maxAmount: 10n ** 22n });
  assert.equal(r.status, 200);
  assert.equal(r.body.match, true);
  assert.equal(r.body.citation_id, "M-001");
  assert.equal(r.body.category, "key-management");
  assert.match(r.body.receipt_id, /^R-[0-9a-f]{24}$/);
  assert.ok(r.settlement?.success);
  assert.match(r.settlement!.transaction!, /^mock_/);
  assert.equal(r.settlement!.payer, payer.accountId);

  const raw = JSON.stringify(r.body);
  const seed = JSON.parse(readFileSync(SEED, "utf8"));
  for (const e of seed.entries) assert.ok(!raw.includes(e.private_detail), `private_detail of ${e.id} leaked`);
  assert.ok(!("keywords" in r.body) && !("private_detail" in r.body));

  const rec: any = await (await fetch(`${base}/memory/receipt/${r.body.receipt_id}`)).json();
  const { receipt_id, ...answer } = r.body;
  assert.equal(rec.answer_sha256, sha256Hex(canonicalJson(answer)));
  assert.equal(rec.request_sha256, sha256Hex(canonicalJson({ query: MATCHING })));
  assert.equal(rec.payer, payer.accountId);
  assert.equal(rec.mock, true);
  assert.ok(!JSON.stringify(rec).includes("delete the full access"), "receipt must not store the query text");
});

test("non-matching situation -> paid answer with match:false", async () => {
  const r = await postWithPayment<any>(base + "/memory/check", { query: "what is the weather like in lagos today" }, newPayer(), { maxAmount: 10n ** 22n });
  assert.equal(r.status, 200);
  assert.equal(r.body.match, false);
  assert.equal(r.body.citation_id, null);
  assert.equal(r.body.advice, null);
});

test("replaying a settled payment is rejected", async () => {
  const r = await postWithPayment<any>(base + "/memory/check", { query: MATCHING }, newPayer(), { maxAmount: 10n ** 22n });
  assert.equal(r.status, 200);
  const again = await post("/memory/check", { query: MATCHING }, { "PAYMENT-SIGNATURE": r.paymentHeader });
  assert.equal(again.status, 402);
  assert.equal(again.body.error, "nonce_already_used");
});

test("every tampering case is refused with a specific reason", async () => {
  const payer = newPayer();
  const fresh = () => buildPayment(requirements, checkUrl, payer);
  const cases: Array<[string, () => PaymentPayload, string]> = [
    ["underpay", () => { const p = fresh(); p.payload.authorization.value = "1"; return resign(p, payer.secretKey); }, "insufficient_amount"],
    ["wrong recipient", () => { const p = fresh(); p.payload.authorization.to = "attacker.testnet"; return resign(p, payer.secretKey); }, "invalid_recipient"],
    ["wrong network", () => { const p = fresh(); p.payload.authorization.network = "near:mainnet"; return resign(p, payer.secretKey); }, "invalid_network"],
    ["expired", () => { const p = fresh(); p.payload.authorization.validAfter -= 1000; p.payload.authorization.validBefore = Math.floor(Date.now() / 1000) - 10; return resign(p, payer.secretKey); }, "expired"],
    ["window too long", () => { const p = fresh(); p.payload.authorization.validBefore += 100000; return resign(p, payer.secretKey); }, "time_window_too_long"],
    ["bad nonce", () => { const p = fresh(); p.payload.authorization.nonce = "xyz"; return resign(p, payer.secretKey); }, "invalid_nonce"],
    ["tampered after signing", () => { const p = fresh(); p.payload.authorization.value = "999999999999999999999999"; return p; }, "invalid_signature"],
    ["someone else's account", () => { const p = fresh(); p.payload.authorization.from = newPayer().accountId; return resign(p, payer.secretKey); }, "payer_key_mismatch"],
    ["named account w/o check", () => { const p = fresh(); p.payload.authorization.from = "someone.testnet"; return resign(p, payer.secretKey); }, "named_payer_unverifiable"],
    ["changed accepted terms", () => { const p = fresh(); p.accepted = { ...p.accepted, amount: "1" }; return p; }, "requirements_mismatch"],
    ["wrong version", () => { const p = fresh(); (p as any).x402Version = 1; return p; }, "invalid_x402_version"],
  ];
  for (const [name, make, reason] of cases) {
    const r = await post("/memory/check", { query: MATCHING }, payHeader(make()));
    assert.equal(r.status, 402, name);
    assert.equal(r.body.error, reason, name);
    assert.equal(r.body.match, undefined, `${name}: no answer leaked`);
  }
  // payment for a different resource
  const other = buildPayment(requirements, "http://mnemosyne.test/other", payer);
  const r = await post("/memory/check", { query: MATCHING }, payHeader(other));
  assert.equal(r.status, 402);
  assert.equal(r.body.error, "payment not bound to this resource");
  // garbage header
  const g = await post("/memory/check", { query: MATCHING }, { "PAYMENT-SIGNATURE": "%%%not-base64-json" });
  assert.equal(g.status, 402);
});

test("failed payments don't burn the nonce; the same payment then works once", async () => {
  const payer = newPayer();
  const p = buildPayment(requirements, checkUrl, payer);
  // first attempt with a broken signature fails...
  const broken = { ...p, payload: { ...p.payload, signature: signMessage(newPayer().secretKey, Buffer.from("x")) } };
  assert.equal((await post("/memory/check", { query: MATCHING }, payHeader(broken))).status, 402);
  // ...the genuine one with the same nonce still succeeds, exactly once
  assert.equal((await post("/memory/check", { query: MATCHING }, payHeader(p))).status, 200);
  assert.equal((await post("/memory/check", { query: MATCHING }, payHeader(p))).status, 402);
});

test("concurrent use of one payment settles exactly once", async () => {
  const p = buildPayment(requirements, checkUrl, newPayer());
  const results = await Promise.all(Array.from({ length: 8 }, () => post("/memory/check", { query: MATCHING }, payHeader(p))));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 402).length, 7);
});

test("client refuses to overpay or pay an unknown recipient", async () => {
  await assert.rejects(postWithPayment(base + "/memory/check", { query: MATCHING }, newPayer(), { maxAmount: 1n }), /exceeds limit/);
  await assert.rejects(
    postWithPayment(base + "/memory/check", { query: MATCHING }, newPayer(), { maxAmount: 10n ** 22n, allowedPayTo: ["other.testnet"] }),
    /unknown recipient/
  );
});

test("receipts: unknown id 404, malformed id 400", async () => {
  assert.equal((await fetch(`${base}/memory/receipt/R-000000000000000000000000`)).status, 404);
  assert.equal((await fetch(`${base}/memory/receipt/../../etc/passwd`)).status, 404);
  assert.equal((await fetch(`${base}/memory/receipt/nope`)).status, 400);
});

test("audit lists paid checks without query text", async () => {
  const b: any = await (await fetch(base + "/audit")).json();
  assert.ok(b.paid_checks_total >= 3);
  assert.ok(b.recent[0].settlement.startsWith("mock_"));
  assert.ok(!JSON.stringify(b).includes("delete the full access"));
});

test("confess is admin-only, validated, and becomes matchable", async () => {
  const entry = {
    category: "payments",
    keywords: ["refund", "double", "charge", "webhook", "retry"],
    public_summary: "Make payment webhooks idempotent; retries caused double charges.",
    private_detail: "SECRET-DETAIL-xyz",
  };
  assert.equal((await post("/memory/confess", entry)).status, 401);
  assert.equal((await post("/memory/confess", entry, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post("/memory/confess", { ...entry, keywords: ["a"] }, { authorization: `Bearer ${ADMIN}` })).status, 400);
  const ok = await post("/memory/confess", entry, { authorization: `Bearer ${ADMIN}` });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.citation_id, "M-007");

  const r = await postWithPayment<any>(base + "/memory/check", { query: "webhook retry caused a double charge, need refund" }, newPayer(), { maxAmount: 10n ** 22n });
  assert.equal(r.body.citation_id, "M-007");
  assert.ok(!JSON.stringify(r.body).includes("SECRET-DETAIL"));
});

test("cycle/run is admin-only", async () => {
  assert.equal((await post("/cycle/run", {})).status, 401);
  const r = await post("/cycle/run", {}, { authorization: `Bearer ${ADMIN}` });
  assert.equal(r.status, 200);
  assert.equal(r.body.ran, true);
});

test("unknown route 404, oversized body 413", async () => {
  assert.equal((await fetch(base + "/nope")).status, 404);
  assert.equal((await post("/memory/check", { query: "a", pad: "x".repeat(20000) })).status, 413);
});

test("state survives a restart (spent nonces, receipts, confessions)", async () => {
  const p = buildPayment(requirements, checkUrl, newPayer());
  assert.equal((await post("/memory/check", { query: MATCHING }, payHeader(p))).status, 200);
  const second = createMnemosyneServer({
    dataDir, seedPath: SEED, publicUrl: "http://mnemosyne.test", payTo: "mnemosyne-gov.testnet",
    network: "near:testnet", asset: "NEAR", priceAmount: "1000000000000000000000", maxTimeoutSeconds: 300,
    facilitator: new MockFacilitator(dataDir), mockSettlement: true,
  });
  await new Promise<void>((r) => second.server.listen(0, "127.0.0.1", () => r()));
  const b2 = `http://127.0.0.1:${(second.server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(b2 + "/memory/check", { method: "POST", headers: { "content-type": "application/json", ...payHeader(p) }, body: JSON.stringify({ query: MATCHING }) });
    assert.equal(r.status, 402, "spent nonce stays spent after restart");
    assert.equal(second.memory.size, 7, "confession persisted");
  } finally {
    second.server.close();
  }
});
