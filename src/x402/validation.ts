/** Shared boundary validation for the custom NEAR authorization scheme. */

import {
  MOCK_TRANSFER_METHOD,
  type PaymentRequirements,
  type SettlementResponse,
} from "./types.js";

/** Do not coerce numbers, arrays, booleans, hex, or exponent notation to money. */
export function parseBaseUnits(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("amount must be a non-negative decimal integer string");
  }
  return BigInt(value);
}

/** Only accept terms this client / mock facilitator actually understands. */
export function requirementsError(value: unknown): string | null {
  if (!value || typeof value !== "object") return "invalid_requirements";
  const req = value as PaymentRequirements;
  if (req.scheme !== "exact") return "unsupported_scheme";
  if (typeof req.network !== "string" || !/^near:[a-z0-9-]+$/.test(req.network)) return "invalid_network";
  try {
    if (parseBaseUnits(req.amount) <= 0n) return "invalid_amount";
  } catch {
    return "invalid_amount";
  }
  if (typeof req.asset !== "string" || req.asset.length === 0) return "invalid_asset";
  if (typeof req.payTo !== "string" || req.payTo.length === 0) return "invalid_recipient";
  if (!Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0 || req.maxTimeoutSeconds > 86400) {
    return "invalid_timeout";
  }
  if (!req.extra || req.extra.assetTransferMethod !== MOCK_TRANSFER_METHOD ||
      typeof req.extra.mock !== "boolean" || typeof req.extra.note !== "string") {
    return "unsupported_transfer_method";
  }
  return null;
}

/** Validate a settlement before releasing an answer or trusting a receipt.
 *  A successful transfer with inconsistent terms must not trigger another pay. */
export function settlementError(
  value: unknown,
  req: PaymentRequirements,
  expectedPayer: string
): string | null {
  if (!value || typeof value !== "object") return "invalid_settlement_response";
  const settlement = value as SettlementResponse;
  if (typeof settlement.success !== "boolean") return "invalid_settlement_response";
  if (!settlement.success) return settlement.errorReason ?? "settlement_failed";
  if (typeof settlement.transaction !== "string" || settlement.transaction.length === 0 ||
      settlement.transaction.length > 256) return "invalid_settlement_transaction";
  if (settlement.network !== req.network) return "settlement_network_mismatch";
  if (settlement.payer !== expectedPayer) return "settlement_payer_mismatch";
  if (settlement.amount !== req.amount) return "settlement_amount_mismatch";
  if (settlement.mock !== undefined && settlement.mock !== req.extra.mock) return "settlement_mode_mismatch";
  if (settlement.transaction.startsWith("mock_") !== req.extra.mock) return "settlement_mode_mismatch";
  return null;
}
