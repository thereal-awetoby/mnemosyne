/**
 * Minimal x402 client for agents paying Mnemosyne (or a server using the
 * same NEAR authorization scheme). Request, get 402, sign the quoted terms,
 * retry. Never sign a resource different from the URL actually requested.
 */

import { randomBytes } from "node:crypto";
import { b64json, fromB64json, publicKeyOfSecret, signMessage } from "./crypto.js";
import { authorizationMessage } from "./facilitator.js";
import { parseBaseUnits, requirementsError, settlementError } from "./validation.js";
import {
  X402_VERSION,
  type MockAuthorization,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;

export interface Payer {
  accountId: string;
  secretKey: string;
}

export interface PaymentLimits {
  maxAmount: bigint;
  allowedPayTo?: string[];
  allowedNetworks?: string[];
}

function checkLimits(req: PaymentRequirements, limits: PaymentLimits): void {
  const error = requirementsError(req);
  if (error) throw new Error(`refusing payment: ${error}`);
  if (req.asset !== "NEAR") throw new Error(`refusing unsupported asset ${req.asset}`);
  if (typeof limits.maxAmount !== "bigint" || limits.maxAmount < 0n) throw new Error("maxAmount must be a non-negative bigint");
  if (parseBaseUnits(req.amount) > limits.maxAmount) throw new Error(`price ${req.amount} exceeds limit ${limits.maxAmount}`);
  if (limits.allowedPayTo && !limits.allowedPayTo.includes(req.payTo)) throw new Error(`refusing to pay unknown recipient ${req.payTo}`);
  if (limits.allowedNetworks && !limits.allowedNetworks.includes(req.network)) throw new Error(`refusing unexpected network ${req.network}`);
}

export function buildPayment(
  req: PaymentRequirements,
  resourceUrl: string,
  payer: Payer,
  nowMs = Date.now(),
  limits: PaymentLimits = { maxAmount: parseBaseUnits(req.amount), allowedPayTo: [req.payTo], allowedNetworks: [req.network] }
): PaymentPayload {
  checkLimits(req, limits);
  const resource = new URL(resourceUrl);
  if (!["http:", "https:"].includes(resource.protocol) || resource.username || resource.password) {
    throw new Error("payment resource must be an HTTP(S) URL without credentials");
  }
  const now = Math.floor(nowMs / 1000);
  const authorization: MockAuthorization = {
    from: payer.accountId,
    to: req.payTo,
    value: req.amount,
    asset: req.asset,
    network: req.network,
    resource: resource.href,
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

/** POST JSON to an x402 endpoint, paying if asked. Refuses excessive prices,
 *  unknown recipients/networks, changed resource URLs, unsupported terms,
 *  redirects, and successful answers without a consistent settlement proof. */
export async function postWithPayment<T = any>(
  url: string,
  body: unknown,
  payer: Payer,
  limits: PaymentLimits
): Promise<PaidCallResult<T>> {
  const resource = new URL(url);
  if (!["http:", "https:"].includes(resource.protocol) || resource.username || resource.password) {
    throw new Error("payment URL must be HTTP(S) without credentials");
  }
  const requestBody = JSON.stringify(body);
  if (requestBody === undefined) throw new Error("request body must be JSON-serializable");
  const first = await fetch(resource, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (first.status !== 402) throw new Error(`expected 402 from ${resource.href}, got ${first.status}: ${await first.text()}`);
  const header = first.headers.get("payment-required");
  const quote: PaymentRequired = header ? fromB64json(header) : await first.json();
  if (quote?.x402Version !== X402_VERSION || !Array.isArray(quote.accepts) ||
      typeof quote.resource?.url !== "string") {
    throw new Error("invalid payment quote");
  }
  let quotedResource: URL;
  try { quotedResource = new URL(quote.resource.url); } catch { throw new Error("invalid payment resource URL"); }
  if (quotedResource.href !== resource.href) {
    throw new Error(`payment resource ${quotedResource.href} does not match requested URL ${resource.href}`);
  }
  const req = quote.accepts.find((r) => r?.scheme === "exact");
  if (!req) throw new Error("server offers no 'exact' payment option");
  checkLimits(req, limits);

  // Bind to the URL we requested, not an arbitrary URL supplied by the quote.
  const paymentHeader = b64json(buildPayment(req, resource.href, payer, Date.now(), limits));
  const paid = await fetch(resource, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": paymentHeader },
    body: requestBody,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const settleHeader = paid.headers.get("payment-response");
  const settlement = settleHeader ? fromB64json<SettlementResponse>(settleHeader) : null;
  const responseBody = await paid.json() as T;
  if (paid.status === 200) {
    const error = settlementError(settlement, req, payer.accountId);
    if (error) throw new Error(`payment settled with an invalid proof: ${error}`);
  }
  return { quote, status: paid.status, body: responseBody, settlement, paymentHeader };
}
