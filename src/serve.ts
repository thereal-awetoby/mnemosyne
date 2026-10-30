/**
 * Start the Mnemosyne API:  npm run server
 *
 * Env (all optional; see .env.example):
 *   PORT                      default 8402
 *   PUBLIC_URL                default http://localhost:<PORT>
 *   GOVERNOR_ACCOUNT_ID       payTo + contract (default mnemosyne-gov.testnet)
 *   X402_PRICE_YOCTO          price per check, default 1e21 (0.001 NEAR)
 *   X402_FACILITATOR_URL      use a real x402 facilitator instead of the mock
 *   X402_FACILITATOR_API_KEY  bearer token for that facilitator
 *   X402_VERIFY_NAMED_PAYERS  "1": mock facilitator accepts named payer accounts
 *                             (e.g. agent.testnet) after checking the key on NEAR
 *   ADMIN_TOKEN               enables POST /memory/confess and POST /cycle/run
 *   DATA_DIR                  default data/runtime (gitignored)
 */

import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMnemosyneServer } from "./x402/server.js";
import { HttpFacilitator, MockFacilitator, type Facilitator } from "./x402/facilitator.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8402);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const GOVERNOR = process.env.GOVERNOR_ACCOUNT_ID ?? "mnemosyne-gov.testnet";
const RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(REPO_ROOT, "data/runtime"));

/** Named-account payer check: does `publicKey` exist on `accountId`? */
async function keyBelongsToAccount(accountId: string, publicKey: string): Promise<boolean> {
  try {
    const r = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "x402", method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
    });
    const j: any = await r.json();
    return !j.error && !j.result?.error && j.result?.permission !== undefined;
  } catch {
    return false;
  }
}

const realFacilitatorUrl = process.env.X402_FACILITATOR_URL;
const facilitator: Facilitator = realFacilitatorUrl
  ? new HttpFacilitator(realFacilitatorUrl, process.env.X402_FACILITATOR_API_KEY)
  : new MockFacilitator(DATA_DIR, {
      checkNamedAccountKey: process.env.X402_VERIFY_NAMED_PAYERS === "1" ? keyBelongsToAccount : undefined,
    });

const { server, memory } = createMnemosyneServer({
  dataDir: DATA_DIR,
  seedPath: join(REPO_ROOT, "data/seed-memory.json"),
  publicUrl: PUBLIC_URL,
  payTo: GOVERNOR,
  network: "near:testnet",
  asset: "NEAR",
  priceAmount: process.env.X402_PRICE_YOCTO ?? "1000000000000000000000",
  maxTimeoutSeconds: 300,
  facilitator,
  mockSettlement: !realFacilitatorUrl,
  adminToken: process.env.ADMIN_TOKEN || undefined,
  readChainHead: async () => {
    const { getLatestMemoryRecord } = await import("./memory.js");
    const rec = await getLatestMemoryRecord();
    return rec ? { latest_hash: rec.decision_hash, prev_hash: rec.prev_memory_hash } : null;
  },
  runCycle: async () => {
    const { runCycle } = await import("./cycle.js");
    const r = await runCycle();
    // Public parts only. privateDecision (the reasoning) never leaves.
    return {
      committed: r.committed,
      cycle_id: r.memoryRecord.cycle_id,
      decision_hash: r.memoryRecord.decision_hash,
      prev_memory_hash: r.memoryRecord.prev_memory_hash,
      decisions: r.memoryRecord.decisions,
      reports: r.reports ?? [],
    };
  },
});

server.listen(PORT, () => {
  console.log(`Mnemosyne API on ${PUBLIC_URL}`);
  console.log(`  memory entries: ${memory.size}   payTo: ${GOVERNOR}   data: ${DATA_DIR}`);
  console.log(`  facilitator: ${realFacilitatorUrl ? realFacilitatorUrl : "MOCK (verifies everything, settles to a local ledger)"}`);
  console.log(`  admin routes: ${process.env.ADMIN_TOKEN ? "enabled" : "disabled (set ADMIN_TOKEN)"}`);
});
