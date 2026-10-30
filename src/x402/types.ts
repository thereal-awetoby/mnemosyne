/**
 * x402 v2 message shapes (https://docs.x402.org), with Mnemosyne's mock
 * NEAR payment scheme in the `payload`.
 *
 * Headers carry base64-encoded JSON:
 *   402 response   PAYMENT-REQUIRED   (PaymentRequired; also sent as the body)
 *   paid retry     PAYMENT-SIGNATURE  (PaymentPayload)
 *   200 response   PAYMENT-RESPONSE   (SettlementResponse)
 */

export const X402_VERSION = 2 as const;

/** Name of the transfer mechanism inside `extra`. Says "mock" on purpose:
 *  settlement is recorded by Mnemosyne's mock facilitator, not on-chain. */
export const MOCK_TRANSFER_METHOD = "mnemosyne-mock-ed25519-authorization";

export interface PaymentRequirements {
  scheme: "exact";
  /** CAIP-2 style network id. */
  network: string;
  /** Price in the asset's base units (yoctoNEAR for NEAR), as a string. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod: string;
    mock: boolean;
    note: string;
  };
}

export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: PaymentRequirements[];
}

/** What the payer signs. `resource` binds the payment to one endpoint so a
 *  payment for /memory/check can't be spent on another route. */
export interface MockAuthorization {
  from: string;
  to: string;
  value: string;
  asset: string;
  network: string;
  resource: string;
  /** unix seconds */
  validAfter: number;
  validBefore: number;
  /** random, single-use (replay protection) */
  nonce: string;
}

export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  accepted: PaymentRequirements;
  payload: {
    authorization: MockAuthorization;
    publicKey: string;
    signature: string;
  };
}

export interface VerifyResponse {
  isValid: boolean;
  payer: string | null;
  invalidReason: string | null;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string | null;
  network: string;
  payer: string | null;
  amount: string | null;
  errorReason?: string;
}

/** Domain tag prepended to the signed bytes so a signature made for this
 *  scheme can never be replayed as some other kind of signed message. */
export const SIGNING_DOMAIN = "mnemosyne-x402-v2:";
