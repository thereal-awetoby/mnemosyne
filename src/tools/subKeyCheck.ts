/**
 * Phase 3 verification for ONE sub-agent key, using exactly the code path
 * the cycle runner uses (near-api-js + the key in .env).
 *
 *   npm run sub:check -- A
 *
 * Three checks, all must pass before you touch that sub's FullAccess key:
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

/** Errors that mean "NEAR refused this key for this action" (key-level). */
// Wording differs across near-api-js / nearcore versions, so match broadly.
// If a negative check FAILs with an error that clearly is a key rejection,
// paste it into HANDOFF.md and widen this pattern.
const KEY_SCOPE_ERROR = /MethodNameMismatch|ReceiverMismatch|RequiresFullAccess|InvalidAccessKey|AccessKey|access key|allowed|permission|FunctionCall/i;

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
      result(KEY_SCOPE_ERROR.test(msg), "commit() rejected BY NEAR (key scope)", msg.slice(0, 240));
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
    result(KEY_SCOPE_ERROR.test(msg), "transfer rejected for this key", msg.slice(0, 240));
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
