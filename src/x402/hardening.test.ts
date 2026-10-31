/** Regression tests for public-origin binding, untrusted inputs and failure paths. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMnemosyneServer, type ServerConfig } from "./server.js";
import { MockFacilitator, authorizationMessage, type Facilitator } from "./facilitator.js";
import { buildPayment, postWithPayment, type Payer } from "./client.js";
import { JsonStore } from "./jsonStore.js";
import { b64json, fromB64json, generateNearKeyPair, implicitAccountId, signMessage } from "./crypto.js";
import { parseBaseUnits, requirementsError, settlementError } from "./validation.js";
import type { PaymentRequired, PaymentRequirements, SettlementResponse } from "./types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SEED = join(ROOT, "data/seed-memory.json");
const QUERY = "about to delete the full access key before the replacement key works";

function payer(): Payer {
  const kp = generateNearKeyPair();
  return { accountId: implicitAccountId(kp.publicKey), secretKey: kp.secretKey };
}

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }, overrides: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mnemo-hardening-"));
  const facilitator = overrides.facilitator ?? new MockFacilitator(dir);
  const created = createMnemosyneServer({
    dataDir: dir, seedPath: SEED, payTo: "mnemosyne-gov.testnet", network: "near:testnet",
    asset: "NEAR", priceAmount: "1000", maxTimeoutSeconds: 300,
    facilitator, mockSettlement: true, ...overrides,
  });
  await new Promise<void>((r) => created.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  t.after(async () => {
    created.server.closeAllConnections();
    await new Promise<void>((r) => created.server.close(() => r()));
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  async function post(body: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(base + "/memory/check", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    return { status: r.status, headers: r.headers, body: await r.json() as any };
  }
  // Undici fetch reserves Host. Raw node:http lets us simulate a reverse proxy.
  async function proxyPost(body: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }>((resolve, reject) => {
      const req = httpRequest(base + "/memory/check", {
        method: "POST", headers: { "content-type": "application/json", ...headers },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  }
  return { ...created, dir, base, post, proxyPost };
}

async function quote(f: Awaited<ReturnType<typeof fixture>>, headers: Record<string, string> = {}) {
  const r = await f.post({ query: QUERY }, headers);
  assert.equal(r.status, 402);
  return fromB64json<PaymentRequired>(r.headers.get("payment-required")!);
}

test("proxy Host and protocol bind the quote and paid request to the public origin", async (t) => {
  const f = await fixture(t);
  const host = "8402-example.e2b.app";
  const headers = { host, "x-forwarded-proto": "https" };
  const first = await f.proxyPost({ query: QUERY }, headers);
  assert.equal(first.status, 402);
  const q = fromB64json<PaymentRequired>(first.headers["payment-required"] as string);
  assert.equal(q.resource.url, `https://${host}/memory/check`);
  const p = buildPayment(q.accepts[0], q.resource.url, payer());
  const paid = await f.proxyPost({ query: QUERY }, { ...headers, "PAYMENT-SIGNATURE": b64json(p) });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.match, true);
  const receipt = await (await fetch(`${f.base}/memory/receipt/${paid.body.receipt_id}`)).json() as any;
  assert.equal(receipt.resource, q.resource.url);
  // A signature for the proxy origin cannot be replayed on the local origin.
  const replay = await f.post({ query: QUERY }, { "PAYMENT-SIGNATURE": b64json(p) });
  assert.equal(replay.status, 402);
  assert.equal(replay.body.error, "payment not bound to this resource");
});

test("local client works without PUBLIC_URL and explicit origin remains pinned", async (t) => {
  const f = await fixture(t);
  const r = await postWithPayment<any>(f.base + "/memory/check", { query: QUERY }, payer(), { maxAmount: 1000n });
  assert.equal(r.status, 200);
  assert.equal(r.quote.resource.url, f.base + "/memory/check");
  const pinned = await fixture(t, { publicUrl: "https://api.example.com/" });
  const first = await pinned.proxyPost({ query: QUERY }, { host: "attacker.example", "x-forwarded-proto": "http" });
  const q = fromB64json<PaymentRequired>(first.headers["payment-required"] as string);
  assert.equal(q.resource.url, "https://api.example.com/memory/check");
});

test("malformed public host and configuration fail safely", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.proxyPost({ query: QUERY }, { host: "bad host" })).status, 400);
  assert.equal((await f.post({ query: QUERY }, { "x-forwarded-proto": "file" })).status, 400);
  assert.throws(() => createMnemosyneServer({
    dataDir: f.dir, seedPath: SEED, publicUrl: "file:///tmp/x", payTo: "x.testnet",
    network: "near:testnet", asset: "NEAR", priceAmount: "1000", maxTimeoutSeconds: 300,
    facilitator: new MockFacilitator(f.dir), mockSettlement: true,
  }), /HTTP\(S\)/);
});

test("client refuses a quote for a different resource before sending a payment", async (t) => {
  const f = await fixture(t);
  const q = await quote(f);
  let retries = 0;
  const rogue = createServer((req, res) => {
    if (req.headers["payment-signature"]) retries++;
    req.resume();
    req.on("end", () => {
      q.resource.url = "https://attacker.example/memory/check";
      res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": b64json(q) });
      res.end(JSON.stringify(q));
    });
  });
  await listen(rogue); t.after(() => close(rogue));
  await assert.rejects(postWithPayment(`http://127.0.0.1:${port(rogue)}/memory/check`, { query: QUERY }, payer(), { maxAmount: 1000n }), /does not match requested URL/);
  assert.equal(retries, 0);
});

test("client will not forward a payment signature through a redirect", async (t) => {
  const f = await fixture(t);
  const q = await quote(f);
  let stolen = 0;
  const target = createServer((_req, res) => { stolen++; res.end("{}"); });
  await listen(target); t.after(() => close(target));
  const redirect = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.headers["payment-signature"]) {
        res.writeHead(307, { location: `http://127.0.0.1:${port(target)}/steal` }); res.end();
      } else {
        q.resource.url = `http://127.0.0.1:${port(redirect)}/memory/check`;
        res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": b64json(q) });
        res.end(JSON.stringify(q));
      }
    });
  });
  await listen(redirect); t.after(() => close(redirect));
  await assert.rejects(postWithPayment(`http://127.0.0.1:${port(redirect)}/memory/check`, { query: QUERY }, payer(), { maxAmount: 1000n }));
  assert.equal(stolen, 0);
});

test("strict money parsing and client price, recipient, network and scheme limits", async (t) => {
  for (const value of [1, true, null, "01", "1e3", "0x10", "-1", " 1", "1.0", ""]) {
    assert.throws(() => parseBaseUnits(value));
  }
  assert.equal(parseBaseUnits("0"), 0n);
  assert.equal(parseBaseUnits("1000"), 1000n);
  const f = await fixture(t);
  const q = await quote(f);
  const req = q.accepts[0];
  assert.throws(() => buildPayment({ ...req, amount: "1001" }, q.resource.url, payer(), Date.now(), { maxAmount: 1000n }), /exceeds limit/);
  assert.throws(() => buildPayment(req, q.resource.url, payer(), Date.now(), { maxAmount: 1000n, allowedPayTo: [] }), /unknown recipient/);
  assert.throws(() => buildPayment(req, q.resource.url, payer(), Date.now(), { maxAmount: 1000n, allowedNetworks: ["near:mainnet"] }), /unexpected network/);
  assert.equal(requirementsError({ ...req, extra: { ...req.extra, assetTransferMethod: "unknown" } }), "unsupported_transfer_method");
  assert.equal(requirementsError({ ...req, amount: "0" }), "invalid_amount");
  assert.equal(requirementsError({ ...req, maxTimeoutSeconds: 0 }), "invalid_timeout");
});

test("malformed authorization shapes and non-decimal amounts return 402, not 500", async (t) => {
  const f = await fixture(t);
  const q = await quote(f);
  const agent = payer();
  const valid = buildPayment(q.accepts[0], q.resource.url, agent);
  for (const authorization of [null, [], "bad", 7]) {
    const p = { ...valid, payload: { ...valid.payload, authorization } };
    assert.equal((await f.post({ query: QUERY }, { "PAYMENT-SIGNATURE": b64json(p) })).status, 402);
  }
  for (const value of [1000, true, "0x3e8", "1e3", "01000", "-1000"]) {
    const p = buildPayment(q.accepts[0], q.resource.url, agent);
    (p.payload.authorization as any).value = value;
    p.payload.signature = signMessage(agent.secretKey, authorizationMessage(p.payload.authorization));
    const r = await f.post({ query: QUERY }, { "PAYMENT-SIGNATURE": b64json(p) });
    assert.equal(r.status, 402);
    assert.equal(r.body.error, "invalid_amount");
  }
  const over = buildPayment(q.accepts[0], q.resource.url, agent);
  over.payload.authorization.value = "1001";
  over.payload.signature = signMessage(agent.secretKey, authorizationMessage(over.payload.authorization));
  const r = await f.post({ query: QUERY }, { "PAYMENT-SIGNATURE": b64json(over) });
  assert.equal(r.body.error, "amount_mismatch");
});

test("named-account ownership errors fail closed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mnemo-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const facilitator = new MockFacilitator(dir, { checkNamedAccountKey: async () => { throw new Error("RPC unavailable"); } });
  const f = await fixture(t, { facilitator });
  const q = await quote(f);
  const p = buildPayment(q.accepts[0], q.resource.url, { ...payer(), accountId: "agent.testnet" });
  const r = await f.post({ query: QUERY }, { "PAYMENT-SIGNATURE": b64json(p) });
  assert.equal(r.status, 402);
  assert.equal(r.body.error, "payer_key_mismatch");
});

test("inconsistent successful settlement never releases an answer or asks for a second payment", async (t) => {
  const agent = payer();
  const inner = { verify: async () => ({ isValid: true, payer: agent.accountId, invalidReason: null }) };
  const good: SettlementResponse = { success: true, transaction: "mock_test", network: "near:testnet", payer: agent.accountId, amount: "1000" };
  for (const bad of [
    { ...good, amount: "1" }, { ...good, payer: "attacker.testnet" },
    { ...good, network: "near:mainnet" }, { ...good, transaction: "onchain_but_mock_configured" },
  ]) {
    const facilitator: Facilitator = { ...inner, settle: async () => bad };
    const f = await fixture(t, { facilitator });
    const q = await quote(f);
    const p = buildPayment(q.accepts[0], q.resource.url, agent);
    const r = await f.post({ query: QUERY }, { "PAYMENT-SIGNATURE": b64json(p) });
    assert.equal(r.status, 502);
    assert.equal(r.body.match, undefined);
    assert.equal(r.headers.get("payment-required"), null);
  }
  const req = (await quote(await fixture(t))).accepts[0];
  assert.equal(settlementError(good, req, agent.accountId), null);
});

test("failed disk write rolls back memory; a retry can still succeed", async (t) => {
  // Portable failure injection: a DIRECTORY sitting where the state file must
  // go makes the final rename fail on Linux, macOS and Windows alike, as any
  // user. (chmod 0o500 on a folder doesn't stop writes on Windows or as root.)
  const dir = mkdtempSync(join(tmpdir(), "mnemo-rollback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  const store = new JsonStore<{ spent: boolean }>(path, () => ({ spent: false }));
  mkdirSync(path);
  writeFileSync(join(path, "blocker"), "x");
  assert.throws(() => store.update(v => { v.spent = true; }));
  assert.deepEqual(store.get(), { spent: false }, "memory not updated when the write failed");
  assert.deepEqual(readdirSync(dir), ["state.json"], "no temp file left behind");
  rmSync(path, { recursive: true, force: true });
  store.update(v => { v.spent = true; });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { spent: true });
  assert.throws(() => store.update(() => { throw new Error("mutation failed"); }));
  assert.deepEqual(store.get(), { spent: true });
});

test("corrupt persisted state fails startup instead of resetting the ledger", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mnemo-corrupt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.json");
  writeFileSync(path, "{broken");
  assert.throws(() => new JsonStore(path, () => ({})), SyntaxError);
  assert.equal(readFileSync(path, "utf8"), "{broken");
});

test("admin routes stay disabled without a token", async (t) => {
  const f = await fixture(t);
  for (const path of ["/memory/confess", "/cycle/run"]) {
    const r = await fetch(f.base + path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 503);
  }
});

function port(server: Server): number { return (server.address() as AddressInfo).port; }
async function listen(server: Server): Promise<void> { await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
function exists(path: string): boolean { try { readFileSync(path); return true; } catch { return false; } }
