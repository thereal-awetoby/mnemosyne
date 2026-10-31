/**
 * Phase 6: the governor's private decision path.
 *
 *   near-ai-tee   the decision is reasoned by a model running inside a NEAR AI
 *                 Cloud TEE (Intel TDX + NVIDIA confidential GPU). The answer
 *                 is signed inside the enclave; we verify the signature, the
 *                 TDX quote and the GPU attestation (src/private/teeVerify.ts).
 *   local-policy  no API key: a deterministic local rule. Labeled as such.
 *
 * Either way the output goes through policyGuard(): public, deterministic
 * limits the model can never exceed. The model proposes; the guard disposes.
 *
 * What is private vs public:
 *   private  full prompt (swarm state, memory lessons), the model's reasoning,
 *            its raw proposal, guard adjustments  -> data/runtime/private/
 *   public   the guarded decisions + limits, a salted commitment to the
 *            private blob, and TEE evidence (hashes, signature, attestation
 *            results) that reveals nothing about the reasoning
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../x402/crypto.js";
import { SUB_AGENTS, type FakeSubState } from "../subAgents.js";
import type { SubAction, SubDecision, SubId } from "../types.js";
import { chat, fetchAttestation, fetchSignature } from "./nearAi.js";
import { checkBinding, checkGpu, checkSignature, checkTdxQuote, sha256Hex } from "./teeVerify.js";

export interface RiskEnvelope {
  max_total_exposure: number;
  max_daily_loss: number;
  /** a sub whose last-cycle loss exceeds this is always paused */
  pause_loss_threshold: number;
  /** no sub may be allocated more than this */
  per_sub_max_capital: number;
  /** a sub may grow at most this factor per cycle */
  max_growth: number;
  max_position_pct: number;
  max_loss_pct: number;
}

export const DEFAULT_ENVELOPE: RiskEnvelope = {
  max_total_exposure: 3000,
  max_daily_loss: 150,
  pause_loss_threshold: 100,
  per_sub_max_capital: 1500,
  max_growth: 1.25,
  max_position_pct: 0.2,
  max_loss_pct: 0.05,
};

export interface Proposal { sub: SubId; action: SubAction; target_capital: number; reason: string }

export interface TeeEvidence {
  provider: "near-ai-cloud";
  model: string;
  chat_id: string;
  signing_address: string;
  signature_kind: string | null;
  signature: string;
  request_hash: string;
  response_hash: string;
  checks: {
    hashes_match: boolean;
    signature_valid: boolean;
    provider_tee: boolean;
    model_matches: boolean;
    binds_address: boolean;
    binds_nonce: boolean;
    tdx: { verified: boolean; status: string } | "not_checked";
    gpu: { verdict: boolean; token_signature_valid: boolean } | "not_checked";
  };
}

export interface DecisionOutcome {
  decisions: SubDecision[];
  path: "near-ai-tee" | "local-policy";
  privateCommitment: string;
  privateFile: string;
  guardAdjustments: number;
  tee: TeeEvidence | null;
  privateDecision: Record<string, unknown>;
}

// ---------------------------------------------------------------- guard

const ACTIONS: SubAction[] = ["KEEP", "INCREASE", "CUT", "PAUSE"];

/** Deterministic, public limits. Returns final decisions + what it changed. */
export function policyGuard(proposals: Proposal[], state: FakeSubState[], env: RiskEnvelope): { decisions: SubDecision[]; adjustments: string[] } {
  const adjustments: string[] = [];
  const out: Array<{ sub: SubId; action: SubAction; target: number; reason_code?: string }> = [];

  for (const s of state) {
    const profile = SUB_AGENTS.find((a) => a.id === s.sub)!;
    const p = proposals.find((x) => x.sub === s.sub);
    if (!p) {
      adjustments.push(`${s.sub}: no proposal -> PAUSE`);
      out.push({ sub: s.sub, action: "PAUSE", target: 0, reason_code: "no_proposal" });
      continue;
    }
    if (s.lastCycleLoss > env.pause_loss_threshold) {
      if (p.action !== "PAUSE") adjustments.push(`${s.sub}: loss ${s.lastCycleLoss} > ${env.pause_loss_threshold} -> forced PAUSE`);
      out.push({ sub: s.sub, action: "PAUSE", target: 0, reason_code: "local_loss_limit" });
      continue;
    }
    if (!ACTIONS.includes(p.action)) {
      adjustments.push(`${s.sub}: invalid action -> PAUSE`);
      out.push({ sub: s.sub, action: "PAUSE", target: 0, reason_code: "invalid_action" });
      continue;
    }
    if (p.action === "PAUSE") {
      out.push({ sub: s.sub, action: "PAUSE", target: 0, reason_code: "governor_pause" });
      continue;
    }
    let target = Number.isFinite(p.target_capital) ? Math.floor(p.target_capital) : s.capital;
    const cap = Math.min(env.per_sub_max_capital, Math.floor(s.capital * env.max_growth));
    // defensive / reduce-only subs are never asked to take on more
    const ceiling = profile.mandate === "defensive_reduce_only" ? Math.min(cap, s.capital) : cap;
    if (target > ceiling) { adjustments.push(`${s.sub}: target ${target} > ceiling ${ceiling}`); target = ceiling; }
    if (target < 0) { adjustments.push(`${s.sub}: negative target`); target = 0; }
    out.push({ sub: s.sub, action: p.action, target });
  }

  // swarm-wide exposure cap: scale active targets down proportionally
  const total = out.reduce((t, d) => t + (d.action === "PAUSE" ? 0 : d.target), 0);
  if (total > env.max_total_exposure) {
    const f = env.max_total_exposure / total;
    adjustments.push(`total ${total} > ${env.max_total_exposure} -> scaled by ${f.toFixed(3)}`);
    for (const d of out) if (d.action !== "PAUSE") d.target = Math.floor(d.target * f);
  }

  const decisions: SubDecision[] = out.map((d) => {
    if (d.action === "PAUSE") return { sub: d.sub, action: "PAUSE", reason_code: d.reason_code ?? "governor_pause" };
    const s = state.find((x) => x.sub === d.sub)!;
    // the label must match the numbers
    const action: SubAction = d.target > s.capital ? "INCREASE" : d.target < s.capital ? "CUT" : "KEEP";
    if (action !== d.action) adjustments.push(`${d.sub}: ${d.action} relabelled ${action} (target ${d.target} vs capital ${s.capital})`);
    return {
      sub: d.sub,
      action,
      target_capital: String(d.target),
      max_position: String(Math.floor(d.target * env.max_position_pct)),
      max_loss_cycle: String(Math.floor(d.target * env.max_loss_pct)),
      mandate: SUB_AGENTS.find((a) => a.id === d.sub)!.mandate,
    };
  });
  return { decisions, adjustments };
}

// ------------------------------------------------------------- proposers

/** Deterministic fallback when no TEE model is configured. */
export function localPolicy(state: FakeSubState[]): Proposal[] {
  return state.map((s) => {
    if (s.lastCycleLoss > 100) return { sub: s.sub, action: "PAUSE", target_capital: 0, reason: "loss limit" };
    if (s.lastCycleLoss > 40) return { sub: s.sub, action: "CUT", target_capital: Math.floor(s.capital * 0.8), reason: "elevated loss" };
    return { sub: s.sub, action: "KEEP", target_capital: s.capital, reason: "within limits" };
  });
}

export function buildPrompt(state: FakeSubState[], env: RiskEnvelope, lessons: string[], salt: string) {
  const system = [
    "You are the private decision core of Mnemosyne, a NON-TRADING governor that allocates capital to three narrow sub-agents.",
    "For each sub choose KEEP, INCREASE, CUT or PAUSE and a target_capital (integer). Be conservative: protecting capital beats growth.",
    "target_capital is the sub's whole allocation. Its per-trade max_position (max_position_pct of target) and per-cycle max_loss (max_loss_pct of target) are derived automatically; do not shrink the target to fit them.",
    "Hard limits are enforced after you answer; proposals outside them are clamped, so stay inside them.",
    "Think briefly (a few short paragraphs at most), then answer.",
    'Respond with ONLY a JSON object, no prose, no code fences: {"decisions":[{"sub":"A","action":"KEEP","target_capital":1000,"reason":"<=12 words"}, ...for A, B and C],"summary":"<=25 words"}',
  ].join("\n");
  const user = JSON.stringify({
    request_salt: salt, // makes the public request hash unguessable
    subs: state.map((s) => ({ ...s, mandate: SUB_AGENTS.find((a) => a.id === s.sub)!.mandate })),
    risk_envelope: env,
    lessons_from_memory: lessons,
  });
  return [{ role: "system" as const, content: system }, { role: "user" as const, content: user }];
}

/** Extract and validate the model's JSON. Throws on anything malformed. */
export function parseProposals(content: string): { proposals: Proposal[]; summary: string } {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model output has no JSON object");
  const j = JSON.parse(content.slice(start, end + 1));
  if (!Array.isArray(j.decisions)) throw new Error("model output missing decisions[]");
  const proposals: Proposal[] = j.decisions.map((d: any) => ({
    sub: String(d.sub) as SubId,
    action: String(d.action).toUpperCase() as SubAction,
    target_capital: Number(d.target_capital),
    reason: String(d.reason ?? "").slice(0, 200),
  }));
  const subs = proposals.map((p) => p.sub).sort().join("");
  if (subs !== "ABC") throw new Error(`model must decide exactly A, B, C once each (got ${subs || "none"})`);
  return { proposals, summary: String(j.summary ?? "").slice(0, 300) };
}

// ---------------------------------------------------------------- main

export interface DecideOptions {
  apiKey?: string;
  model?: string;
  /** "full" (default): signature + TDX + GPU; "signature": skip TDX/GPU, labeled not_checked */
  verify?: "full" | "signature";
  dataDir: string;
  env?: RiskEnvelope;
  lessons?: string[];
  /** completion budget incl. reasoning tokens (default 8000) */
  maxTokens?: number;
}

export async function decidePrivately(cycleId: string, state: FakeSubState[], opts: DecideOptions): Promise<DecisionOutcome> {
  const env = opts.env ?? DEFAULT_ENVELOPE;
  const lessons = opts.lessons ?? [];
  let proposals: Proposal[];
  let tee: TeeEvidence | null = null;
  let modelOutput: Record<string, unknown> = {};

  if (opts.apiKey) {
    const model = opts.model ?? "Qwen/Qwen3.8-27B";
    const salt = randomBytes(32).toString("hex");
    const res = await chat(opts.apiKey, model, buildPrompt(state, env, lessons, salt), opts.maxTokens ?? 8000);
    const parsed = parseProposals(res.content);
    proposals = parsed.proposals;

    // ---- verify before trusting anything the enclave said
    const sig = await fetchSignature(opts.apiKey, res.id, model);
    const sc = checkSignature(sig, model, res.rawRequest, res.rawResponse);
    const nonce = randomBytes(32).toString("hex");
    const att = await fetchAttestation(opts.apiKey, model, sc.signing_address, nonce);
    const bind = checkBinding(att, nonce);
    const full = (opts.verify ?? "full") === "full";
    const tdx = full ? await checkTdxQuote(att.intel_quote) : "not_checked" as const;
    const gpuRaw = full ? await checkGpu(att, nonce) : null;
    const gpu = gpuRaw ? { verdict: gpuRaw.verdict && gpuRaw.nonce_matches, token_signature_valid: gpuRaw.token_signature_valid } : "not_checked" as const;

    tee = {
      provider: "near-ai-cloud",
      model,
      chat_id: res.id,
      signing_address: sc.signing_address,
      signature_kind: sig.signature_kind ?? null,
      signature: sig.signature,
      request_hash: sc.request_hash,
      response_hash: sc.response_hash,
      checks: { ...pick(sc), ...bind, tdx, gpu },
    };
    const failures = teeFailures(tee);
    if (failures.length) throw new Error(`TEE verification failed (fail-closed): ${failures.join(", ")}`);
    modelOutput = { summary: parsed.summary, reasoning: res.reasoning, raw_content: res.content, usage: res.usage, request_salt: salt };
  } else {
    proposals = localPolicy(state);
  }

  const { decisions, adjustments } = policyGuard(proposals, state, env);
  const path = tee ? "near-ai-tee" : "local-policy";
  const privateDecision = {
    cycle_id: cycleId,
    path,
    inputs: { swarm_state: state, risk_envelope: env, lessons },
    proposals,
    model_output: modelOutput,
    guard_adjustments: adjustments,
    final_decisions: decisions,
  };

  // salted commitment: binds the private blob without revealing it; the salt
  // stays private so the blob can be revealed (and checked) later if needed
  const salt = randomBytes(32).toString("hex");
  const privateCommitment = "sha256:" + sha256Hex(`${salt}:${canonicalJson(privateDecision)}`);
  const dir = join(opts.dataDir, "private");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const privateFile = join(dir, `${cycleId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  writeFileSync(privateFile, JSON.stringify({ salt, private_commitment: privateCommitment, privateDecision }, null, 2), { mode: 0o600 });

  return { decisions, path, privateCommitment, privateFile, guardAdjustments: adjustments.length, tee, privateDecision };
}

function pick(sc: ReturnType<typeof checkSignature>) {
  return { hashes_match: sc.hashes_match, signature_valid: sc.signature_valid, provider_tee: sc.provider_tee, model_matches: sc.model_matches };
}

export function teeFailures(t: TeeEvidence): string[] {
  const c = t.checks;
  const f: string[] = [];
  for (const k of ["hashes_match", "signature_valid", "provider_tee", "model_matches", "binds_address", "binds_nonce"] as const) if (!c[k]) f.push(k);
  if (c.tdx !== "not_checked" && !c.tdx.verified) f.push(`tdx(${c.tdx.status})`);
  if (c.gpu !== "not_checked" && !c.gpu.verdict) f.push("gpu_verdict");
  if (c.gpu !== "not_checked" && !c.gpu.token_signature_valid) f.push("gpu_token_signature");
  return f;
}

/** Re-check a revealed private blob against its public commitment. */
export function verifyCommitment(salt: string, privateDecision: unknown, commitment: string): boolean {
  return commitment === "sha256:" + sha256Hex(`${salt}:${canonicalJson(privateDecision)}`);
}
