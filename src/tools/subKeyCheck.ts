/**
 * Phase 3 verification for ONE sub-agent key, using exactly the code path
 * the cycle runner uses (near-api-js + the key in .env).
 *
 *   npm run sub:check -- A
 *
 * Pre-check: the key in .env exists on-chain and is scoped to report() only
 * (asked directly via view_access_key). Then three checks, all must pass
 * before you touch any key on that account:
 *   1. POSITIVE  report() as the sub succeeds and emits MNEMOSYNE_REPORT log.
 *   2. NEGATIVE  commit() with the same key is rejected BY NEAR (key is
 *                scoped to `report` only) -- not merely by the contract.
 *   3. NEGATIVE  a 0.01 NEAR transfer with the same key is rejected
 *                (function-call keys can never transfer).
 *
 * Negative checks are rejected at transaction validation, so they cost no gas
 * and change nothing on-chain.
 */

import { actions } from "near-api-js";
import "dotenv/config";
import { callAsSub, subAccount, GOVERNOR_CONTRACT } from "../report.js";
import { subPrivateKey } from "../subAgents.js";
import { publicKeyFromSecret, txFailure } from "../nearTx.js";
import type { SubId } from "../types.js";

const sub = (process.argv[2] ?? "").toUpperCase() as SubId;
if (!["A", "B", "C"].includes(sub)) {
  console.error("Usage: npm run sub:check -- <A|B|C>");
  process.exit(2);
}

let failed = 0;
function result(ok: boolean, label: string, detail?: string) {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (detail) console.log(`        ${detail}`);
}

/** Errors that mean "NEAR refused this EXISTING key for this action".
 *  Deliberately does NOT match "key does not exist": a missing key also gets
 *  every transaction rejected, which would otherwise look like a PASS. */
const KEY_SCOPE_ERROR = /MethodNameMismatch|ReceiverMismatch|RequiresFullAccess|InvalidAccessKeyError|isn't allowed|is not allowed|not allowed by the access key|full access/i;
const KEY_MISSING_ERROR = /does not exist|AccessKeyNotFound|UNKNOWN_ACCESS_KEY/i;

const RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";

/** Ask NEAR directly what this public key is allowed to do on the account. */
async function viewAccessKey(accountId: string, publicKey: string): Promise<
  | { kind: "missing" }
  | { kind: "full" }
  | { kind: "function_call"; receiver: string; methods: string[]; allowance: string | null }
  | { kind: "error"; message: string }
> {
  try {
    const r = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "subcheck",
        method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
    });
    const j: any = await r.json();
    const errText = JSON.stringify(j.error ?? j.result?.error ?? "");
    if (j.error || j.result?.error) {
      return KEY_MISSING_ERROR.test(errText) ? { kind: "missing" } : { kind: "error", message: errText.slice(0, 240) };
    }
    const perm = j.result?.permission;
    if (perm === "FullAccess") return { kind: "full" };
    if (perm?.FunctionCall) {
      const fc = perm.FunctionCall;
      return { kind: "function_call", receiver: fc.receiver_id, methods: fc.method_names ?? [], allowance: fc.allowance ?? null };
    }
    return { kind: "error", message: "unexpected response: " + JSON.stringify(j).slice(0, 240) };
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}

function yoctoToNear(y: string | null): string {
  if (y === null) return "unlimited";
  const v = BigInt(y);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").slice(0, 4);
  return `${whole}.${frac} NEAR`;
}

async function main() {
  const h = subAccount(sub);
  console.log(`\nSub ${sub} key check (${h.accountId} -> ${GOVERNOR_CONTRACT})`);
  if ("error" in h) {
    result(false, "key loaded from .env", h.error);
    return;
  }
  const pub = publicKeyFromSecret(subPrivateKey(sub)!);
  console.log(`  key in .env has public key ${pub}`);
  console.log(`  (must appear in: near account list-keys ${h.accountId} network-config testnet now)\n`);

  // 0. PRE-CHECK: the key must exist on-chain AND be scoped to report() only.
  //    Without this, a key that was never registered makes both negative
  //    checks "pass" (every tx is rejected because the key doesn't exist).
  const ak = await viewAccessKey(h.accountId, pub);
  if (ak.kind === "missing") {
    result(false, "key is registered on-chain",
      `NEAR has no key ${pub} on ${h.accountId}. Run the add-key command that ` +
      `"npm run sub:keygen -- ${sub}" printed for THIS key (same public key), then re-run this check.`);
    return;
  }
  if (ak.kind === "error") {
    result(false, "key is registered on-chain", `could not ask NEAR: ${ak.message}`);
    return;
  }
  if (ak.kind === "full") {
    result(false, "key is report-only", "this is a FullAccess key -- never put a FullAccess key in .env for a sub");
    return;
  }
  const scopedOk =
    ak.receiver === GOVERNOR_CONTRACT && ak.methods.length === 1 && ak.methods[0] === "report";
  result(scopedOk, "key is registered and scoped to report() only",
    `receiver=${ak.receiver} methods=${JSON.stringify(ak.methods)} allowance=${yoctoToNear(ak.allowance)}`);
  if (!scopedOk) return;

  // 1. POSITIVE
  try {
    const { txHash, logs } = await callAsSub(sub, "report", {
      sub: h.accountId,
      action: "ACT",
      reason: `phase3 key check ${new Date().toISOString()}`,
    });
    const line = logs.find((l) => l.startsWith(`MNEMOSYNE_REPORT:${h.accountId}:ACT:`));
    result(!!line, "report() succeeds with report-only key", line ?? `no MNEMOSYNE_REPORT log; logs=${JSON.stringify(logs)}`);
    if (txHash) console.log(`        tx: https://testnet.nearblocks.io/txns/${txHash}`);
  } catch (err) {
    result(false, "report() succeeds with report-only key", (err as Error).message);
  }

  // 2. NEGATIVE: commit with the scoped key
  try {
    await callAsSub(sub, "commit", { hash: "sha256:deadbeef", prev_hash: "" });
    result(false, "commit() rejected for this key", "commit SUCCEEDED -- this must never happen");
  } catch (err) {
    const msg = (err as Error).message;
    if (/only the governor account may write/.test(msg)) {
      result(false, "commit() rejected BY NEAR (key scope)",
        "rejected only by the contract -- the key itself is NOT scoped to report(). Is this a FullAccess key?");
    } else {
      result(KEY_SCOPE_ERROR.test(msg) && !KEY_MISSING_ERROR.test(msg), "commit() rejected BY NEAR (key scope)", msg.slice(0, 240));
    }
  }

  // 3. NEGATIVE: transfer with the scoped key
  try {
    const res: any = await h.account.signAndSendTransaction({
      receiverId: GOVERNOR_CONTRACT,
      actions: [actions.transfer(10n ** 22n)], // 0.01 NEAR
      waitUntil: "FINAL",
    });
    const failure = txFailure(res);
    result(!!failure, "transfer rejected for this key", failure ?? "transfer SUCCEEDED -- key can move funds!");
  } catch (err) {
    const msg = (err as Error).message;
    result(KEY_SCOPE_ERROR.test(msg) && !KEY_MISSING_ERROR.test(msg), "transfer rejected for this key", msg.slice(0, 240));
  }
}

main()
  .catch((err) => {
    failed++;
    console.error("unexpected error:", err);
  })
  .finally(() => {
    console.log(failed === 0
      ? `\nALL PASS -- sub ${sub}'s report-only key is proven. Safe to remove its leftover keys (see docs/PHASE3_KEYS.md).\n`
      : `\n${failed} check(s) FAILED -- do NOT delete any keys on this account yet.\n`);
    process.exitCode = failed === 0 ? 0 : 1;
  });
