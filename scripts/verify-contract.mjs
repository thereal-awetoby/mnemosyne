#!/usr/bin/env node
/**
 * Read-only deploy verification (no keys, no transactions).
 *
 * Answers the two questions separately, because they are separate:
 *   1. Is there contract code on the account at all?      -> view_account
 *   2. Is the code on chain *the exact wasm you built*?   -> sha256(wasm) == code_hash
 *   3. Does the contract behave as expected?              -> get_latest view call
 *
 * NEAR stores a contract's `code_hash` as base58(sha256(wasm bytes)), so the
 * hash comparison in step 2 is byte-exact -- it cannot be faked by deploying
 * a different build, and it is the only way to tell "my build is live" apart
 * from "some earlier build of the same source is still sitting there".
 *
 * Usage (from the repo root):
 *   node scripts/verify-contract.mjs
 *   node scripts/verify-contract.mjs mnemosyne-gov.testnet
 *   NEAR_RPC_URL=https://rpc.mainnet.near.org CONTRACT_WASM=... node scripts/verify-contract.mjs
 *
 * Exit code 0 = everything passed, 1 = at least one check failed.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const ACCOUNT = process.argv[2] ?? process.env.GOVERNOR_ACCOUNT_ID ?? "mnemosyne-gov.testnet";
const WASM_PATH = process.env.CONTRACT_WASM ?? "contract/target/near/mnemosyne_memory_contract.wasm";
const EXPLORER = RPC_URL.includes("mainnet")
  ? "https://nearblocks.io"
  : "https://testnet.nearblocks.io";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58 (Bitcoin alphabet) -- NEAR's encoding for code hashes. */
export function base58(bytes) {
  if (bytes.length === 0) return "";
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
  return B58_ALPHABET[0].repeat(leadingZeros) + out;
}

const NO_CODE = "11111111111111111111111111111111"; // base58(32 zero bytes)

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

const results = [];
function check(ok, label, detail) {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (detail) for (const line of detail.split("\n")) console.log(`        ${line}`);
  return ok;
}
function info(label, detail) {
  console.log(`  ----  ${label}`);
  if (detail) for (const line of detail.split("\n")) console.log(`        ${line}`);
}

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "verify-contract", method, params }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) {
    const err = body?.error;
    const msg = err
      ? `${err.cause?.name ?? err.name ?? "RPC_ERROR"}: ${err.cause?.info?.error_message ?? err.message}`
      : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body.result;
}

async function main() {
  console.log(`\nVerifying ${ACCOUNT} on ${RPC_URL}\n`);

  // --- 1. does the account exist, and does it have code? -------------------
  let account;
  try {
    account = await rpc("query", { request_type: "view_account", finality: "final", account_id: ACCOUNT });
  } catch (err) {
    console.log(`  FAIL  account lookup for ${ACCOUNT}`);
    console.log(`        ${err.message}`);
    console.log(`\n  -> The account does not exist, or the RPC is unreachable. A failed`);
    console.log(`     deploy leaves the account intact, so check the RPC first.\n`);
    process.exit(1);
  }

  const codeHash = account.code_hash;
  let codeHashVerified = false;
  const hasCode = codeHash && codeHash !== NO_CODE;
  check(hasCode, `contract code present on ${ACCOUNT}`, hasCode ? `code_hash ${codeHash}` : "account has no deployed contract (empty code_hash)");

  // --- 2. is that code the wasm you just built? ----------------------------
  if (!existsSync(WASM_PATH)) {
    check(false, `local wasm found at ${WASM_PATH}`, "build it first: cargo near build non-reproducible-wasm --no-abi");
  } else {
    const wasm = readFileSync(WASM_PATH);
    const localHash = base58(createHash("sha256").update(wasm).digest());
    const same = localHash === codeHash;
    codeHashVerified = same;
    check(
      same,
      "on-chain code == local wasm (sha256, base58)",
      same
        ? `${fmtSize(wasm.length)}, hash matches`
        : !hasCode
        ? "account has no code to compare against -- nothing was deployed to this account"
        : `local:    ${localHash}\n` +
          `on-chain: ${codeHash}\n` +
          `        -> same account, different bytes. Either the deploy did not\n` +
          `           run, or the wasm was rebuilt after deploying.`
    );
  }

  // --- 3. does it respond, and does the state look sane? ------------------
  let latest;
  try {
    const res = await rpc("query", {
      request_type: "call_function",
      finality: "final",
      account_id: ACCOUNT,
      method_name: "get_latest",
      args_base64: Buffer.from("{}").toString("base64"),
    });
    latest = JSON.parse(Buffer.from(res.result).toString());
  } catch (err) {
    check(false, "get_latest() responds", `${err.message}\n        -> old/other code live, or the deploy landed mid-query. Retry once.`);
    latest = null;
  }

  if (latest) {
    const [latestHash, prevHash, commitCount] = latest;
    check(Array.isArray(latest) && latest.length === 3, "get_latest() returns (hash, prev_hash, count)", JSON.stringify(latest));
    info("state", `latest_hash: ${latestHash || "(empty)"}\nprev_hash:   ${prevHash || "(empty)"}\ncommit_count: ${commitCount}`);
    check(
      Number.isInteger(commitCount) && commitCount >= 0,
      "commit_count is a u64",
      typeof commitCount === "string" ? `got string "${commitCount}" -- wrong code shape on chain` : undefined
    );
    if (commitCount === 0) {
      info("note", "commit_count 0 is expected on a fresh testnet contract -- no cycle has committed yet.");
    } else {
      check(/^sha256:[0-9a-f]{64}$/.test(latestHash), "latest_hash looks like sha256:<64 hex>", `${String(latestHash).slice(0, 24)}...`);
      if (commitCount === 1) {
        info("note", "commit_count 1 -- prev_hash empty here is correct: the chain had no earlier link.");
      } else {
        check(Boolean(prevHash), `prev_hash is set once commit_count >= 2 (count is ${commitCount})`);
      }
    }
  }

  // --- summary ------------------------------------------------------------
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed === 0 ? "OK" : "FAILED"}: ${results.length - failed}/${results.length} checks passed`);
  console.log(`Explorer: ${EXPLORER}/address/${ACCOUNT}\n`);

  if (failed > 0 && !codeHashVerified) {
    console.log("Note: this says nothing about *why* the deploy failed -- it only proves");
    console.log("the chain does not yet hold the build you have locally. If the deploy");
    console.log("command printed an error, that error is still the primary signal.\n");
  }
  process.exit(failed === 0 ? 0 : 1);
}

// Only run when invoked directly (`node scripts/verify-contract.mjs`), so the
// helpers above can be imported by tests without firing network requests.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\nverify failed: ${err.message}\n`);
    process.exit(1);
  });
}
