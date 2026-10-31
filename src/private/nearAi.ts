/**
 * Minimal NEAR AI Cloud client (https://cloud-api.near.ai/v1, OpenAI-style).
 *
 * Keeps the EXACT request and response bytes: the TEE signs
 * "{model}:{sha256(request bytes)}:{sha256(response bytes)}", so re-serialising
 * either side would break verification.
 */

import type { ModelAttestation, SignaturePayload } from "./teeVerify.js";

export const NEAR_AI_BASE = (process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai").replace(/\/$/, "");

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface ChatResult {
  id: string;
  model: string;
  rawRequest: string;
  rawResponse: string;
  content: string;
  reasoning: string;
  usage: unknown;
}

function auth(apiKey: string) {
  if (!apiKey.startsWith("sk-")) throw new Error("NEAR_AI_API_KEY must start with sk-");
  return { Authorization: `Bearer ${apiKey}` };
}

export async function chat(apiKey: string, model: string, messages: ChatMessage[], maxTokens = 2000): Promise<ChatResult> {
  const rawRequest = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 });
  const r = await fetch(`${NEAR_AI_BASE}/v1/chat/completions`, {
    method: "POST",
    // x-no-aliasing: the gateway must not silently route to another model
    headers: { ...auth(apiKey), "content-type": "application/json", "x-no-aliasing": "true" },
    body: rawRequest,
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  const rawResponse = await r.text();
  if (!r.ok) throw new Error(`NEAR AI chat HTTP ${r.status}: ${rawResponse.slice(0, 300)}`);
  const j = JSON.parse(rawResponse);
  if (j.model !== model) throw new Error(`NEAR AI answered with model ${j.model}, asked for ${model}`);
  const msg = j.choices?.[0]?.message ?? {};
  return {
    id: j.id,
    model: j.model,
    rawRequest,
    rawResponse,
    content: String(msg.content ?? ""),
    reasoning: String(msg.reasoning_content ?? msg.reasoning ?? ""),
    usage: j.usage,
  };
}

/** The signature can lag the completion by a moment; retry briefly. */
export async function fetchSignature(apiKey: string, chatId: string, model: string, tries = 6): Promise<SignaturePayload> {
  const url = `${NEAR_AI_BASE}/v1/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  let last = "";
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: auth(apiKey), signal: AbortSignal.timeout(30_000) });
    const body = await r.text();
    if (r.ok) {
      const s = JSON.parse(body);
      if (s?.text && s?.signature && s?.signing_address) return s;
      last = `incomplete signature payload: ${body.slice(0, 200)}`;
    } else {
      last = `HTTP ${r.status}: ${body.slice(0, 200)}`;
    }
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  throw new Error(`no TEE signature for ${chatId}: ${last}`);
}

/** Attestation for one signing key, bound to our fresh nonce. */
export async function fetchAttestation(apiKey: string, model: string, signingAddress: string, nonceHex: string): Promise<ModelAttestation> {
  const url = `${NEAR_AI_BASE}/v1/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonceHex}` +
    `&signing_algo=ecdsa&signing_address=${encodeURIComponent(signingAddress)}`;
  const r = await fetch(url, { headers: auth(apiKey), signal: AbortSignal.timeout(60_000) });
  const body = await r.text();
  if (!r.ok) throw new Error(`NEAR AI attestation HTTP ${r.status}: ${body.slice(0, 200)}`);
  const j = JSON.parse(body);
  const list: ModelAttestation[] = j.model_attestations ?? [j];
  const att = list.find((a) => a?.signing_address?.toLowerCase() === signingAddress.toLowerCase());
  if (!att) throw new Error(`attestation has no entry for signing address ${signingAddress}`);
  return att;
}
