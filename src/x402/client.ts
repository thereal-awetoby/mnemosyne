/**
 * Minimal x402 client for agents paying Mnemosyne (or any server using the
 * same mock NEAR scheme). No account signup, no API key: request, get 402,
 * sign the quoted price, retry.
 */

import { randomBytes } from "node:crypto";
import { b64json, fromB64json, publicKeyOfSecret, signMessage } from "./crypto.js";
import { authorizationMessage } from "./facilitator.js";
import {
  X402_VERSION,
  type MockAuthorization,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from "./types.js";

export interface Payer {
  accountId: string;
  secretKey: string;
}

export function buildPayment(req: PaymentRequirements, resourceUrl: string, payer: Payer, nowMs = Date.now()): PaymentPayload {
  const now = Math.floor(nowMs / 1000);
  const authorization: MockAuthorization = {
    from: payer.accountId,
    to: req.payTo,
    value: req.amount,
    asset: req.asset,
    network: req.network,
    resource: resourceUrl,
    validAfter: now - 1,
    validBefore: now + Math.min(req.maxTimeoutSeconds, 120),
    nonce: randomBytes(16).toString("hex"),
  };
  return {
    x402Version: X402_VERSION,
    accepted: req,
    payload: {
      authorization,
      publicKey: publicKeyOfSecret(payer.secretKey),
      signature: signMessage(payer.secretKey, authorizationMessage(authorization)),
    },
  };
}

export interface PaidCallResult<T> {
  quote: PaymentRequired;
  status: number;
  body: T;
  settlement: SettlementResponse | null;
  paymentHeader: string;
}

/** POST JSON to an x402 endpoint, paying if asked. Refuses to pay more than
 *  `maxAmount` (base units) or to anyone not in `allowedPayTo`. */
export async function postWithPayment<T = any>(
  url: string,
  body: unknown,
  payer: Payer,
  limits: { maxAmount: bigint; allowedPayTo?: string[] }
): Promise<PaidCallResult<T>> {
  const first = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (first.status !== 402) throw new Error(`expected 402 from ${url}, got ${first.status}: ${await first.text()}`);
  const header = first.headers.get("payment-required");
  const quote: PaymentRequired = header ? fromB64json(header) : await first.json();
  const req = quote.accepts.find((r) => r.scheme === "exact");
  if (!req) throw new Error("server offers no 'exact' payment option");
  if (BigInt(req.amount) > limits.maxAmount) throw new Error(`price ${req.amount} exceeds limit ${limits.maxAmount}`);
  if (limits.allowedPayTo && !limits.allowedPayTo.includes(req.payTo)) throw new Error(`refusing to pay unknown recipient ${req.payTo}`);

  const paymentHeader = b64json(buildPayment(req, quote.resource.url, payer));
  const paid = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": paymentHeader },
    body: JSON.stringify(body),
  });
  const settleHeader = paid.headers.get("payment-response");
  return {
    quote,
    status: paid.status,
    body: (await paid.json()) as T,
    settlement: settleHeader ? fromB64json<SettlementResponse>(settleHeader) : null,
    paymentHeader,
  };
}
