/**
 * Phase 6 checks for the private decision path.
 *
 *   npm run tee:check
 *       Dry run: one private decision (NEAR AI TEE if NEAR_AI_API_KEY is set,
 *       otherwise the local rule), fully verified, printed. Nothing is
 *       committed on-chain and no sub reports.
 *
 *   npm run tee:check -- --record data/runtime/public/<cycle>.json
 *       Independent check of a PUBLIC record, using only what is public:
 *         - recompute decision_hash from the record
 *         - recover the enclave signer from (model:request_hash:response_hash)
 *         - ask NEAR AI for a FRESH attestation of that signer with our own
 *           nonce, and verify it (TDX binding + Intel quote + NVIDIA GPU)
 *       No API key, prompt or reasoning needed for the first two; the third
 *       needs NEAR_AI_API_KEY only to call the attestation endpoint.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashDecision } from "../memory.js";
import { decidePrivately } from "../private/decide.js";
import { fetchAttestation } from "../private/nearAi.js";
import { checkBinding, checkGpu, checkTdxQuote, recoverEip191Address } from "../private/teeVerify.js";
import { readFakeSwarmState, swarmScenario } from "../subAgents.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(REPO_ROOT, "data/runtime"));
const line = (s = "") => console.log(s);
const mark = (ok: boolean) => (ok ? "OK  " : "FAIL");

async function dryRun() {
  const apiKey = process.env.NEAR_AI_API_KEY || undefined;
  const verify = process.env.TEE_VERIFY === "signature" ? "signature" : "full";
  line(`\nPrivate decision dry run (nothing goes on-chain)`);
  line(`  path:     ${apiKey ? `NEAR AI Cloud TEE, model ${process.env.NEAR_AI_MODEL || "Qwen/Qwen3.8-27B"}, verify=${verify}` : "local policy (NEAR_AI_API_KEY not set)"}`);
  line(`  scenario: ${swarmScenario()} (SIMULATED swarm state)\n`);
  const t0 = Date.now();
  const out = await decidePrivately(`dryrun-${new Date().toISOString()}`, readFakeSwarmState(), {
    apiKey, model: process.env.NEAR_AI_MODEL || undefined, verify, dataDir: DATA_DIR,
  });
  line(`Decisions (after policy guard, ${out.guardAdjustments} adjustment(s)):`);
  for (const d of out.decisions) {
    line(d.action === "PAUSE"
      ? `  ${d.sub}: PAUSE (${d.reason_code})`
      : `  ${d.sub}: ${d.action.padEnd(8)} target ${d.target_capital}, max_position ${d.max_position}, max_loss ${d.max_loss_cycle}`);
  }
  if (out.tee) {
    const c = out.tee.checks;
    line(`\nTEE evidence (public):`);
    line(`  chat id         ${out.tee.chat_id}`);
    line(`  signer          ${out.tee.signing_address} (${out.tee.signature_kind})`);
    line(`  [${mark(c.hashes_match)}] request/response hashes match the signed text`);
    line(`  [${mark(c.signature_valid)}] ECDSA signature recovers to the signer`);
    line(`  [${mark(c.provider_tee && c.model_matches)}] provider_tee signature for ${out.tee.model}`);
    line(`  [${mark(c.binds_address && c.binds_nonce)}] Intel TDX report_data = signer + our fresh nonce`);
    line(c.tdx === "not_checked" ? `  [skip] Intel TDX quote (TEE_VERIFY=signature)` : `  [${mark(c.tdx.verified)}] Intel TDX quote verified, TCB status ${c.tdx.status}`);
    line(c.gpu === "not_checked" ? `  [skip] NVIDIA GPU attestation (TEE_VERIFY=signature)` : `  [${mark(c.gpu.verdict && c.gpu.token_signature_valid)}] NVIDIA NRAS GPU attestation, token signature checked`);
  }
  line(`\nprivate_commitment ${out.privateCommitment}`);
  line(`private blob       ${out.privateFile}  (local only)`);
  line(`\nDRY RUN OK in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

async function checkRecord(file: string) {
  const rec = JSON.parse(readFileSync(file, "utf8"));
  line(`\nChecking public record ${file}`);
  const { decision_hash, ...rest } = rec;
  const hashOk = hashDecision(rest) === decision_hash;
  line(`  [${mark(hashOk)}] decision_hash recomputes: ${decision_hash}`);
  line(`  decision_path: ${rec.decision_path ?? "(schema v1, none)"}`);
  let ok = hashOk;
  if (rec.decision_path === "near-ai-tee" && rec.tee) {
    const t = rec.tee;
    const text = `${t.model}:${t.request_hash}:${t.response_hash}`;
    let signer = "";
    try { signer = recoverEip191Address(text, t.signature); } catch { /* invalid */ }
    const sigOk = signer.toLowerCase() === String(t.signing_address).toLowerCase();
    line(`  [${mark(sigOk)}] enclave signature over "${t.model}:<req>:<resp>" recovers to ${t.signing_address}`);
    ok &&= sigOk;
    const apiKey = process.env.NEAR_AI_API_KEY;
    if (!apiKey) {
      line(`  [skip] fresh attestation of the signer (set NEAR_AI_API_KEY to call the attestation endpoint)`);
    } else {
      const nonce = randomBytes(32).toString("hex");
      const att = await fetchAttestation(apiKey, t.model, t.signing_address, nonce);
      const b = checkBinding(att, nonce);
      line(`  [${mark(b.binds_address && b.binds_nonce)}] fresh TDX quote binds this signer to our nonce ${nonce.slice(0, 12)}...`);
      const tdx = await checkTdxQuote(att.intel_quote);
      line(`  [${mark(tdx.verified)}] Intel TDX quote verified, TCB status ${tdx.status}`);
      const gpu = await checkGpu(att, nonce);
      line(`  [${mark(gpu.verdict && gpu.token_signature_valid)}] NVIDIA GPU attestation${gpu.reason ? ` (${gpu.reason})` : ""}`);
      ok &&= b.binds_address && b.binds_nonce && tdx.verified && gpu.verdict && gpu.token_signature_valid;
    }
  }
  line(`\n${ok ? "RECORD OK" : "RECORD FAILED"}\n`);
  process.exitCode = ok ? 0 : 1;
}

const i = process.argv.indexOf("--record");
(i >= 0 ? checkRecord(process.argv[i + 1] ?? "") : dryRun()).catch((err) => {
  console.error(`\ntee:check failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
