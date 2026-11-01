/** The 1Click probe: request variants, token-list check, and the plain-words diagnosis. All offline. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58Encode, implicitAccountId, publicKeyFromSecret } from "../nearTx.js";
import { DESTINATIONS, ORIGIN_ASSET } from "./cross_chain.js";
import {
  PROBE_BIG_AMOUNT, PROBE_BURN_RECIPIENT, PROBE_CONTROL_DEST,
  buildProbeVariants, checkTokens, diagnose, runProbe, runVariant,
  type ProbeInput, type ProbeResult, type TokenCheck,
} from "./crossChainProbe.js";

const NOW = 1_800_000_000_000;
const IMPLICIT = "ab".repeat(32);
const INPUT: ProbeInput = { recipient: "0x" + "12".repeat(20), sender: "mnemosyne-gov.testnet", implicit: IMPLICIT, amount: "1000000000000000000000", slippageBps: 50, now: NOW };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OUR = DESTINATIONS["base:USDC"].oneClickId;
const GOOD_TOKENS: TokenCheck = { reachable: true, count: 200, wrapNear: true, ourDest: true, baseUsdc: [OUR] };
const res = (key: ProbeResult["key"], ok: boolean, message = ok ? "quote ok" : "Internal server error"): ProbeResult =>
  ({ key, label: key, refund: "x", amount: "1", ok, status: ok ? 200 : 400, message });

describe("implicit account", () => {
  it("is the hex of the 32-byte public key of an ed25519 NEAR secret", () => {
    const seed = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(seed);
    const secret = "ed25519:" + base58Encode(Uint8Array.from([...seed, ...pub]));
    assert.equal(implicitAccountId(secret), Buffer.from(pub).toString("hex"));
    assert.equal(implicitAccountId(secret).length, 64);
    assert.equal(publicKeyFromSecret(secret), "ed25519:" + base58Encode(pub));
  });
  it("refuses something that is not an ed25519 secret", () => {
    assert.throws(() => implicitAccountId("secp256k1:abc"), /must start with "ed25519:"/);
  });
});

describe("probe variants", () => {
  const vs = buildProbeVariants(INPUT);
  const by = (k: string) => vs.find((v) => v.key === k)!;

  it("makes six variants, each changing one thing, in order", () => {
    assert.deepEqual(vs.map((v) => v.key), ["A", "B", "C", "D", "E", "F"]);
    assert.equal(by("A").body.refundTo, "mnemosyne-gov.testnet");
    assert.equal(by("A").body.amount, INPUT.amount);
    assert.equal(by("B").body.refundTo, IMPLICIT);
    assert.equal(by("B").body.amount, INPUT.amount);
    assert.equal(by("C").body.refundTo, "mnemosyne-gov.testnet");
    assert.equal(by("C").body.amount, PROBE_BIG_AMOUNT);
    assert.equal(by("D").body.refundTo, IMPLICIT);
    assert.equal(by("D").body.amount, PROBE_BIG_AMOUNT);
    assert.equal(by("E").body.recipient, PROBE_BURN_RECIPIENT);
    assert.equal(by("F").body.destinationAsset, PROBE_CONTROL_DEST.oneClickId);
  });

  it("every variant is a dry request (no deposit address possible) with the real request shape", () => {
    for (const v of vs) {
      assert.equal(v.body.dry, true, v.key);
      assert.equal(v.body.swapType, "EXACT_INPUT");
      assert.equal(v.body.originAsset, ORIGIN_ASSET.oneClickId);
      assert.equal(v.body.deadline, new Date(NOW + 600_000).toISOString());
    }
    assert.equal(by("A").body.destinationAsset, OUR);
    assert.equal(by("A").body.recipient, INPUT.recipient);
  });

  it("without a governor key the implicit-account variants are skipped and the control still runs", () => {
    const k = buildProbeVariants({ ...INPUT, implicit: null }).map((v) => v.key);
    assert.deepEqual(k, ["A", "C", "F"]);
  });

  it("skips the repeats B and D when the configured refund account already is the implicit one", () => {
    const k = buildProbeVariants({ ...INPUT, sender: IMPLICIT }).map((v) => v.key);
    assert.deepEqual(k, ["A", "C", "E", "F"]);
  });

  it("skips the different-recipient variant when the recipient already is the burn address", () => {
    const k = buildProbeVariants({ ...INPUT, recipient: PROBE_BURN_RECIPIENT.toLowerCase() }).map((v) => v.key);
    assert.deepEqual(k, ["A", "B", "C", "D", "F"]);
  });
});

describe("token list and requests", () => {
  const list = [
    { assetId: "nep141:wrap.near", blockchain: "near", symbol: "wNEAR" },
    { assetId: OUR, blockchain: "base", symbol: "USDC" },
    { assetId: "nep141:base-0xother.omft.near", blockchain: "base", symbol: "WETH" },
  ];

  it("finds our two ids and lists Base USDC", async () => {
    const t = await checkTokens((async () => json(200, list)) as any, "https://x");
    assert.deepEqual(t, { reachable: true, count: 3, wrapNear: true, ourDest: true, baseUsdc: [OUR] });
  });

  it("says when our Base USDC id is missing and shows the ones that exist", async () => {
    const other = [list[0], { assetId: "nep141:base-0xREAL.omft.near", blockchain: "base", symbol: "USDC" }];
    const t = await checkTokens((async () => json(200, other)) as any, "https://x");
    assert.equal(t.ourDest, false);
    assert.deepEqual(t.baseUsdc, ["nep141:base-0xREAL.omft.near"]);
  });

  it("reports an unreachable or odd token list instead of throwing", async () => {
    assert.equal((await checkTokens((async () => { throw new Error("ENOTFOUND"); }) as any, "https://x")).error, "ENOTFOUND");
    assert.match((await checkTokens((async () => json(500, { message: "boom" })) as any, "https://x")).error!, /answered 500/);
    assert.match((await checkTokens((async () => json(200, [])) as any, "https://x")).error!, /empty/);
  });

  it("turns a 400 into its message, a 200 into 'quote ok', and a dead network into 'no answer'", async () => {
    const v = buildProbeVariants(INPUT)[0];
    const bad = await runVariant((async () => json(400, { message: "Internal server error" })) as any, "https://x", v);
    assert.deepEqual([bad.ok, bad.status, bad.message], [false, 400, "Internal server error"]);
    const good = await runVariant((async () => json(200, { quote: { amountOut: "3100" } })) as any, "https://x", v);
    assert.deepEqual([good.ok, good.status], [true, 200]);
    assert.match(good.message, /3100/);
    const dead = await runVariant((async () => { throw new Error("socket hang up"); }) as any, "https://x", v);
    assert.deepEqual([dead.ok, dead.status, dead.message], [false, null, "no answer (socket hang up)"]);
  });

  it("sends the JWT as a Bearer header and never prints it", async () => {
    let auth: string | undefined;
    const v = buildProbeVariants(INPUT)[0];
    const r = await runVariant((async (_u: string, init: RequestInit) => { auth = (init.headers as Record<string, string>).authorization; return json(401, { message: "Unauthorized" }); }) as any, "https://x", v, "JWT-1");
    assert.equal(auth, "Bearer JWT-1");
    assert.ok(!r.message.includes("JWT-1"));
  });

  it("runProbe asks the token list once and each variant once, in order, with POST /v0/quote", async () => {
    const calls: string[] = [];
    const out = await runProbe(INPUT, {
      baseUrl: "https://stub", jwt: "",
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url.replace("https://stub", "")}`);
        return url.endsWith("/v0/tokens") ? json(200, list) : json(400, { message: "Internal server error" });
      }) as any,
    });
    assert.deepEqual(calls, ["GET /v0/tokens", ...Array(6).fill("POST /v0/quote")]);
    assert.equal(out.results.length, 6);
    assert.ok(out.results.every((r) => !r.ok));
  });
});

describe("diagnosis in plain words", () => {
  const all = (okKeys: string[]) => ["A", "B", "C", "D", "E", "F"].map((k) => res(k as any, okKeys.includes(k)));

  it("A works: the 400 was not the settings", () => {
    const d = diagnose(GOOD_TOKENS, all(["A", "B", "C", "D", "E", "F"]), IMPLICIT);
    assert.match(d.lines.join(" "), /earlier 400 did not come from your settings/);
    assert.deepEqual(d.env, {});
  });

  it("only the refund account matters: sets CROSS_CHAIN_SENDER to the implicit account", () => {
    const d = diagnose(GOOD_TOKENS, all(["B", "D", "E", "F"]), IMPLICIT);
    assert.deepEqual(d.env, { CROSS_CHAIN_SENDER: IMPLICIT });
    assert.match(d.lines.join(" "), /refund account was the problem/);
  });

  it("only the amount matters: scales the unit to 0.1 wNEAR per 100 units", () => {
    const d = diagnose(GOOD_TOKENS, all(["C", "D", "E", "F"]), IMPLICIT);
    assert.deepEqual(d.env, { CAPITAL_UNIT_YOCTO: "1000000000000000000000" });
    assert.match(d.lines.join(" "), /too small/);
  });

  it("both needed", () => {
    const d = diagnose(GOOD_TOKENS, all(["D", "E", "F"]), IMPLICIT);
    assert.deepEqual(d.env, { CROSS_CHAIN_SENDER: IMPLICIT, CAPITAL_UNIT_YOCTO: "1000000000000000000000" });
  });

  it("only the burn recipient works: blames the recipient, sets nothing", () => {
    const d = diagnose(GOOD_TOKENS, all(["E", "F"]), IMPLICIT);
    assert.deepEqual(d.env, {});
    assert.match(d.lines.join(" "), /did not like your recipient/);
  });

  it("only the docs' control works: blames the Base USDC side and names the real ids", () => {
    const t = { ...GOOD_TOKENS, ourDest: false, baseUsdc: ["nep141:base-0xREAL.omft.near"] };
    const d = diagnose(t, all(["F"]), IMPLICIT);
    const text = d.lines.join(" ");
    assert.match(text, /NOT in 1Click's token list.*nep141:base-0xREAL\.omft\.near/);
    assert.match(text, /Base USDC side/);
  });

  it("everything fails, even the control: says it is 1Click's side, quotes the messages, and that the cycle is unaffected", () => {
    const d = diagnose(GOOD_TOKENS, all([]), IMPLICIT);
    const text = d.lines.join(" ");
    assert.match(text, /even the docs' own example pair \(Internal server error\)/);
    assert.match(text, /ONECLICK_JWT/);
    assert.match(text, /cycle is unaffected/);
  });

  it("no answer at all is a network problem on this machine, not 1Click refusing", () => {
    const dead = ["A", "B", "C", "D", "E", "F"].map((k) => ({ ...res(k as any, false, "no answer (fetch failed)"), status: null }));
    const d = diagnose({ reachable: false, error: "fetch failed", count: 0, wrapNear: false, ourDest: false, baseUsdc: [] }, dead, IMPLICIT);
    const text = d.lines.join(" ");
    assert.match(text, /No request got an answer from 1Click at all/);
    assert.match(text, /this machine's network/);
    assert.ok(!/rejected every variant/.test(text));
  });

  it("says nothing false when the token list could not be read and nothing quoted", () => {
    const d = diagnose({ reachable: false, error: "ENOTFOUND", count: 0, wrapNear: false, ourDest: false, baseUsdc: [] }, [], null);
    assert.match(d.lines.join(" "), /Nothing conclusive/);
  });
});
