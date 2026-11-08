/**
 * Fund sweeping: collect ETH from paid deposit addresses via Chain Signatures.
 *
 * Each payable quote gets its own deposit address on Base Sepolia, derived from
 * the governor's NEAR account through `v1.signer-prod.testnet`. Once someone
 * pays to that address, the governor can *spend* from it by asking the MPC
 * contract to sign an EVM transaction. That is what this module does.
 *
 * The sweep sends a simple ETH transfer from the deposit address to a
 * collection address (the governor's "main" chain-signature address, derived
 * with a fixed path). Gas is paid from the deposit's own balance, so the
 * collection address never needs to fund anything.
 *
 * Deliberately minimal: no ethers.js, no viem, no ERC-20. Native ETH only,
 * EIP-1559 transactions, and the MPC contract does the signing.
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from "near-api-js";
import type { EvmRpc } from "./evm.js";
import type { NearRpc } from "./chainsig.js";
import { depositPath } from "./chainsig.js";
import { fromWei } from "./evm.js";
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_EXPLORER } from "./evm.js";

// ── RLP encoding (just enough for EIP-1559 transactions) ──────────────

/** RLP-encode a single item: a Buffer (string) or an array of items. */
export function rlpEncode(input: Buffer | readonly (Buffer | readonly any[])[]): Buffer {
  if (Buffer.isBuffer(input)) {
    if (input.length === 1 && input[0] < 0x80) return input;
    if (input.length <= 55) return Buffer.concat([Buffer.from([0x80 + input.length]), input]);
    const lenBytes = lengthBytes(input.length);
    return Buffer.concat([Buffer.from([0xb7 + lenBytes.length]), lenBytes, input]);
  }
  // Array
  const encoded = Buffer.concat((input as any[]).map(rlpEncode));
  if (encoded.length <= 55) return Buffer.concat([Buffer.from([0xc0 + encoded.length]), encoded]);
  const lenBytes = lengthBytes(encoded.length);
  return Buffer.concat([Buffer.from([0xf7 + lenBytes.length]), lenBytes, encoded]);
}

function lengthBytes(len: number): Buffer {
  const hex = len.toString(16);
  return Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
}

/** BigInt -> minimal big-endian bytes, no leading zeros. RLP standard. */
export function bigintToBytes(n: bigint): Buffer {
  if (n === 0n) return Buffer.alloc(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

// ── EIP-1559 transaction ──────────────────────────────────────────────

export interface UnsignedTx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;       // 0x-prefixed, 20 bytes
  value: bigint;
  data: Buffer;      // empty for a plain transfer
  accessList: [];    // always empty here
}

/** The 9-element RLP list that an EIP-1559 transaction signs over. */
function unsignedTxFields(tx: UnsignedTx): Buffer[] {
  return [
    bigintToBytes(tx.chainId),
    bigintToBytes(tx.nonce),
    bigintToBytes(tx.maxPriorityFeePerGas),
    bigintToBytes(tx.maxFeePerGas),
    bigintToBytes(tx.gasLimit),
    Buffer.from(tx.to.replace(/^0x/, ""), "hex"),
    bigintToBytes(tx.value),
    tx.data,
    Buffer.alloc(0), // accessList, always empty
  ];
}

/** keccak256( 0x02 || RLP(fields) ) — what the MPC contract signs. */
export function txHash(tx: UnsignedTx): Buffer {
  const payload = Buffer.concat([Buffer.from([0x02]), rlpEncode(unsignedTxFields(tx))]);
  return Buffer.from(keccak_256(payload));
}

/** 0x02 || RLP(fields + v,r,s) — what gets broadcast. */
export function signedTxBytes(tx: UnsignedTx, v: number, r: Buffer, s: Buffer): Buffer {
  const fields = [
    ...unsignedTxFields(tx),
    bigintToBytes(BigInt(v)),
    r.length > 0 ? r : Buffer.alloc(0),
    s.length > 0 ? s : Buffer.alloc(0),
  ];
  return Buffer.concat([Buffer.from([0x02]), rlpEncode(fields)]);
}

// ── MPC sign call ─────────────────────────────────────────────────────

export interface MpcSignResult {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

/**
 * Ask the MPC contract to sign a 32-byte payload for (predecessor, path).
 *
 * This is a *real NEAR transaction* that costs gas — roughly 250 TGas for
 * secp256k1 threshold signing. The governor account must have enough NEAR
 * to cover it.
 */
export async function mpcSign(opts: {
  accountId: string;
  secretKey: string;
  mpcContract: string;
  rpcUrl: string;
  payload: number[];  // 32 bytes, the keccak256 hash of the unsigned EVM tx
  path: string;
  keyVersion?: number;
}): Promise<MpcSignResult> {
  const provider = new JsonRpcProvider({ url: opts.rpcUrl });
  const signer = KeyPairSigner.fromSecretKey(opts.secretKey as any);
  const account = new Account(opts.accountId, provider, signer);

  const args = {
    request: {
      payload: opts.payload,
      path: opts.path,
      key_version: opts.keyVersion ?? 0,
    },
  };

  const result: any = await account.signAndSendTransaction({
    receiverId: opts.mpcContract,
    actions: [
      actions.functionCall("sign", args, teraToGas(250), 1n),
    ],
    waitUntil: "FINAL",
  });

  // The MPC contract returns the signature in the last SuccessValue of the
  // execution outcome. near-api-js v7 gives us the full FinalExecutionOutcome.
  const outcome = result?.transaction_outcome ?? result;
  const receiptsOutcomes: any[] = result?.receipts_outcome ?? [];

  // Walk receipts looking for a SuccessValue
  for (const ro of receiptsOutcomes) {
    const sv = ro?.outcome?.status?.SuccessValue;
    if (typeof sv === "string" && sv.length > 0) {
      try {
        const parsed = JSON.parse(Buffer.from(sv, "base64").toString("utf8"));
        if (parsed?.big_r?.affine_point && parsed?.s?.scalar) return parsed;
      } catch { /* not the one we want */ }
    }
  }

  // Fallback: check the top-level status
  const topSv = outcome?.status?.SuccessValue ?? result?.status?.SuccessValue;
  if (typeof topSv === "string" && topSv.length > 0) {
    const parsed = JSON.parse(Buffer.from(topSv, "base64").toString("utf8"));
    if (parsed?.big_r?.affine_point && parsed?.s?.scalar) return parsed;
  }

  throw new Error("the MPC contract did not return a signature");
}

/** Turn an MPC sign result into (v, r, s) buffers for an EVM transaction. */
export function mpcSigToVRS(sig: MpcSignResult): { v: number; r: Buffer; s: Buffer } {
  // big_r.affine_point is a hex-encoded compressed secp256k1 point (33 bytes).
  // The x-coordinate (32 bytes, after the 02/03 prefix) is r.
  const rHex = sig.big_r.affine_point.replace(/^0x/, "");
  const rBytes = Buffer.from(rHex, "hex");
  // First byte is 02 or 03 (compressed point prefix), rest is the 32-byte x.
  const r = rBytes.subarray(1);

  const sHex = sig.s.scalar.replace(/^0x/, "");
  const s = Buffer.from(sHex.length % 2 ? "0" + sHex : sHex, "hex");

  // EIP-1559 uses yParity (0 or 1), which is the recovery_id
  const v = sig.recovery_id;

  return { v, r, s };
}

// ── The sweep itself ──────────────────────────────────────────────────

export interface SweepableQuote {
  quote_id: string;
  deposit_address: string;
  deposit_path: string;
  source_amount: string;  // wei
}

export interface SweepResult {
  quote_id: string;
  deposit_address: string;
  balance_wei: string;
  swept_wei: string;
  tx_hash: string;
  explorer: string;
}

export interface SweepConfig {
  /** the NEAR account that controls the deposit addresses */
  accountId: string;
  /** its full-access ed25519 secret key */
  secretKey: string;
  /** the MPC signer contract */
  mpcContract: string;
  nearRpcUrl: string;
  evmRpc: EvmRpc;
  /** where swept funds go. Typically the governor's own "collection" address,
   *  derived with a fixed path like "mnemosyne-treasury". */
  collectionAddress: string;
  /** Base Sepolia chain id (84532) */
  chainId?: number;
  explorerBase?: string;
}

/** The fixed path for the governor's collection address. */
export const COLLECTION_PATH = "mnemosyne-treasury";

/**
 * Sweep one deposit address: check balance, build a transfer to the
 * collection address, sign via MPC, and broadcast.
 *
 * Returns null if the address has no sweepable balance (after gas).
 */
export async function sweepOne(
  cfg: SweepConfig,
  quote: SweepableQuote,
): Promise<SweepResult | null> {
  const chainId = BigInt(cfg.chainId ?? BASE_SEPOLIA_CHAIN_ID);
  const explorerBase = (cfg.explorerBase ?? BASE_SEPOLIA_EXPLORER).replace(/\/$/, "");

  // 1. Check balance
  const balanceHex = await cfg.evmRpc("eth_getBalance", [quote.deposit_address, "latest"]);
  const balance = BigInt(balanceHex);
  if (balance === 0n) return null;

  // 2. Get nonce and gas price
  const [nonceHex, feeHistory] = await Promise.all([
    cfg.evmRpc("eth_getTransactionCount", [quote.deposit_address, "latest"]),
    cfg.evmRpc("eth_feeHistory", [1, "latest", [50]]),
  ]);
  const nonce = BigInt(nonceHex);

  // Parse fee history for EIP-1559 gas pricing
  const baseFee = BigInt(feeHistory.baseFeePerGas?.[1] ?? feeHistory.baseFeePerGas?.[0] ?? "0x1");
  const priorityFee = BigInt(feeHistory.reward?.[0]?.[0] ?? "0x59682F00"); // ~1.5 gwei fallback
  const maxFeePerGas = baseFee * 2n + priorityFee;  // 2x base + priority, generous buffer
  const gasLimit = 21000n; // plain ETH transfer, always 21000

  // 3. Compute how much to send: balance minus gas
  const gasCost = gasLimit * maxFeePerGas;
  if (balance <= gasCost) return null;  // not enough to cover gas
  const value = balance - gasCost;

  // 4. Build unsigned transaction
  const tx: UnsignedTx = {
    chainId,
    nonce,
    maxPriorityFeePerGas: priorityFee,
    maxFeePerGas,
    gasLimit,
    to: cfg.collectionAddress,
    value,
    data: Buffer.alloc(0),
    accessList: [],
  };

  // 5. Hash and sign via MPC
  const hash = txHash(tx);
  const sig = await mpcSign({
    accountId: cfg.accountId,
    secretKey: cfg.secretKey,
    mpcContract: cfg.mpcContract,
    rpcUrl: cfg.nearRpcUrl,
    payload: Array.from(hash),
    path: quote.deposit_path,
  });
  const { v, r, s } = mpcSigToVRS(sig);

  // 6. Broadcast
  const raw = "0x" + signedTxBytes(tx, v, r, s).toString("hex");
  const broadcastResult = await cfg.evmRpc("eth_sendRawTransaction", [raw]);
  const txHashHex = typeof broadcastResult === "string" ? broadcastResult : "";

  return {
    quote_id: quote.quote_id,
    deposit_address: quote.deposit_address,
    balance_wei: balance.toString(),
    swept_wei: value.toString(),
    tx_hash: txHashHex,
    explorer: `${explorerBase}/tx/${txHashHex}`,
  };
}

/**
 * Sweep all given deposit addresses. Skips those with zero balance.
 * Returns results for each address that was actually swept.
 */
export async function sweepAll(
  cfg: SweepConfig,
  quotes: SweepableQuote[],
): Promise<{ swept: SweepResult[]; errors: Array<{ quote_id: string; error: string }> }> {
  const swept: SweepResult[] = [];
  const errors: Array<{ quote_id: string; error: string }> = [];

  for (const q of quotes) {
    try {
      const result = await sweepOne(cfg, q);
      if (result) swept.push(result);
    } catch (err) {
      errors.push({ quote_id: q.quote_id, error: (err as Error).message });
    }
  }

  return { swept, errors };
}
