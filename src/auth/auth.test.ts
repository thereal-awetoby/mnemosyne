/**
 * Login, sign-up and personal guardrails: real ed25519 signatures, a fake NEAR RPC,
 * and the boundary that keeps a login from ever being root.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Decode, base58Encode } from "../nearTx.js";
import { createMnemosyneServer } from "../x402/server.js";
import { MockFacilitator } from "../x402/facilitator.js";
import { postWithPayment } from "../x402/client.js";
import { generateNearKeyPair, implicitAccountId as implicitOfPublic } from "../x402/crypto.js";
import { fullAccessKeyOnAccount, isAccountId } from "./accounts.js";
import { NEP413_TAG, formatPublicKey, nep413Hash, nep413Preimage, parseSignature, verifyNep413 } from "./nep413.js";
import { AuthError, AuthService, CHALLENGE_TTL_MS, PROTOCOL, SESSION_TTL_MS, defaultGuardrails, validateDisplayName, validateGuardrails } from "./service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
let dir = "";
before(() => { dir = mkdtempSync(join(tmpdir(), "mnemo-auth-")); });
after(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(dir, "d-"));

// ------------------------------------------------------------------ helpers

interface Key { seed: Uint8Array; pub: Uint8Array; publicKey: string }
const makeKey = (): Key => {
  const seed = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(seed);
  return { seed, pub, publicKey: formatPublicKey(pub) };
};
const hexOf = (k: Key) => Buffer.from(k.pub).toString("hex");
const signNep413 = (k: Key, message: string, nonceB64: string, recipient: string) =>
  Buffer.from(ed25519.sign(new Uint8Array(nep413Hash({ message, nonce: Buffer.from(nonceB64, "base64"), recipient })), k.seed)).toString("base64");

/** A fake NEAR RPC: `keys` maps "account|publicKey" -> "FullAccess" | "FunctionCall". */
const fakeRpc = (keys: Record<string, "FullAccess" | "FunctionCall">): typeof fetch =>
  (async (_url: string, init: RequestInit) => {
    const p = JSON.parse(String(init.body)).params;
    const perm = keys[`${p.account_id}|${p.public_key}`];
    const body = perm
      ? { result: { nonce: 1, permission: perm === "FullAccess" ? "FullAccess" : { FunctionCall: { allowance: null, receiver_id: "x.testnet", method_names: [] } } } }
      : { error: { name: "UNKNOWN_ACCESS_KEY" }, result: undefined };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;

// -------------------------------------------------------------------- NEP-413

describe("NEP-413 verification", () => {
  const k = makeKey();
  const nonce = Buffer.alloc(32, 7);
  const base = { message: "Sign in to Mnemosyne", nonce, recipient: "localhost:8402" };
  const sig = (p = base, key = k) => Buffer.from(ed25519.sign(new Uint8Array(nep413Hash(p)), key.seed)).toString("base64");

  it("hashes exactly tag || message || nonce || recipient || no-callback, in Borsh", () => {
    assert.equal(NEP413_TAG, 2 ** 31 + 413);
    const msg = Buffer.from(base.message), rec = Buffer.from(base.recipient);
    const len = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const expected = Buffer.concat([Buffer.from([0x9d, 0x01, 0x00, 0x80]), len(msg.length), msg, nonce, len(rec.length), rec, Buffer.from([0])]);
    assert.deepEqual(nep413Preimage(base), expected);
    assert.equal(nep413Hash(base).toString("hex"), createHash("sha256").update(expected).digest("hex"));
  });

  it("encodes a callback url as Some(string)", () => {
    const a = nep413Preimage({ ...base, callbackUrl: "https://a.b" });
    const b = nep413Preimage(base);
    assert.equal(a.length, b.length + 4 + "https://a.b".length);
    assert.equal(a[b.length - 1], 1);
  });

  it("accepts a good signature in base64, base64url and ed25519:base58 form", () => {
    const raw = Buffer.from(sig(), "base64");
    assert.ok(verifyNep413(base, k.publicKey, raw.toString("base64")));
    assert.ok(verifyNep413(base, k.publicKey, raw.toString("base64url")));
    assert.ok(verifyNep413(base, k.publicKey, "ed25519:" + base58Encode(raw)));
  });

  it("refuses a changed message, nonce, recipient, key or signature, and never throws", () => {
    const s = sig();
    assert.ok(!verifyNep413({ ...base, message: "Sign in to Mnemosyne!" }, k.publicKey, s));
    assert.ok(!verifyNep413({ ...base, nonce: Buffer.alloc(32, 8) }, k.publicKey, s));
    assert.ok(!verifyNep413({ ...base, recipient: "evil.example" }, k.publicKey, s));
    assert.ok(!verifyNep413(base, makeKey().publicKey, s));
    const tampered = Buffer.from(s, "base64"); tampered[10] ^= 1;
    assert.ok(!verifyNep413(base, k.publicKey, tampered.toString("base64")));
    for (const junk of [undefined, null, 5, "", "!!!", "ed25519:abc", "A".repeat(500)]) assert.ok(!verifyNep413(base, k.publicKey, junk as any));
    assert.ok(!verifyNep413(base, "secp256k1:abc", s));
    assert.throws(() => parseSignature("AAAA"), /expected 64/);
  });
});

// -------------------------------------------------------------- key ownership

describe("does the key control the account", () => {
  const k = makeKey();
  it("account id rules", () => {
    for (const ok of ["alice.testnet", "a-b_c.near", "ab", hexOf(k)]) assert.ok(isAccountId(ok), ok);
    for (const bad of ["A.testnet", "a", "", "a..b", ".a", "a b", "x".repeat(65), "a/b", 5 as any]) assert.ok(!isAccountId(bad), String(bad));
  });

  it("full-access key: yes. function-call key, unknown key, RPC down or odd answer: no, with a reason", async () => {
    const opts = (keys: Record<string, any>) => ({ rpcUrl: "http://rpc", fetch: fakeRpc(keys) });
    assert.deepEqual(await fullAccessKeyOnAccount("alice.testnet", k.publicKey, opts({ [`alice.testnet|${k.publicKey}`]: "FullAccess" })), { ok: true });
    const fc = await fullAccessKeyOnAccount("alice.testnet", k.publicKey, opts({ [`alice.testnet|${k.publicKey}`]: "FunctionCall" }));
    assert.ok(!fc.ok); assert.match(fc.reason!, /function-call/);
    const unknown = await fullAccessKeyOnAccount("alice.testnet", k.publicKey, opts({}));
    assert.ok(!unknown.ok); assert.match(unknown.reason!, /not on this account/);
    const down = await fullAccessKeyOnAccount("alice.testnet", k.publicKey, { rpcUrl: "http://rpc", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as any });
    assert.ok(!down.ok); assert.match(down.reason!, /could not reach NEAR RPC/);
    const odd = await fullAccessKeyOnAccount("alice.testnet", k.publicKey, { rpcUrl: "http://rpc", fetch: (async () => new Response("{}", { status: 200 })) as any });
    assert.ok(!odd.ok);
    assert.ok(!(await fullAccessKeyOnAccount("Bad Name", k.publicKey, opts({}))).ok);
    assert.ok(!(await fullAccessKeyOnAccount("alice.testnet", "ed25519:nope", opts({}))).ok);
  });

  it("an implicit account is controlled by its own key without asking the chain; another key still has to be on chain", async () => {
    const noRpc = { rpcUrl: "http://rpc", fetch: (async () => { throw new Error("must not be called"); }) as any };
    assert.deepEqual(await fullAccessKeyOnAccount(hexOf(k), k.publicKey, noRpc), { ok: true });
    const other = makeKey();
    assert.ok(!(await fullAccessKeyOnAccount(hexOf(k), other.publicKey, noRpc)).ok);
  });
});

// ------------------------------------------------------------ guardrails rules

describe("guardrail and name validation", () => {
  const base = defaultGuardrails();
  it("accepts changes inside the protocol bounds and says what changed", () => {
    const r = validateGuardrails({ pause_all: true, max_queries_per_day: 10, max_spend_per_day: "1000000000000000000000" }, base);
    assert.ok(r.ok);
    assert.deepEqual(r.guardrails, { pause_all: true, max_queries_per_day: 10, max_spend_per_day: "1000000000000000000000" });
    assert.equal(r.changes.length, 3);
    const same = validateGuardrails({ max_queries_per_day: base.max_queries_per_day }, base);
    assert.ok(same.ok && same.changes.length === 0);
  });
  it("refuses to go above the protocol, below zero, or to be sloppy", () => {
    for (const [bad, re] of [
      [{ max_queries_per_day: PROTOCOL.max_queries_per_day.max + 1 }, /above the protocol limit/],
      [{ max_queries_per_day: -1 }, /cannot be below 0/],
      [{ max_queries_per_day: 1.5 }, /whole number/],
      [{ max_queries_per_day: "5" }, /whole number/],
      [{ max_spend_per_day: (PROTOCOL.max_spend_per_day.max + 1n).toString() }, /above the protocol limit/],
      [{ max_spend_per_day: 5 }, /yoctoNEAR, as a string/],
      [{ max_spend_per_day: "-5" }, /yoctoNEAR/],
      [{ pause_all: "yes" }, /true or false/],
      [{ root: true }, /unknown guardrail "root"/],
      [{}, /nothing to change/],
    ] as const) {
      const r = validateGuardrails(bad, base);
      assert.ok(!r.ok, JSON.stringify(bad));
      assert.match((r as any).errors.join("; "), re);
    }
    for (const junk of [null, [], "x", 5]) assert.ok(!validateGuardrails(junk, base).ok);
  });
  it("display names: optional, 2-32 plain characters", () => {
    assert.deepEqual(validateDisplayName(undefined), { ok: true, name: null });
    assert.deepEqual(validateDisplayName("  Ada   Lovelace "), { ok: true, name: "Ada Lovelace" });
    assert.deepEqual(validateDisplayName("Ada\nLovelace"), { ok: true, name: "Ada Lovelace" }); // whitespace is tidied, never kept as a newline
    for (const bad of ["a", "x".repeat(33), "<script>alert(1)</script>", "ab\u0000c", "a&b", 5]) assert.ok(!(validateDisplayName(bad) as any).ok, String(bad));
  });
});

// ------------------------------------------------------------------- service

describe("login, sign-up, sessions and limits", () => {
  let t = 1_800_000_000_000;
  const alice = makeKey();
  const KEYS = { [`alice.testnet|${alice.publicKey}`]: "FullAccess", [`fc.testnet|${alice.publicKey}`]: "FunctionCall" } as const;
  const checks: Record<string, { at: string; amount: string }[]> = {};
  const make = (d = fresh()) => new AuthService({ dataDir: d, rpcUrl: "http://rpc", fetch: fakeRpc(KEYS), now: () => t, paidChecks: (p) => checks[p] ?? [] });
  const login = async (svc: AuthService, key = alice, account = "alice.testnet") => {
    const c = svc.challenge("localhost:8402");
    return svc.verify({ account_id: account, public_key: key.publicKey, signature: signNep413(key, c.message, c.nonce, c.recipient), nonce: c.nonce });
  };

  it("a signed challenge from a full-access key gives a session; the token is stored only as a hash", async () => {
    const d = fresh();
    const svc = make(d);
    const r = await login(svc);
    assert.equal(r.account_id, "alice.testnet");
    assert.equal(r.signed_up, false);
    assert.equal(svc.sessionAccount(r.token), "alice.testnet");
    assert.ok(!readFileSync(join(d, "sessions.json"), "utf8").includes(r.token));
  });

  it("the challenge names the site, expires, and is single use even when the attempt fails", async () => {
    const svc = make();
    const c = svc.challenge("localhost:8402");
    assert.match(c.message, /Site: localhost:8402/);
    assert.match(c.message, /not a transaction and costs nothing/);
    const mallory = makeKey();
    const bad = { account_id: "alice.testnet", public_key: mallory.publicKey, signature: signNep413(mallory, c.message, c.nonce, c.recipient), nonce: c.nonce };
    // right signature, but mallory's key is not on alice's account
    await assert.rejects(svc.verify(bad), /not on this account/);
    // the challenge is spent: even alice's own correct signature can't reuse it
    await assert.rejects(svc.verify({ account_id: "alice.testnet", public_key: alice.publicKey, signature: signNep413(alice, c.message, c.nonce, c.recipient), nonce: c.nonce }), /unknown or was already used/);
  });

  it("refuses: a forged signature, a limited key, an unknown account, an expired or made-up challenge, a bad host", async () => {
    const svc = make();
    const c1 = svc.challenge("localhost:8402");
    await assert.rejects(svc.verify({ account_id: "alice.testnet", public_key: alice.publicKey, signature: signNep413(makeKey(), c1.message, c1.nonce, c1.recipient), nonce: c1.nonce }), /signature does not match/);
    const c2 = svc.challenge("localhost:8402");
    await assert.rejects(svc.verify({ account_id: "fc.testnet", public_key: alice.publicKey, signature: signNep413(alice, c2.message, c2.nonce, c2.recipient), nonce: c2.nonce }), /function-call/);
    const c3 = svc.challenge("localhost:8402");
    await assert.rejects(svc.verify({ account_id: "nobody.testnet", public_key: alice.publicKey, signature: signNep413(alice, c3.message, c3.nonce, c3.recipient), nonce: c3.nonce }), /not on this account/);
    const c4 = svc.challenge("localhost:8402");
    t += CHALLENGE_TTL_MS + 1;
    await assert.rejects(svc.verify({ account_id: "alice.testnet", public_key: alice.publicKey, signature: signNep413(alice, c4.message, c4.nonce, c4.recipient), nonce: c4.nonce }), /expired/);
    await assert.rejects(svc.verify({ account_id: "alice.testnet", public_key: alice.publicKey, signature: "x", nonce: Buffer.alloc(32).toString("base64") }), /unknown or was already used/);
    await assert.rejects(svc.verify({ account_id: "alice.testnet", public_key: alice.publicKey, signature: "x", nonce: "short" }), /bad nonce/);
    assert.throws(() => svc.challenge("evil.example/path"), AuthError);
    assert.throws(() => svc.challenge("a b"), AuthError);
  });

  it("an implicit account signs in with its own key and no RPC", async () => {
    const svc = new AuthService({ dataDir: fresh(), rpcUrl: "http://rpc", fetch: (async () => { throw new Error("no rpc needed"); }) as any, now: () => t, paidChecks: () => [] });
    const r = await login(svc, alice, hexOf(alice));
    assert.equal(r.account_id, hexOf(alice));
  });

  it("sessions expire after 7 days and end on logout", async () => {
    const svc = make();
    const r = await login(svc);
    assert.equal(svc.sessionAccount(r.token), "alice.testnet");
    t += SESSION_TTL_MS + 1;
    assert.equal(svc.sessionAccount(r.token), null);
    const r2 = await login(svc);
    svc.logout(r2.token);
    assert.equal(svc.sessionAccount(r2.token), null);
    for (const junk of [undefined, "", "x".repeat(200), "a b", "../../x"]) assert.equal(svc.sessionAccount(junk), null);
  });

  it("sign-up: needs the confirmation, makes default guardrails, can only happen once, and the next login sees it", async () => {
    const svc = make();
    const r = await login(svc);
    assert.throws(() => svc.signUp("alice.testnet", { accepted: false }), /confirm that signing in gives access to your own settings only/);
    assert.throws(() => svc.signUp("alice.testnet", { accepted: true, display_name: "<b>" }), /display_name/);
    const p = svc.signUp("alice.testnet", { accepted: true, display_name: "Alice" });
    assert.deepEqual(p.guardrails, defaultGuardrails());
    assert.equal(p.display_name, "Alice");
    assert.throws(() => svc.signUp("alice.testnet", { accepted: true }), /already has a profile/);
    assert.equal((await login(svc)).signed_up, true);
    assert.ok(r.token);
  });

  it("guardrails: only the owner of the profile changes them, every change is logged, history is capped at 20", async () => {
    const svc = make();
    await login(svc);
    assert.throws(() => svc.updateGuardrails("alice.testnet", { pause_all: true }), /sign up first/);
    svc.signUp("alice.testnet", { accepted: true });
    const ok = svc.updateGuardrails("alice.testnet", { pause_all: true, max_queries_per_day: 5 });
    assert.ok(ok.ok && ok.profile.guardrails.pause_all && ok.profile.guardrails.max_queries_per_day === 5);
    assert.match(ok.ok ? ok.profile.history[0].change : "", /pause on; queries per day 50 -> 5/);
    assert.equal(ok.ok && ok.profile.history[0].by, "alice.testnet");
    const bad = svc.updateGuardrails("alice.testnet", { max_queries_per_day: 99999 });
    assert.ok(!bad.ok);
    assert.equal(svc.profile("alice.testnet")!.guardrails.max_queries_per_day, 5);
    for (let i = 0; i < 30; i++) svc.updateGuardrails("alice.testnet", { max_queries_per_day: 6 + i });
    assert.equal(svc.profile("alice.testnet")!.history.length, 20);
  });

  it("access: no profile = unaffected; pause = 403; query cap and spend cap = 429, counted over 24 hours from the receipts", async () => {
    const svc = make();
    const price = 10n ** 21n;
    assert.deepEqual(svc.access("stranger.testnet", price), { ok: true });
    await login(svc);
    svc.signUp("alice.testnet", { accepted: true });
    assert.deepEqual(svc.access("alice.testnet", price), { ok: true });

    svc.updateGuardrails("alice.testnet", { pause_all: true });
    const paused = svc.access("alice.testnet", price);
    assert.ok(!paused.ok && paused.status === 403);
    svc.updateGuardrails("alice.testnet", { pause_all: false, max_queries_per_day: 2 });

    const at = (msAgo: number) => new Date(t - msAgo).toISOString();
    checks["alice.testnet"] = [{ at: at(1000), amount: price.toString() }, { at: at(2000), amount: price.toString() }, { at: at(25 * 3600_000), amount: price.toString() }];
    const capped = svc.access("alice.testnet", price);
    assert.ok(!capped.ok && capped.status === 429);
    assert.match(capped.ok ? "" : capped.reason, /limit of 2 paid checks/);
    assert.equal(svc.usage("alice.testnet").queries, 2); // the 25-hour-old one is outside the window

    svc.updateGuardrails("alice.testnet", { max_queries_per_day: 100, max_spend_per_day: (2n * price).toString() });
    const over = svc.access("alice.testnet", price); // 2 already spent + 1 more > 2
    assert.ok(!over.ok && over.status === 429);
    assert.match(over.ok ? "" : over.reason, /spend limit/);
    svc.updateGuardrails("alice.testnet", { max_spend_per_day: (3n * price).toString() });
    assert.deepEqual(svc.access("alice.testnet", price), { ok: true });
    delete checks["alice.testnet"];
  });

  it("deleting an account removes the profile and every session", async () => {
    const svc = make();
    const r = await login(svc);
    svc.signUp("alice.testnet", { accepted: true });
    svc.deleteAccount("alice.testnet");
    assert.equal(svc.profile("alice.testnet"), null);
    assert.equal(svc.sessionAccount(r.token), null);
  });

  it("state survives a restart", async () => {
    const d = fresh();
    const a = make(d);
    const r = await login(a);
    a.signUp("alice.testnet", { accepted: true, display_name: "Alice" });
    const b = make(d);
    assert.equal(b.sessionAccount(r.token), "alice.testnet");
    assert.equal(b.profile("alice.testnet")!.display_name, "Alice");
  });
});

// --------------------------------------------------------------------- HTTP

describe("over HTTP", () => {
  let base = "", host = "", close = () => {}, d = "";
  const ADMIN = "admin-token-xyz";
  const wallet = generateNearKeyPair();                       // an account that is its own key (implicit)
  const walletAccount = implicitOfPublic(wallet.publicKey);
  const walletKey: Key = (() => { const raw = base58Decode(wallet.secretKey.slice(8)); const seed = new Uint8Array(raw.subarray(0, 32)); const pub = new Uint8Array(raw.subarray(32)); return { seed, pub, publicKey: formatPublicKey(pub) }; })();
  const named = makeKey();
  const KEYS = { [`named.testnet|${named.publicKey}`]: "FullAccess" } as const;

  const call = (path: string, init: RequestInit & { cookie?: string; json?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
      redirect: "manual",
      headers: { ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) },
    });

  async function signIn(key: Key, account: string): Promise<{ cookie: string; res: Response; body: any }> {
    const c: any = await (await call("/auth/challenge", { method: "POST", json: {} })).json();
    const res = await call("/auth/verify", { method: "POST", json: { account_id: account, public_key: key.publicKey, signature: signNep413(key, c.message, c.nonce, c.recipient), nonce: c.nonce } });
    const setCookie = res.headers.get("set-cookie") ?? "";
    return { cookie: setCookie.split(";")[0], res, body: await res.clone().json() };
  }

  before(async () => {
    d = fresh();
    const s = createMnemosyneServer({
      dataDir: d, seedPath: join(ROOT, "data/seed-memory.json"), payTo: "mnemosyne-gov.testnet", network: "near:testnet", asset: "NEAR",
      priceAmount: "1000000000000000000000", maxTimeoutSeconds: 300, facilitator: new MockFacilitator(d), mockSettlement: true,
      adminToken: ADMIN,
      limits: { get: () => ({}), set: () => ({ ok: true, view: {} }), reset: () => ({ ok: true, view: {} }) },
      runCycle: async () => ({ ran: "should never be reachable with a session" }),
      dashboardHtml: "<title>dash</title>", dashboardData: async () => ({ cycles: [] }),
      auth: { rpcUrl: "http://rpc", fetch: fakeRpc(KEYS), loginHtml: "<title>login</title>", loginScript: Buffer.from("window.NearConnector=1;"), payHtml: "<title>pay</title>" },
    });
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    const port = (s.server.address() as AddressInfo).port;
    host = `127.0.0.1:${port}`;
    base = `http://${host}`;
    close = () => s.server.close();
  });
  after(() => close());

  it("/login is its own page with the only relaxed lock-down; /dashboard keeps the strict one", async () => {
    const login = await call("/login");
    assert.equal(login.status, 200);
    assert.match(login.headers.get("content-security-policy")!, /connect-src 'self' https:/);
    assert.match(login.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    const dash = await call("/dashboard");
    assert.match(dash.headers.get("content-security-policy")!, /connect-src 'self';/);
    assert.ok(!/https:/.test(dash.headers.get("content-security-policy")!));
    const js = await call("/login/near-connect.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type")!, /javascript/);
  });

  it("/pay carries the same relaxed lock-down as /login (it loads the same wallet bundle)", async () => {
    const pay = await call("/pay");
    assert.equal(pay.status, 200);
    assert.match(pay.headers.get("content-security-policy")!, /connect-src 'self' https:/);
    assert.match(pay.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(pay.headers.get("cache-control")!, /no-store/);
  });

  it("nothing about me without a session", async () => {
    for (const [m, p] of [["GET", "/me"], ["GET", "/me/receipts"], ["PUT", "/me/guardrails"], ["POST", "/me/signup"], ["DELETE", "/me"]] as const) {
      assert.equal((await call(p, { method: m, json: m === "GET" || m === "DELETE" ? undefined : {} })).status, 401, `${m} ${p}`);
    }
    assert.equal((await call("/me", { cookie: "mn_session=not-a-session" })).status, 401);
  });

  it("sign in with a wallet signature: an HttpOnly SameSite=Strict cookie, and a brand-new account is not yet signed up", async () => {
    const r = await signIn(walletKey, walletAccount);
    assert.equal(r.res.status, 200);
    assert.equal(r.body.signed_up, false);
    const sc = r.res.headers.get("set-cookie")!;
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//);
    assert.ok(!r.res.headers.get("content-type")!.includes("html"));
    const me: any = await (await call("/me", { cookie: r.cookie })).json();
    assert.equal(me.account_id, walletAccount);
    assert.equal(me.signed_up, false);
    assert.equal(me.profile, null);
    assert.equal(me.protocol.max_queries_per_day.max, 1000);
  });

  it("a forged login is refused with a 401 and sets no cookie", async () => {
    const c: any = await (await call("/auth/challenge", { method: "POST", json: {} })).json();
    const res = await call("/auth/verify", { method: "POST", json: { account_id: walletAccount, public_key: walletKey.publicKey, signature: signNep413(makeKey(), c.message, c.nonce, c.recipient), nonce: c.nonce } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  it("cross-site writes are refused, and writes must be JSON", async () => {
    assert.equal((await call("/auth/challenge", { method: "POST", json: {}, headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await call("/auth/challenge", { method: "POST", json: {}, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await call("/auth/challenge", { method: "POST", json: {}, headers: { origin: base } })).status, 200);
    const r = await signIn(walletKey, walletAccount);
    assert.equal((await call("/me/signup", { method: "POST", body: "accepted=true", cookie: r.cookie, headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 415);
  });

  it("sign-up, then personal guardrails: a paused account's browser gets 403 BEFORE the 402", async () => {
    const r = await signIn(walletKey, walletAccount);
    assert.equal((await call("/me/signup", { method: "POST", json: { accepted: false }, cookie: r.cookie })).status, 400);
    const su = await call("/me/signup", { method: "POST", json: { accepted: true, display_name: "Wallet Tester" }, cookie: r.cookie });
    assert.equal(su.status, 201);
    assert.equal(((await su.json()) as any).profile.display_name, "Wallet Tester");
    assert.equal((await call("/me/signup", { method: "POST", json: { accepted: true }, cookie: r.cookie })).status, 409);

    const q = { query: "delete the full access key" };
    assert.equal((await call("/memory/check", { method: "POST", json: q, cookie: r.cookie })).status, 402);   // normal: asked to pay
    assert.equal((await call("/me/guardrails", { method: "PUT", json: { pause_all: true }, cookie: r.cookie })).status, 200);
    const paused = await call("/memory/check", { method: "POST", json: q, cookie: r.cookie });
    assert.equal(paused.status, 403);
    assert.match(((await paused.json()) as any).error, /paused by its owner/);
    assert.equal((await call("/memory/check", { method: "POST", json: q })).status, 402);                     // an anonymous caller is unaffected
    assert.equal((await call("/me/guardrails", { method: "PUT", json: { pause_all: false }, cookie: r.cookie })).status, 200);
  });

  it("guardrails above the protocol's bounds are a 400 with reasons and change nothing", async () => {
    const r = await signIn(walletKey, walletAccount);
    const bad = await call("/me/guardrails", { method: "PUT", json: { max_queries_per_day: 5000 }, cookie: r.cookie });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as any).errors[0], /above the protocol limit/);
    const me: any = await (await call("/me", { cookie: r.cookie })).json();
    assert.equal(me.profile.guardrails.max_queries_per_day, 50);
  });

  it("the account's own payments obey its own limits: paused = 403 and nothing settled; unpaused = paid and in /me/receipts, only mine", async () => {
    const r = await signIn(walletKey, walletAccount);
    const payer = { accountId: walletAccount, secretKey: wallet.secretKey };
    const limits = { maxAmount: 10n ** 22n };
    await call("/me/guardrails", { method: "PUT", json: { pause_all: true }, cookie: r.cookie });
    const refused = await postWithPayment(`${base}/memory/check`, { query: "delete the full access key" }, payer, limits);
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /paused by its owner/);
    const none: any = await (await call("/me/receipts", { cookie: r.cookie })).json();
    assert.equal(none.receipts.length, 0);                                           // nothing was charged

    await call("/me/guardrails", { method: "PUT", json: { pause_all: false }, cookie: r.cookie });
    const paid = await postWithPayment(`${base}/memory/check`, { query: "delete the full access key" }, payer, limits);
    assert.equal(paid.status, 200);
    const mine: any = await (await call("/me/receipts", { cookie: r.cookie })).json();
    assert.equal(mine.receipts.length, 1);
    assert.equal(mine.receipts[0].receipt_id, paid.body.receipt_id);
    const me: any = await (await call("/me", { cookie: r.cookie })).json();
    assert.equal(me.usage.queries, 1);

    // a different signed-in account sees none of it
    const other = await signIn(named, "named.testnet");
    const theirs: any = await (await call("/me/receipts", { cookie: other.cookie })).json();
    assert.equal(theirs.receipts.length, 0);

    // a query cap of 1 now refuses the next paid check, before settlement
    await call("/me/guardrails", { method: "PUT", json: { max_queries_per_day: 1 }, cookie: r.cookie });
    const capped = await postWithPayment(`${base}/memory/check`, { query: "delete the full access key" }, payer, limits);
    assert.equal(capped.status, 429);
    assert.match(capped.body.error, /limit of 1 paid checks/);
    assert.equal(((await (await call("/me/receipts", { cookie: r.cookie })).json()) as any).receipts.length, 1);
  });

  it("LOGIN IS NEVER ROOT: a signed-in session cannot use any operator route", async () => {
    const r = await signIn(walletKey, walletAccount);
    const as = (path: string, method: string, json?: unknown) => call(path, { method, json, cookie: r.cookie });
    assert.equal((await as("/limits", "PUT", { max_total_exposure: 100 })).status, 401);
    assert.equal((await as("/limits/reset", "POST", {})).status, 401);
    assert.equal((await as("/cycle/run", "POST", {})).status, 401);
    assert.equal((await as("/memory/confess", "POST", { category: "x" })).status, 401);
    // and the cookie value is not accepted as the admin bearer token either
    const token = r.cookie.split("=")[1];
    assert.equal((await call("/cycle/run", { method: "POST", json: {}, headers: { authorization: `Bearer ${token}` } })).status, 401);
    // the real operator token still works, separately
    assert.equal((await call("/cycle/run", { method: "POST", json: {}, headers: { authorization: `Bearer ${ADMIN}` } })).status, 200);
  });

  it("logout ends the session; delete removes the profile", async () => {
    const r = await signIn(walletKey, walletAccount);
    assert.equal((await call("/me", { cookie: r.cookie })).status, 200);
    const out = await call("/auth/logout", { method: "POST", json: {}, cookie: r.cookie });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await call("/me", { cookie: r.cookie })).status, 401);

    const again = await signIn(walletKey, walletAccount);
    assert.equal(again.body.signed_up, true);
    assert.equal((await call("/me", { method: "DELETE", cookie: again.cookie })).status, 200);
    assert.equal((await call("/me", { cookie: again.cookie })).status, 401);
    assert.equal((await signIn(walletKey, walletAccount)).body.signed_up, false);
  });

  it("sign-in attempts are rate limited per address", async () => {
    let last = 0;
    for (let i = 0; i < 40; i++) last = (await call("/auth/challenge", { method: "POST", json: {} })).status;
    assert.equal(last, 429);
  });
});

// ----------------------------------------------------------------- boundary

describe("the boundary that keeps login from being root", () => {
  const files = readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  it("src/auth imports nothing from the governor, the cycle, the allocation rails, the sub-agents or the owner's limits", () => {
    assert.ok(files.length >= 5);
    for (const f of files) {
      const src = readFileSync(join(__dirname, f), "utf8");
      for (const banned of ["../allocate", "../cycle", "../memory", "../report", "../subAgents", "../swarmState", "../private", "../limits", "../index", "../x402/rails", "../x402/facilitator", "../x402/client"]) {
        assert.ok(!new RegExp(`from\\s+"${banned.replace(/[./]/g, "\\$&")}`).test(src), `${f} must not import ${banned}`);
      }
      assert.ok(!/GOVERNOR_PRIVATE_KEY|ADMIN_TOKEN|runCrossChainAllocate|runAllocate/.test(src), `${f} must not mention operator secrets or rails`);
    }
  });
});

// ----------------------------------------------------------------- the two real pages

describe("the real pages on disk", () => {
  const WEB = resolve(__dirname, "../../web");
  const scriptsOf = (html: string) => [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  it("web/login.html: script parses, loads the wallet bundle from this server only, talks only to the auth routes", async () => {
    const vm = await import("node:vm");
    const html = readFileSync(join(WEB, "login.html"), "utf8");
    const inline = scriptsOf(html);
    assert.equal(inline.length, 1);
    assert.doesNotThrow(() => new vm.Script(inline[0]));
    const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ["/login/near-connect.js"], "no third-party script");
    assert.doesNotMatch(html, /https?:\/\//, "no absolute URLs in the login page");
    for (const route of ["/auth/challenge", "/auth/verify", "/me/signup", "/auth/logout"]) assert.ok(inline[0].includes(route), route);
    assert.match(inline[0], /accepted:/, "sign-up sends the 'login is not root' confirmation");
    assert.doesNotMatch(inline[0], /\.innerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(html, /ADMIN|GOVERNOR_PRIVATE_KEY|\/cycle\/run|\/limits/, "the login page knows nothing of operator routes");
  });

  it("web/login.html also uses the popup pattern: reports back to an opener and closes, instead of only navigating on", () => {
    const html = readFileSync(join(WEB, "login.html"), "utf8");
    assert.match(html, /window\.opener/, "detects being opened as a popup from the desk");
    assert.match(html, /postMessage\(\{\s*source:\s*["'`]mnemosyne-login["'`]/, "reports success back under its own message source");
    assert.match(html, /window\.close\(\)/, "can close itself once it has reported back");
  });

  it("web/dashboard.html: no wallet code and no outside scripts; the operator routes are only ever called with a Bearer token", () => {
    const html = readFileSync(join(WEB, "dashboard.html"), "utf8");
    assert.doesNotMatch(html, /<script[^>]*\ssrc=/, "the dashboard loads no script files");
    assert.doesNotMatch(html, /near-connect|NearConnector|signMessage\(/, "wallet code lives only on /login");
    const js = scriptsOf(html)[0];
    // every call to an operator route passes the typed admin token, never relies on the cookie
    for (const route of ['"/cycle/run"', '"/limits"', '"/limits/reset"']) {
      const calls = [...js.matchAll(new RegExp(`api\\("[A-Z]+", ${route.replace(/\//g, "\\/")}[^\\n]*`, "g"))].map((m) => m[0]);
      assert.ok(calls.length >= 1, `${route} is wired`);
      for (const c of calls) assert.match(c, /token\)/, `${c} must send the admin token`);
    }
  });

  it("the sign-in script in the dashboard server wiring reads web/login.html (serve.ts would fail at start-up without it)", () => {
    const serve = readFileSync(resolve(__dirname, "../serve.ts"), "utf8");
    assert.match(serve, /web\/login\.html/);
    assert.ok(readFileSync(join(WEB, "login.html"), "utf8").length > 1000);
    assert.ok(readFileSync(join(WEB, "vendor/near-connect.js")).length > 10_000);
  });

  it("web/pay.html: script parses, loads the wallet bundle from this server only, pays only through /memory/check", async () => {
    const vm = await import("node:vm");
    const html = readFileSync(join(WEB, "pay.html"), "utf8");
    const inline = scriptsOf(html);
    assert.equal(inline.length, 1);
    assert.doesNotThrow(() => new vm.Script(inline[0]));
    const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs, ["/login/near-connect.js"], "no third-party script");
    assert.doesNotMatch(html, /https?:\/\//, "no absolute URLs in the pay page");
    for (const route of ["/me", "/memory/check"]) assert.ok(inline[0].includes(route), route);
    assert.match(inline[0], /next=/, "bounces a signed-out visitor through /login with a way back here");
    assert.match(inline[0], /signDelegateActions/, "signs a NEP-366 delegate action, never a private key held on the page");
    // not every NEAR wallet implements signDelegateActions (MyNearWallet does not) -- a wallet
    // reused from /login must be checked for that feature before this page ever trusts it
    assert.match(inline[0], /features\?\.signDelegateActions|features\.signDelegateActions/, "checks a reused wallet actually supports signing a delegate action, rather than assuming it");
    assert.match(inline[0], /getConnectedWallet/, "resumes the /login session instead of always prompting a new connection");
    assert.match(inline[0], /Meteor Wallet/, "names a wallet that is actually known to support this, for when the reused one can't");
    assert.doesNotMatch(inline[0], /\.innerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(html, /ADMIN|GOVERNOR_PRIVATE_KEY|\/cycle\/run|\/limits/, "the pay page knows nothing of operator routes");

    // One press, start to finish. The page used to ship its Pay button
    // disabled until "Ask without paying" had been pressed, which is why a
    // wallet never opened: the button that opens it could not be clicked.
    assert.doesNotMatch(html, /Ask without paying/, "no ask-first gate in front of paying");
    assert.equal((html.match(/class="btn primary"/g) ?? []).length, 1, "exactly one primary action on the page");
    assert.doesNotMatch(html, /id="btnPay"[^>]*\sdisabled/, "the pay button is not disabled on arrival");
    assert.ok(inline[0].includes("/pay/payer-status"), "asks the server what the payer holds before signing");

    // A faucet pays out native NEAR; the price is in wNEAR. The wrap cannot
    // ride inside the payment (the official verifier takes exactly one
    // action), so it is its own transaction, signed first.
    assert.match(inline[0], /near_deposit/, "can turn native NEAR into wNEAR");
    assert.match(inline[0], /storage_deposit/, "registers the payer with the token the first time");
    assert.match(inline[0], /signAndSendTransactions/, "the wrap is an ordinary transaction, not a delegate action");

    // wNEAR has the SAME 24 decimals as native yoctoNEAR, not the 18 an Ethereum-token
    // assumption would give it -- a wrong constant here once showed "1000 wNEAR" for a
    // 0.001 wNEAR price. Pull the real function out of the page and run it, rather than
    // trust a number in a comment: the default price from docs/X402.md must read back as 0.001.
    const moneySrc = inline[0].match(/const money = (\([^)]*\) => `[^`]*`);/)?.[1];
    assert.ok(moneySrc, "money() helper found in the page");
    const money = new vm.Script(`(${moneySrc})`).runInNewContext({});
    assert.equal(money("1000000000000000000000"), "0.001000 wNEAR", "the documented default price (X402_PRICE_YOCTO) must read back correctly, not off by a million");
  });

  it("the /pay wiring reads web/pay.html (serve.ts would fail at start-up without it)", () => {
    const serve = readFileSync(resolve(__dirname, "../serve.ts"), "utf8");
    assert.match(serve, /web\/pay\.html/);
    assert.ok(readFileSync(join(WEB, "pay.html"), "utf8").length > 1000);
  });

  it("web/dashboard.html links to /pay for a real, wallet-signed payment, but never embeds wallet code itself", () => {
    const html = readFileSync(join(WEB, "dashboard.html"), "utf8");
    assert.match(html, /\/pay(\?|")/, "the dashboard offers a way to the wallet-payment page");
    assert.doesNotMatch(html, /signDelegateActions/, "wallet-signing code lives only on /pay, never the dashboard");

    // A popup, not a page the visitor has to navigate back from -- and not a
    // frame either, because /pay sets frame-ancestors 'none' on purpose.
    assert.match(html, /window\.open\(/, "the wallet opens in a popup over the desk");
    assert.doesNotMatch(html, /<iframe|\.src\s*=\s*["'`]\/pay/, "never framed: /pay refuses to be framed");
    assert.match(html, /e\.origin !== location\.origin/, "the popup's result is accepted only from this same origin");
  });

  it("web/dashboard.html sends /login the same way: a popup over the desk, never a page to navigate away to", () => {
    const html = readFileSync(join(WEB, "dashboard.html"), "utf8");
    assert.match(html, /href:\s*["'`]\/login["'`]/, "the dashboard still renders plain /login links as the underlying markup");
    assert.doesNotMatch(html, /near-connect|NearConnector|signMessage\(/, "wallet-connector code lives only on /login and /pay, never the dashboard");

    // Same pattern as /pay (tested above), applied to every /login link too:
    // a click is caught before it navigates and opens a popup instead.
    assert.match(html, /a\[href\^=['"`]\/login['"`]\]/, "clicks on /login links are caught at the document level");
    assert.match(html, /window\.open\(/, "sign-in opens in a popup over the desk, same as /pay");
    assert.match(html, /mnemosyne-login/, "the sign-in popup has its own window name and message source");
  });
});

/**
 * The wrap step: a payer with only faucet NEAR has to turn some of it into
 * wNEAR before the price can be paid at all. /pay asks the server what they
 * hold rather than guessing, so these are the guards around that answer.
 */
describe("/pay/payer-status (only on a rail that moves real tokens)", () => {
  const PRICE = "1000000000000000000000";
  const TOKEN = "wrap.testnet";
  const wallet = generateNearKeyPair();
  const walletAccount = implicitOfPublic(wallet.publicKey);
  const walletKey: Key = (() => {
    const raw = base58Decode(wallet.secretKey.slice(8));
    return { seed: new Uint8Array(raw.subarray(0, 32)), pub: new Uint8Array(raw.subarray(32)), publicKey: formatPublicKey(new Uint8Array(raw.subarray(32))) };
  })();

  /** A NEAR RPC holding one account with native NEAR and no wNEAR at all --
   *  exactly what a testnet faucet leaves someone with. */
  const chainFetch = (async (_url: string, init: any) => {
    const body = JSON.parse(String(init.body));
    const p = body.params;
    const encode = (v: unknown) => new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify(v), "utf8")] } }), { status: 200 });
    if (p?.request_type === "view_account") return new Response(JSON.stringify({ result: { amount: "5000000000000000000000000", storage_usage: 182 } }), { status: 200 });
    if (p?.request_type === "call_function") {
      if (p.method_name === "ft_balance_of") return encode("0");
      if (p.method_name === "storage_balance_of") return encode(null);
      if (p.method_name === "storage_balance_bounds") return encode({ min: "1250000000000000000000", max: null });
    }
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  }) as unknown as typeof fetch;

  /** The smallest thing that is not the mock rail. Nothing is ever paid here;
   *  the point is only that the server treats it as real. */
  const realRail = {
    mode: "near-exact", mock: false,
    requirements: { scheme: "exact", network: "near:testnet", amount: PRICE, asset: TOKEN, payTo: "mnemosyne-gov.testnet", maxTimeoutSeconds: 300, extra: {} },
    decode: () => ({}), bindingError: () => "not used in this test", verify: async () => ({ isValid: false, payer: null, invalidReason: "x" }),
    settle: async () => ({ success: false, transaction: null, network: "near:testnet", payer: null, amount: null, errorReason: "x" }),
    settlementIssue: () => null, responseHeader: () => "", explorerUrl: () => null,
  } as unknown as Parameters<typeof createMnemosyneServer>[0]["rail"];

  let base = "", close = () => {}, cookie = "";

  before(async () => {
    const d = fresh();
    const s = createMnemosyneServer({
      dataDir: d, seedPath: join(ROOT, "data/seed-memory.json"), payTo: "mnemosyne-gov.testnet", network: "near:testnet",
      asset: TOKEN, priceAmount: PRICE, maxTimeoutSeconds: 300, mockSettlement: false, rail: realRail,
      auth: { rpcUrl: "http://rpc", fetch: chainFetch, payHtml: "<title>pay</title>" },
    });
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
    close = () => s.server.close();
    const c: any = await (await fetch(`${base}/auth/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const v = await fetch(`${base}/auth/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: walletAccount, public_key: walletKey.publicKey, signature: signNep413(walletKey, c.message, c.nonce, c.recipient), nonce: c.nonce }),
    });
    cookie = (v.headers.get("set-cookie") ?? "").split(";")[0];
  });
  after(() => close());

  const get = (path: string, withCookie = true) =>
    fetch(`${base}${path}`, { headers: withCookie ? { cookie } : {} });

  it("says what a faucet-funded wallet is missing, and that wrapping can cover it", async () => {
    const r = await get(`/pay/payer-status?account=${walletAccount}`);
    assert.equal(r.status, 200);
    const s: any = await r.json();
    assert.equal(s.enough, false, "no wNEAR yet, so the price cannot be paid as-is");
    assert.equal(s.registered, false);
    assert.equal(s.short_by, PRICE);
    assert.equal(s.wrap_total, (BigInt(PRICE) + 1250000000000000000000n).toString(), "the price plus a one-time storage deposit");
    assert.equal(s.can_wrap, true, "5 NEAR is plenty to wrap 0.001 from");
    assert.equal(s.asset, TOKEN);
  });

  it("is not an open balance oracle: no session, no answer", async () => {
    assert.equal((await get(`/pay/payer-status?account=${walletAccount}`, false)).status, 401);
  });

  it("refuses anything that is not a NEAR account id", async () => {
    for (const bad of ["", "UPPER.testnet", "has%20space", "a", "x".repeat(65)]) {
      assert.equal((await get(`/pay/payer-status?account=${bad}`)).status, 400, bad);
    }
  });
});
