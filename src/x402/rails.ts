/**
 * Payment rails: how /memory/check gets paid.
 *
 *   mock        Mnemosyne's own ed25519 authorization scheme, fully verified,
 *               settled into a local ledger (ids "mock_..."). Default; used by
 *               `npm test` and offline demos.
 *
 *   near-exact  The official x402 NEAR "exact" scheme (@x402/near via
 *               @fastnear/x402): the payer signs a NEP-366 delegate action for
 *               one NEP-141 ft_transfer (wNEAR on testnet) to payTo; our
 *               in-process facilitator verifies it and a relayer account
 *               submits it on-chain and pays the gas. The settlement id is a
 *               real NEAR transaction hash.
 *
 * The server only talks to this interface, so the 402 -> verify -> answer ->
 * settle -> receipt flow and every safety check around it is the same for both.
 */

import type { Facilitator } from "./facilitator.js";
import { b64json, fromB64json } from "./crypto.js";
import { settlementError } from "./validation.js";
import type { PaymentPayload, PaymentRequirements, SettlementResponse } from "./types.js";

/** Wire-level requirements: the mock rail's PaymentRequirements, or the
 *  official scheme's (whose `extra` has a different shape). */
export interface WireRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface RailVerify {
  isValid: boolean;
  payer: string | null;
  invalidReason: string | null;
}

export interface RailSettlement {
  success: boolean;
  transaction: string | null;
  network: string;
  payer: string | null;
  amount: string | null;
  errorReason?: string;
}

export interface PaymentRail {
  readonly mode: "mock" | "near-exact";
  readonly mock: boolean;
  readonly requirements: WireRequirements;
  /** Decode the PAYMENT-SIGNATURE header; throws on garbage. */
  decode(header: string): unknown;
  /** Reject a payment made for another endpoint or other terms before any
   *  facilitator work. Returns a 402 reason, or null if acceptable. */
  bindingError(payment: unknown, checkUrl: string): string | null;
  verify(payment: unknown): Promise<RailVerify>;
  settle(payment: unknown): Promise<RailSettlement>;
  /** A *successful* settlement whose proof is inconsistent -> 502 (never ask
   *  the payer to pay again). Null when the proof checks out. */
  settlementIssue(settlement: RailSettlement, verifiedPayer: string): string | null;
  /** PAYMENT-RESPONSE header value. */
  responseHeader(settlement: RailSettlement): string;
  /** Public link for a settlement id, if there is one. */
  explorerUrl(transaction: string): string | null;
}

// ---------------------------------------------------------------- mock rail

/** `mock` is false only when `facilitator` is an HttpFacilitator talking to a
 *  real facilitator that speaks Mnemosyne's authorization scheme. */
export function createMockRail(facilitator: Facilitator, requirements: PaymentRequirements, mock = true): PaymentRail {
  return {
    mode: "mock",
    mock,
    requirements: requirements as unknown as WireRequirements,
    decode: (header) => fromB64json<PaymentPayload>(header),
    bindingError(payment, checkUrl) {
      const p = payment as PaymentPayload | null;
      return p?.payload?.authorization?.resource === checkUrl ? null : "payment not bound to this resource";
    },
    async verify(payment) {
      const v = await facilitator.verify(payment as PaymentPayload, requirements);
      return { isValid: !!v?.isValid, payer: v?.payer ?? null, invalidReason: v?.invalidReason ?? null };
    },
    async settle(payment) {
      return (await facilitator.settle(payment as PaymentPayload, requirements)) as RailSettlement;
    },
    settlementIssue(settlement, verifiedPayer) {
      return settlementError(settlement as SettlementResponse, requirements, verifiedPayer);
    },
    responseHeader: (settlement) => b64json({ ...settlement, mock }),
    explorerUrl: () => null,
  };
}

// ---------------------------------------------------------- near-exact rail

export interface NearRailConfig {
  network: "near:testnet" | "near:mainnet";
  /** NEP-141 token contract, e.g. wrap.testnet (wNEAR). */
  asset: string;
  /** price in the token's smallest unit */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  relayer: { accountId: string; secretKey: string };
  rpcUrl: string;
  explorerBase?: string;
  /** Tests only: a simulated chain implementing @x402/near's
   *  FacilitatorNearSigner, used instead of the RPC-backed relayer. The
   *  official verification and settlement logic still runs unchanged. */
  facilitatorSigner?: import("@x402/near").FacilitatorNearSigner;
}

const NEAR_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** Loaded lazily so the mock path (and `npm test`) never imports the NEAR stack. */
export async function createNearExactRail(cfg: NearRailConfig): Promise<PaymentRail> {
  if (cfg.network === "near:mainnet") throw new Error("near-exact rail: mainnet is disabled in this build (testnet only)");
  if (!/^(0|[1-9][0-9]*)$/.test(cfg.amount) || BigInt(cfg.amount) <= 0n) throw new Error("near-exact rail: amount must be a positive integer string");
  if (!cfg.facilitatorSigner && (!cfg.relayer.accountId || !cfg.relayer.secretKey?.startsWith("ed25519:"))) {
    throw new Error("near-exact rail: relayer accountId and ed25519 secret key are required");
  }

  const [{ createNearFacilitator }, { createNearResourceServer }, http] = await Promise.all([
    import("@fastnear/x402/facilitator"),
    import("@fastnear/x402/server"),
    import("@x402/core/http"),
  ]);

  const facilitator = createNearFacilitator({
    registrations: [{
      network: cfg.network,
      signer: cfg.facilitatorSigner ?? {
        relayers: [{ accountId: cfg.relayer.accountId, secretKey: cfg.relayer.secretKey as `ed25519:${string}` }],
        rpcUrls: { [cfg.network]: cfg.rpcUrl },
      },
    }],
  });
  const resourceServer = createNearResourceServer({ facilitators: facilitator });
  await resourceServer.initialize();

  const built = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: cfg.network,
    payTo: cfg.payTo,
    price: { amount: cfg.amount, asset: cfg.asset },
    maxTimeoutSeconds: cfg.maxTimeoutSeconds,
  });
  if (built.length !== 1) throw new Error(`near-exact rail: expected 1 payment option, got ${built.length}`);
  const requirements = built[0] as unknown as WireRequirements;
  if (requirements.asset !== cfg.asset || requirements.amount !== cfg.amount || requirements.payTo !== cfg.payTo) {
    throw new Error("near-exact rail: built requirements do not match configuration");
  }
  const explorerBase = (cfg.explorerBase ?? "https://testnet.nearblocks.io").replace(/\/$/, "");

  return {
    mode: "near-exact",
    mock: false,
    requirements,
    decode: (header) => http.decodePaymentSignatureHeader(header),
    bindingError(payment, checkUrl) {
      const p = payment as { x402Version?: unknown; resource?: { url?: unknown }; accepted?: unknown; payload?: unknown } | null;
      if (!p || typeof p !== "object" || !p.payload || typeof p.payload !== "object") return "invalid_payment_payload";
      // x402 v2 clients echo the resource they were quoted; if present it must be ours.
      if (p.resource?.url !== undefined && p.resource.url !== checkUrl) return "payment not bound to this resource";
      if (!resourceServer.findMatchingRequirements([requirements as any], p as any)) return "requirements_mismatch";
      return null;
    },
    async verify(payment) {
      try {
        const v = await resourceServer.verifyPayment(payment as any, requirements as any);
        return { isValid: !!v.isValid, payer: v.payer ?? null, invalidReason: v.isValid ? null : (v.invalidReason ?? "invalid_payment") };
      } catch (err) {
        return { isValid: false, payer: null, invalidReason: `verify_failed: ${(err as Error).message}`.slice(0, 200) };
      }
    },
    async settle(payment) {
      try {
        const s = await resourceServer.settlePayment(payment as any, requirements as any);
        return {
          success: !!s.success,
          transaction: s.transaction || null,
          network: s.network,
          payer: s.payer ?? null,
          amount: s.amount ?? null,
          ...(s.success ? {} : { errorReason: s.errorReason ?? "settlement_failed" }),
        };
      } catch (err) {
        return { success: false, transaction: null, network: cfg.network, payer: null, amount: null, errorReason: `settle_failed: ${(err as Error).message}`.slice(0, 200) };
      }
    },
    settlementIssue(s, verifiedPayer) {
      if (!s.success) return s.errorReason ?? "settlement_failed";
      if (typeof s.transaction !== "string" || !NEAR_TX_HASH.test(s.transaction)) return "invalid_settlement_transaction";
      if (s.network !== requirements.network) return "settlement_network_mismatch";
      if (s.payer !== null && s.payer !== verifiedPayer) return "settlement_payer_mismatch";
      if (s.amount !== null && s.amount !== requirements.amount) return "settlement_amount_mismatch";
      return null;
    },
    responseHeader: (s) => http.encodePaymentResponseHeader({
      success: s.success,
      transaction: s.transaction ?? "",
      network: s.network as any,
      ...(s.payer ? { payer: s.payer } : {}),
      ...(s.amount ? { amount: s.amount } : {}),
    }),
    explorerUrl: (tx) => `${explorerBase}/txns/${tx}`,
  };
}
