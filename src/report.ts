/**
 * Phase 3 + 4: sub-agents write their ACT / REFUSE decision on-chain.
 *
 * Each sub signs with ITS OWN account and a function-call key that can only
 * call `report` on the governor contract (allowance-capped). That key cannot
 * transfer NEAR, deploy code, add keys, or call `commit` -- NEAR rejects
 * those before the contract even runs. The contract then additionally checks
 * the caller is a registered sub and that `sub` == caller.
 *
 * Never throws. A missing key is reported as `skipped`, not as an error, so a
 * partially-configured swarm still runs (and says so loudly).
 */

import { Account, JsonRpcProvider, KeyPairSigner, actions, teraToGas } from "near-api-js";
import "dotenv/config";
import { subAccountId, subPrivateKey } from "./subAgents.js";
import { clampUtf8, txFailure, txHashOf, txLogs } from "./nearTx.js";
import type { SubId } from "./types.js";

const NODE_URL = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
export const GOVERNOR_CONTRACT = process.env.GOVERNOR_ACCOUNT_ID ?? "mnemosyne-gov.testnet";

const provider = new JsonRpcProvider({ url: NODE_URL });

export type ReportAction = "ACT" | "REFUSE";

export interface ReportResult {
  sub: SubId;
  accountId: string;
  action: ReportAction;
  status: "reported" | "skipped" | "failed";
  txHash?: string;
  logs?: string[];
  error?: string;
}

/** Account handle for a sub, signing with its report-only key. */
export function subAccount(sub: SubId): { account: Account; accountId: string } | { error: string; accountId: string } {
  const accountId = subAccountId(sub);
  const key = subPrivateKey(sub);
  if (!key) return { accountId, error: `SUB_${sub}_PRIVATE_KEY not set in .env` };
  try {
    const signer = KeyPairSigner.fromSecretKey(key as any);
    return { accountId, account: new Account(accountId, provider, signer) };
  } catch (err) {
    return { accountId, error: `bad SUB_${sub}_PRIVATE_KEY: ${(err as Error).message}` };
  }
}

/** Low-level: call `method` on the governor contract as this sub.
 *  Used by report() and by the key-check tool's negative tests. */
export async function callAsSub(sub: SubId, method: string, args: Record<string, unknown>, tgas = 15) {
  const h = subAccount(sub);
  if ("error" in h) throw new Error(h.error);
  const res: any = await h.account.signAndSendTransaction({
    receiverId: GOVERNOR_CONTRACT,
    actions: [actions.functionCall(method, args, teraToGas(tgas), 0n)],
    waitUntil: "FINAL",
  });
  const failure = txFailure(res);
  if (failure) throw new Error(failure);
  return { txHash: txHashOf(res), logs: txLogs(res) };
}

export async function reportOnChain(sub: SubId, action: ReportAction, reason: string): Promise<ReportResult> {
  const accountId = subAccountId(sub);
  if (!subPrivateKey(sub)) {
    return { sub, accountId, action, status: "skipped", error: `SUB_${sub}_PRIVATE_KEY not set in .env` };
  }
  try {
    const { txHash, logs } = await callAsSub(sub, "report", {
      sub: accountId,
      action,
      reason: clampUtf8(reason, 200),
    });
    return { sub, accountId, action, status: "reported", txHash, logs };
  } catch (err) {
    return { sub, accountId, action, status: "failed", error: (err as Error).message };
  }
}
