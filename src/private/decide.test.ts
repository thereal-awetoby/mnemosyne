/**
 * Phase 6 offline tests: policy guard, strict parsing, commitments, and the
 * whole TEE path against a FAKE NEAR AI server that signs with a real
 * secp256k1 key (EIP-191) and returns a synthetic TDX quote. The Intel/NVIDIA
 * checks need the network, so these tests run with verify: "signature";
 * the live run (npm run tee:check) covers them.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { FakeSubState } from "../subAgents.js";
import { checkBinding, checkSignature, recoverEip191Address, sha256Hex } from "./teeVerify.js";

const MODEL = "Qwen/Qwen3.8-27B";
const calm: FakeSubState[] = [
  { sub: "A", capital: 1000, lastCycleLoss: 0 },
  { sub: "B", capital: 1000, lastCycleLoss: 0 },
  { sub: "C", capital: 1000, lastCycleLoss: 0 },
];

// ---- a fake enclave key, signing like NEAR AI Cloud does
const sk = secp256k1.utils.randomSecretKey();
const address = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(sk, false).subarray(1)).subarray(12)).toString("hex");
function eip191Sign(text: string, key = sk): string {
  const msg = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const sig = secp256k1.sign(keccak_256(new Uint8Array([...prefix, ...msg])), key, { prehash: false, format: "recovered" });
  return "0x" + Buffer.concat([Buffer.from(sig.subarray(1)), Buffer.from([sig[0] + 27])]).toString("hex");
}
function fakeQuote(addr: string, nonceHex: string): string {
  const q = Buffer.alloc(48 + 584);
  q.writeUInt16LE(4, 0);
  q.writeUInt32LE(0x81, 4);
  Buffer.from(addr.slice(2), "hex").copy(q, 48 + 520);
  Buffer.from(nonceHex, "hex").copy(q, 48 + 552);
  return q.toString("hex");
}

// ---- fake NEAR AI Cloud. `mode` lets a test break one thing at a time.
let mode: "ok" | "tamper" | "wrong-signer" | "bad-binding" | "wrong-model" | "prose" = "ok";
let lastPrompt = "";
const chats = new Map<string, { req: string; resp: string }>();
let server: Server;
let dataDir = "";
let decide: typeof import("./decide.js");

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://x");
    const json = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(typeof o === "string" ? o : JSON.stringify(o)); };
    if (url.pathname === "/v1/chat/completions") {
      lastPrompt = body;
      const id = `chat-${chats.size + 1}`;
      const answer = mode === "prose" ? "I think you should keep everything." : JSON.stringify({
        decisions: [
          { sub: "A", action: "INCREASE", target_capital: 5000, reason: "greedy" },
          { sub: "B", action: "KEEP", target_capital: 1000, reason: "ok" },
          { sub: "C", action: "INCREASE", target_capital: 1200, reason: "should be blocked" },
        ],
        summary: "test",
      });
      const resp = JSON.stringify({ id, model: mode === "wrong-model" ? "other/model" : MODEL, choices: [{ message: { content: answer, reasoning_content: "secret reasoning" }, finish_reason: "stop" }], usage: {} });
      chats.set(id, { req: body, resp });
      return json(resp);
    }
    const m = url.pathname.match(/^\/v1\/signature\/(.+)$/);
    if (m) {
      const c = chats.get(m[1])!;
      const respHash = mode === "tamper" ? sha256Hex(c.resp + " ") : sha256Hex(c.resp);
      const text = `${MODEL}:${sha256Hex(c.req)}:${respHash}`;
      const signature = mode === "wrong-signer" ? eip191Sign(text, secp256k1.utils.randomSecretKey()) : eip191Sign(text);
      return json({ text, signature, signing_address: address, signing_algo: "ecdsa", signature_kind: "provider_tee" });
    }
    if (url.pathname === "/v1/attestation/report") {
      const nonce = mode === "bad-binding" ? "00".repeat(32) : url.searchParams.get("nonce")!;
      return json({ model_attestations: [{ signing_address: address, intel_quote: fakeQuote(address, nonce) }] });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  process.env.NEAR_AI_BASE_URL = `http://127.0.0.1:${port}`;
  decide = await import("./decide.js");
  dataDir = mkdtempSync(join(tmpdir(), "mnemo-private-"));
});
after(() => { server.close(); rmSync(dataDir, { recursive: true, force: true }); });

const opts = () => ({ apiKey: "sk-test", model: MODEL, verify: "signature" as const, dataDir });

describe("policy guard", () => {
  it("forces PAUSE past the loss threshold, whatever the model says", () => {
    const { decisions, adjustments } = decide.policyGuard(
      [{ sub: "A", action: "KEEP", target_capital: 1000, reason: "" }, { sub: "B", action: "KEEP", target_capital: 1000, reason: "" }, { sub: "C", action: "INCREASE", target_capital: 1200, reason: "" }],
      [calm[0], calm[1], { sub: "C", capital: 1000, lastCycleLoss: 150 }], decide.DEFAULT_ENVELOPE);
    assert.equal(decisions[2].action, "PAUSE");
    assert.equal(decisions[2].reason_code, "local_loss_limit");
    assert.ok(adjustments.some((a) => a.includes("forced PAUSE")));
  });
  it("clamps growth, keeps C reduce-only, caps total exposure, relabels actions", () => {
    const { decisions } = decide.policyGuard(
      [{ sub: "A", action: "INCREASE", target_capital: 5000, reason: "" }, { sub: "B", action: "CUT", target_capital: 1200, reason: "" }, { sub: "C", action: "INCREASE", target_capital: 1200, reason: "" }],
      calm, decide.DEFAULT_ENVELOPE);
    const [a, b, c] = decisions;
    // A clamped to 1250 (1000 * 1.25), C (reduce-only) to 1000; then the swarm
    // total 1250+1200+1000 = 3450 > 3000 scales every active target by 3000/3450
    assert.equal(a.target_capital, String(Math.floor(1250 * 3000 / 3450)));
    assert.equal(b.action, "INCREASE");     // "CUT" to 1200 is really an increase
    assert.equal(c.action, "CUT");          // never above its current capital
    assert.ok(Number(c.target_capital) <= 1000);
    const total = decisions.reduce((t, d) => t + Number(d.target_capital ?? 0), 0);
    assert.ok(total <= decide.DEFAULT_ENVELOPE.max_total_exposure, `total ${total}`);
    assert.equal(a.max_position, String(Math.floor(Number(a.target_capital) * 0.2)));
  });
  it("pauses a sub the model forgot or gave a nonsense action", () => {
    const { decisions } = decide.policyGuard([{ sub: "A", action: "YOLO" as any, target_capital: 1, reason: "" }], calm, decide.DEFAULT_ENVELOPE);
    assert.deepEqual(decisions.map((d) => d.action), ["PAUSE", "PAUSE", "PAUSE"]);
  });
});

describe("parsing model output", () => {
  it("accepts JSON wrapped in prose / fences", () => {
    const { proposals } = decide.parseProposals('ok:\n```json\n{"decisions":[{"sub":"A","action":"keep","target_capital":1},{"sub":"B","action":"CUT","target_capital":1},{"sub":"C","action":"PAUSE","target_capital":0}]}\n```');
    assert.equal(proposals[0].action, "KEEP");
  });
  it("rejects missing or duplicated subs", () => {
    assert.throws(() => decide.parseProposals('{"decisions":[{"sub":"A"},{"sub":"A"},{"sub":"B"}]}'), /exactly A, B, C/);
    assert.throws(() => decide.parseProposals("no json here"), /no JSON/);
  });
});

describe("TEE evidence", () => {
  it("EIP-191 recovery matches our signer", () => {
    assert.equal(recoverEip191Address("hello", eip191Sign("hello")), address);
  });
  it("checkSignature and checkBinding catch every single tampering", () => {
    const req = '{"a":1}', resp = '{"b":2}';
    const text = `${MODEL}:${sha256Hex(req)}:${sha256Hex(resp)}`;
    const sig = { text, signature: eip191Sign(text), signing_address: address, signing_algo: "ecdsa", signature_kind: "provider_tee" };
    const ok = checkSignature(sig, MODEL, req, resp);
    assert.ok(ok.hashes_match && ok.signature_valid && ok.provider_tee && ok.model_matches);
    assert.equal(checkSignature(sig, MODEL, req, resp + " ").hashes_match, false);
    assert.equal(checkSignature({ ...sig, signature: eip191Sign(text + "x") }, MODEL, req, resp).signature_valid, false);
    assert.equal(checkSignature({ ...sig, signature_kind: "gateway" }, MODEL, req, resp).provider_tee, false);
    assert.equal(checkSignature(sig, "other/model", req, resp).model_matches, false);
    const nonce = "ab".repeat(32);
    assert.deepEqual(checkBinding({ signing_address: address, intel_quote: fakeQuote(address, nonce) }, nonce), { binds_address: true, binds_nonce: true });
    assert.equal(checkBinding({ signing_address: address, intel_quote: fakeQuote(address, nonce) }, "cd".repeat(32)).binds_nonce, false);
  });
});

describe("decidePrivately against a fake NEAR AI enclave", () => {
  it("verifies, guards, commits privately, and keeps reasoning out of the public outcome", async () => {
    mode = "ok";
    const out = await decide.decidePrivately("cycle-1", calm, { ...opts(), lessons: ["never delete the last key"] });
    assert.equal(out.path, "near-ai-tee");
    assert.equal(out.tee!.signing_address, address);
    assert.deepEqual(decide.teeFailures(out.tee!), []);
    assert.equal(out.tee!.checks.tdx, "not_checked");
    assert.ok(out.guardAdjustments > 0, "greedy proposal must be clamped");
    assert.match(lastPrompt, /never delete the last key/);
    assert.match(lastPrompt, /request_salt/);
    // the public pieces carry no reasoning
    const pub = JSON.stringify({ d: out.decisions, t: out.tee, c: out.privateCommitment });
    assert.ok(!pub.includes("secret reasoning") && !pub.includes("greedy"));
    // the private blob does, and its commitment checks out
    const blob = JSON.parse(readFileSync(out.privateFile, "utf8"));
    assert.equal(blob.privateDecision.model_output.reasoning, "secret reasoning");
    assert.ok(decide.verifyCommitment(blob.salt, blob.privateDecision, out.privateCommitment));
    assert.ok(!decide.verifyCommitment(blob.salt, { ...blob.privateDecision, path: "x" }, out.privateCommitment));
  });

  for (const [m, re] of [
    ["tamper", /hashes_match/],
    ["wrong-signer", /signature_valid/],
    ["bad-binding", /binds_nonce/],
    ["wrong-model", /answered with model/],
    ["prose", /no JSON/],
  ] as const) {
    it(`fails closed: ${m}`, async () => {
      mode = m;
      await assert.rejects(decide.decidePrivately(`cycle-${m}`, calm, opts()), re);
    });
  }

  it("falls back to the labelled local policy without a key", async () => {
    const out = await decide.decidePrivately("cycle-local", [calm[0], calm[1], { sub: "C", capital: 900, lastCycleLoss: 120 }], { dataDir });
    assert.equal(out.path, "local-policy");
    assert.equal(out.tee, null);
    assert.equal(out.decisions[2].action, "PAUSE");
  });
});
