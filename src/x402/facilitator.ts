/**
 * x402 facilitators: the service that checks a payment and settles it.
 *
 * MockFacilitator (default) does every check a real one would -- signature,
 * payer identity, amount, recipient, network, resource binding, time window,
 * single-use nonce -- but "settles" by writing to a local ledger instead of
 * moving tokens. Every settlement id starts with "mock_" and every response
 * says mock:true, so nothing can pass it off as an on-chain transfer.
 *
 * HttpFacilitator talks to a real x402 facilitator's POST /verify and
 * POST /settle (same request/response shapes), for when one exists for NEAR.
 */

import { join } from "node:path";
import { JsonStore } from "./jsonStore.js";
import { parseBaseUnits, requirementsError } from "./validation.js";
import {
  canonicalJson,
  implicitAccountId,
  isImplicitAccountId,
  sha256Hex,
  verifyMessage,
} from "./crypto.js";
import {
  SIGNING_DOMAIN,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlementResponse,
  type VerifyResponse,
} from "./types.js";

export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse>;
}

/** Bytes the payer signs: domain tag + canonical JSON of the authorization. */
export function authorizationMessage(auth: PaymentPayload["payload"]["authorization"]): Buffer {
  return Buffer.from(SIGNING_DOMAIN + canonicalJson(auth), "utf8");
}

/** Optional hook: prove a NAMED payer account (e.g. agent.testnet) owns the
 *  public key, e.g. via NEAR view_access_key. Implicit accounts don't need it. */
export type KeyOwnershipCheck = (accountId: string, publicKey: string) => Promise<boolean>;

interface Ledger {
  /** nonce -> settlement id. Spent nonces are never accepted again. */
  spentNonces: Record<string, string>;
  settlements: Array<{
    id: string;
    payer: string;
    payTo: string;
    amount: string;
    asset: string;
    network: string;
    resource: string;
    nonce: string;
    at: string;
  }>;
}

const CLOCK_SKEW_SECONDS = 5;

export class MockFacilitator implements Facilitator {
  private ledger: JsonStore<Ledger>;

  constructor(
    dataDir: string,
    private readonly opts: { checkNamedAccountKey?: KeyOwnershipCheck; now?: () => number } = {}
  ) {
    this.ledger = new JsonStore<Ledger>(join(dataDir, "facilitator-ledger.json"), () => ({
      spentNonces: {},
      settlements: [],
    }));
  }

  private nowSeconds(): number {
    return Math.floor((this.opts.now ? this.opts.now() : Date.now()) / 1000);
  }

  async verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const bad = (invalidReason: string, payer: string | null = null): VerifyResponse => ({
      isValid: false,
      payer,
      invalidReason,
    });

    const requirementsIssue = requirementsError(req);
    if (requirementsIssue) return bad(requirementsIssue);
    if (!p || typeof p !== "object") return bad("invalid_payload");
    if (p.x402Version !== X402_VERSION) return bad("invalid_x402_version");
    const a = p.payload?.authorization;
    const publicKey = p.payload?.publicKey;
    const signature = p.payload?.signature;
    if (!a || typeof a !== "object" || Array.isArray(a) ||
        typeof publicKey !== "string" || typeof signature !== "string") return bad("invalid_payload");
    const payer = typeof a.from === "string" ? a.from : null;

    // The payer must have accepted exactly what we asked for.
    if (canonicalJson(p.accepted) !== canonicalJson(req)) return bad("requirements_mismatch", payer);

    if (a.to !== req.payTo) return bad("invalid_recipient", payer);
    if (a.asset !== req.asset) return bad("invalid_asset", payer);
    if (a.network !== req.network) return bad("invalid_network", payer);
    if (typeof a.resource !== "string" || a.resource.length === 0) return bad("invalid_resource", payer);
    if (!verifyMessage(publicKey, authorizationMessage(a), signature)) return bad("invalid_signature", payer);
    let value: bigint;
    try {
      value = parseBaseUnits(a.value);
    } catch {
      return bad("invalid_amount", payer);
    }
    if (value < BigInt(req.amount)) return bad("insufficient_amount", payer);
    if (value > BigInt(req.amount)) return bad("amount_mismatch", payer);

    const now = this.nowSeconds();
    if (!Number.isInteger(a.validAfter) || !Number.isInteger(a.validBefore)) return bad("invalid_time_window", payer);
    if (a.validAfter > now + CLOCK_SKEW_SECONDS) return bad("not_yet_valid", payer);
    if (a.validBefore <= now) return bad("expired", payer);
    if (a.validBefore - a.validAfter > req.maxTimeoutSeconds + CLOCK_SKEW_SECONDS) {
      return bad("time_window_too_long", payer);
    }

    if (typeof a.nonce !== "string" || !/^[0-9a-f]{32,128}$/.test(a.nonce)) return bad("invalid_nonce", payer);
    if (this.ledger.get().spentNonces[a.nonce]) return bad("nonce_already_used", payer);


    // Identity: the signing key must belong to the `from` account.
    if (!payer) return bad("invalid_payer", payer);
    if (isImplicitAccountId(payer)) {
      if (implicitAccountId(publicKey) !== payer) return bad("payer_key_mismatch", payer);
    } else if (this.opts.checkNamedAccountKey) {
      let ownsKey = false;
      try { ownsKey = await this.opts.checkNamedAccountKey(payer, publicKey); } catch { /* fail closed */ }
      if (ownsKey !== true) return bad("payer_key_mismatch", payer);
    } else {
      return bad("named_payer_unverifiable", payer);
    }

    return { isValid: true, payer, invalidReason: null };
  }

  async settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettlementResponse> {
    const v = await this.verify(p, req);
    if (!v.isValid) {
      return {
        success: false,
        transaction: null,
        network: req.network,
        payer: v.payer,
        amount: null,
        errorReason: v.invalidReason ?? "invalid",
      };
    }
    const a = p.payload.authorization;
    const id = "mock_" + sha256Hex(canonicalJson(p)).slice(0, 40);
    // Re-check and record in one synchronous step: no await between them, so
    // two concurrent settles of the same nonce can't both succeed.
    if (this.ledger.get().spentNonces[a.nonce]) {
      return { success: false, transaction: null, network: req.network, payer: v.payer, amount: null, errorReason: "nonce_already_used" };
    }
    this.ledger.update((l) => {
      l.spentNonces[a.nonce] = id;
      l.settlements.push({
        id,
        payer: a.from,
        payTo: a.to,
        amount: a.value,
        asset: a.asset,
        network: a.network,
        resource: a.resource,
        nonce: a.nonce,
        at: new Date(this.nowSeconds() * 1000).toISOString(),
      });
    });
    return { success: true, transaction: id, network: req.network, payer: a.from, amount: a.value };
  }
}

/** Client for a real x402 facilitator (POST {base}/verify, {base}/settle). */
export class HttpFacilitator implements Facilitator {
  constructor(private readonly baseUrl: string, private readonly apiKey?: string) {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("facilitator URL must be HTTP(S) without credentials, query, or fragment");
    }
  }

  private async post<T>(path: string, p: PaymentPayload, req: PaymentRequirements): Promise<T> {
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload: p, paymentRequirements: req }),
    });
    if (!res.ok) throw new Error(`facilitator ${path} HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async verify(p: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    try {
      return await this.post<VerifyResponse>("/verify", p, req);
    } catch (err) {
      return { isValid: false, payer: null, invalidReason: `facilitator_unreachable: ${(err as Error).message}` };
    }
  }

  async settle(p: PaymentPayload, req: PaymentRequirements): Promise<SettlementResponse> {
    try {
      return await this.post<SettlementResponse>("/settle", p, req);
    } catch (err) {
      return { success: false, transaction: null, network: req.network, payer: null, amount: null, errorReason: `facilitator_unreachable: ${(err as Error).message}` };
    }
  }
}
