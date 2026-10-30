#!/usr/bin/env node
/**
 * Generate a fresh ed25519 keypair for a sub-agent's `report`-only key.
 *
 * Why not `autogenerate-new-keypair save-to-keychain` in near-cli-rs?
 * Because near-api-js (what src/ uses) cannot read the OS keychain, and
 * exporting a *function-call* key back out of the keychain is awkward.
 * Generating the key here means: the public half goes on-chain via
 * `near account add-key ... use-manually-provided-public-key`, and the
 * secret half goes straight into your gitignored .env -- the only place
 * the cycle runner ever reads it from.
 *
 * Nothing is written to disk. Output is printed only.
 *
 * Usage:
 *   node scripts/gen-sub-key.mjs A
 *   node scripts/gen-sub-key.mjs B
 *   node scripts/gen-sub-key.mjs C
 */

import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { base58 } from "./verify-contract.mjs";

const SUB_DEFAULTS = {
  A: "mnemosyne-sub-a.testnet",
  B: "mnemosyne-sub-b.testnet",
  C: "mnemosyne-sub-c2.testnet",
};

/** NEAR key strings: public = "ed25519:" + b58(pub32),
 *  secret = "ed25519:" + b58(seed32 || pub32)  (64 bytes, tweetnacl layout). */
export function newNearKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  return {
    publicKey: "ed25519:" + base58(pub),
    secretKey: "ed25519:" + base58(Buffer.concat([seed, pub])),
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const sub = (process.argv[2] ?? "").toUpperCase();
  if (!SUB_DEFAULTS[sub]) {
    console.error("Usage: node scripts/gen-sub-key.mjs <A|B|C>");
    process.exit(1);
  }
  const account = SUB_DEFAULTS[sub];
  const { publicKey, secretKey } = newNearKeyPair();

  console.log(`\nNew report-only key for sub ${sub} (${account})\n`);
  console.log("1) PUBLIC key -- goes on-chain (safe to share):");
  console.log(`   ${publicKey}\n`);
  console.log("2) Add these two lines to your .env (NEVER commit .env):");
  console.log(`   SUB_${sub}_ACCOUNT_ID=${account}`);
  console.log(`   SUB_${sub}_PRIVATE_KEY=${secretKey}\n`);
  console.log("3) Then register the public key on-chain, scoped to report() only:");
  console.log(
    `   near account add-key ${account} grant-function-call-access --allowance "1 NEAR" ` +
      `--contract-account-id mnemosyne-gov.testnet --function-names report ` +
      `use-manually-provided-public-key ${publicKey} network-config testnet sign-with-keychain send\n`
  );
  console.log("   If your near-cli-rs version rejects a flag name, run just");
  console.log(`   near account add-key ${account}`);
  console.log("   and answer the prompts: grant-function-call-access -> allowance 1 NEAR ->");
  console.log("   contract mnemosyne-gov.testnet -> method report -> use-manually-provided-public-key.\n");
}
