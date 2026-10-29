/**
 * Memory gate (docs/BUILD_PLAN.md sections 5 & 8).
 *
 * Phase 2 (this file, now): the "memory commit" is real. Each decision's
 * hash is committed on-chain via a `commit(hash, prev_hash)` call to the
 * MemoryContract deployed at mnemosyne-gov.testnet (contract/src/lib.rs).
 * Uses near-api-js v7's Account/JsonRpcProvider/KeyPairSigner API.
 *
 * writeMemoryRecord()'s signature is unchanged from Phase 1, so nothing
 * in cycle.ts has to change. Fails closed: any failure returns
 * `{ committed: false, error }` and never throws.
 *
 * NOTE: get_latest() on-chain only stores { latest_hash, prev_hash,
 * commit_count } -- not the full decision/swarm_risk payload. The
 * MemoryRecord returned by getLatestMemoryRecord() below fills in real
 * values for decision_hash/prev_memory_hash and placeholders for the
 * rest. If cycle.ts reads anything off the latest record besides
 * .decision_hash, this will need a follow-up adjustment.
 */

import { createHash } from "node:crypto";
import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from "near-api-js";
import "dotenv/config";
import type { MemoryRecord } from "./types.js";

const NODE_URL = "https://rpc.testnet.near.org";
const GOVERNOR_ACCOUNT_ID = process.env.GOVERNOR_ACCOUNT_ID ?? "";
const GOVERNOR_PRIVATE_KEY = process.env.GOVERNOR_PRIVATE_KEY ?? "";

export function hashDecision(record: Omit<MemoryRecord, "decision_hash">): string {
  const canonical = JSON.stringify(record);
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

const provider = new JsonRpcProvider({ url: NODE_URL });

export async function getLatestMemoryRecord(): Promise<MemoryRecord | null> {
  if (!GOVERNOR_ACCOUNT_ID) return null;

  const res: any = await provider.callFunction({
    contractId: GOVERNOR_ACCOUNT_ID,
    method: "get_latest",
    args: {},
  });
  const [latest_hash, prev_hash, commit_count] = Array.isArray(res)
    ? (res as [string, string, number])
    : (JSON.parse(Buffer.from(res.result).toString()) as [string, string, number]);

  if (commit_count === 0) return null;

  return {
    cycle_id: "",
    governor: GOVERNOR_ACCOUNT_ID,
    decision_hash: latest_hash,
    prev_memory_hash: prev_hash || null,
    decisions: [],
    swarm_risk: { max_total_exposure: "0", max_daily_loss: "0" },
    schema_version: 1,
  };
}

/**
 * Mandatory gate: commits a memory record's hash on-chain.
 *
 * Returns `{ committed: true }` on success. On any failure, returns
 * `{ committed: false }` and does NOT throw -- the caller (cycle.ts) is
 * responsible for treating a failed commit as fail-closed: the cycle
 * must end, and no capital/authority action may follow.
 */
export async function writeMemoryRecord(
  record: MemoryRecord
): Promise<{ committed: boolean; txHash?: string; error?: string }> {
  try {
    if (!GOVERNOR_ACCOUNT_ID || !GOVERNOR_PRIVATE_KEY) {
      throw new Error("Missing GOVERNOR_ACCOUNT_ID / GOVERNOR_PRIVATE_KEY -- check .env");
    }
    const signer = KeyPairSigner.fromSecretKey(GOVERNOR_PRIVATE_KEY as any);
    const account = new Account(GOVERNOR_ACCOUNT_ID, provider, signer);

    const res: any = await account.signAndSendTransaction({
      receiverId: GOVERNOR_ACCOUNT_ID,
      actions: [
        actions.functionCall(
          "commit",
          { hash: record.decision_hash, prev_hash: record.prev_memory_hash ?? "" },
          teraToGas(30),
          0n
        ),
      ],
      waitUntil: "FINAL",
    });
    const txHash: string | undefined = res?.transaction?.hash ?? res?.transaction_outcome?.id;
    return { committed: true, txHash };
  } catch (err) {
    return { committed: false, error: (err as Error).message };
  }
}
