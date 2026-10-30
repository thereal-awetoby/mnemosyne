/**
 * Start the Mnemosyne API:  npm run server
 *
 * Env (all optional; see .env.example):
 *   HOST                      default 0.0.0.0
 *   PORT                      default 8402
 *   PUBLIC_URL                optional pinned public origin; default: request Host
 *   GOVERNOR_ACCOUNT_ID       payTo + contract (default mnemosyne-gov.testnet)
 *   X402_PRICE_YOCTO          price per check, default 1e21 (0.001 NEAR)
 *   X402_FACILITATOR_URL      use a real x402 facilitator instead of the mock
 *   X402_FACILITATOR_API_KEY  bearer token for that facilitator
 *   X402_VERIFY_NAMED_PAYERS  "1": mock facilitator accepts named payer accounts
 *                             (e.g. agent.testnet) after checking the key on NEAR
 *   ADMIN_TOKEN               enables POST /memory/confess and POST /cycle/run
 *   DATA_DIR                  default data/runtime (gitignored)
 *
 * Real settlement (testnet only):
 *   X402_RAIL=near-testnet    official x402 NEAR "exact" scheme, wNEAR, real txs
 *   X402_ASSET                NEP-141 token, default wrap.testnet (wNEAR)
 *   X402_PRICE                price in token units, default 1e21 (0.001 wNEAR)
 *   X402_RELAYER_ACCOUNT_ID   pays gas for settlements; default GOVERNOR_ACCOUNT_ID
 *   X402_RELAYER_PRIVATE_KEY  full-access key of that account; default GOVERNOR_PRIVATE_KEY
 */

import "dotenv/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMnemosyneServer } from "./x402/server.js";
import { HttpFacilitator, MockFacilitator, type Facilitator } from "./x402/facilitator.js";
import { createNearExactRail, type PaymentRail } from "./x402/rails.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 8402);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error("PORT must be an integer from 0 to 65535");
const PUBLIC_URL = process.env.PUBLIC_URL || undefined;
const GOVERNOR = process.env.GOVERNOR_ACCOUNT_ID ?? "mnemosyne-gov.testnet";
const RPC_URL = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(REPO_ROOT, "data/runtime"));

/** Named-account payer check: does `publicKey` exist on `accountId`? */
async function keyBelongsToAccount(accountId: string, publicKey: string): Promise<boolean> {
  try {
    const r = await fetch(RPC_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "x402", method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
    });
    if (!r.ok) return false;
    const j: any = await r.json();
    return !j.error && !j.result?.error && j.result?.permission !== undefined;
  } catch {
    return false;
  }
}

const RAIL = (process.env.X402_RAIL ?? "mock").trim();
if (!["mock", "near-testnet"].includes(RAIL)) throw new Error(`X402_RAIL must be "mock" or "near-testnet" (got "${RAIL}")`);

let rail: PaymentRail | undefined;
if (RAIL === "near-testnet") {
  const relayerId = process.env.X402_RELAYER_ACCOUNT_ID || process.env.GOVERNOR_ACCOUNT_ID || "";
  const relayerKey = process.env.X402_RELAYER_PRIVATE_KEY || process.env.GOVERNOR_PRIVATE_KEY || "";
  if (!relayerId || !relayerKey) {
    throw new Error("X402_RAIL=near-testnet needs a relayer: set X402_RELAYER_ACCOUNT_ID/X402_RELAYER_PRIVATE_KEY (or GOVERNOR_ACCOUNT_ID/GOVERNOR_PRIVATE_KEY) in .env");
  }
  rail = await createNearExactRail({
    network: "near:testnet",
    asset: process.env.X402_ASSET || "wrap.testnet",
    amount: process.env.X402_PRICE || "1000000000000000000000",
    payTo: GOVERNOR,
    maxTimeoutSeconds: 300,
    relayer: { accountId: relayerId, secretKey: relayerKey },
    rpcUrl: RPC_URL,
  });
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
  rail,
  mockSettlement: !realFacilitatorUrl,
  adminToken: process.env.ADMIN_TOKEN || undefined,
  readChainHead: async () => {
    const { getLatestMemoryRecord } = await import("./memory.js");
    const rec = await getLatestMemoryRecord(GOVERNOR);
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

server.on("error", (err) => {
  console.error(`Mnemosyne API failed to listen: ${err.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`Mnemosyne API listening on ${HOST}:${actualPort}; public URL: ${PUBLIC_URL ?? "derived from each request's Host"}`);
  console.log(`  memory entries: ${memory.size}   payTo: ${GOVERNOR}   data: ${DATA_DIR}`);
  console.log(`  facilitator: ${rail ? `REAL near:testnet -- ${rail.requirements.amount} ${rail.requirements.asset} per check, relayer pays gas` : realFacilitatorUrl ? realFacilitatorUrl : "MOCK (verifies everything, settles to a local ledger)"}`);
  console.log(`  admin routes: ${process.env.ADMIN_TOKEN ? "enabled" : "disabled (set ADMIN_TOKEN)"}`);
});

// Close cleanly on container / terminal shutdown; synchronous stores have no
// background writes left to flush.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    server.closeIdleConnections();
  });
}
