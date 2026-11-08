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
 *   LOGIN                     "0" turns off NEAR wallet login and sign-up (/login, /me); default on
 *   ADMIN_TOKEN               enables POST /memory/confess, POST /cycle/run and changing the
 *                             risk limits (PUT /limits, the dashboard's Your limits panel)
 *   DATA_DIR                  default data/runtime (gitignored)
 *   SCHEDULE_TICK_MS          how often the server checks whether an automatic cycle is due;
 *                             default 60000 (1 minute). The schedule itself (on/off, interval)
 *                             is set at runtime via PUT /schedule, not an env var, so it survives
 *                             without a restart and the dashboard can show it to everyone.
 *
 * Real settlement (testnet only):
 *   X402_RAIL=near-testnet    official x402 NEAR "exact" scheme, wNEAR, real txs
 *   X402_ASSET                NEP-141 token, default wrap.testnet (wNEAR)
 *   X402_PRICE                price in token units, default 1e21 (0.001 wNEAR)
 *   X402_RELAYER_ACCOUNT_ID   pays gas for settlements; default GOVERNOR_ACCOUNT_ID
 *   X402_RELAYER_PRIVATE_KEY  full-access key of that account; default GOVERNOR_PRIVATE_KEY
 */

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMnemosyneServer } from "./x402/server.js";
import { evmRpc, BASE_SEPOLIA_RPC } from "./payments/evm.js";
import { MPC_CONTRACT_TESTNET } from "./payments/chainsig.js";
import { limitsView, resetLimits, saveLimits } from "./limits/index.js";
import { recordRun as recordScheduleRun, saveSchedule, scheduleView, tick as scheduleTick } from "./schedule.js";
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

/** A read-only NEAR view call: free, no signature, nothing changes on-chain.
 *  Used to ask the MPC contract what key it derives for our deposit address. */
async function nearViewCall(params: {
  account_id: string;
  method_name: string;
  args_base64: string;
  finality?: "final" | "optimistic";
}): Promise<any> {
  const r = await fetch(RPC_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "mnemosyne-csig", method: "query",
      params: { request_type: "call_function", finality: "final", ...params },
    }),
  });
  if (!r.ok) throw new Error(`the NEAR node answered ${r.status}`);
  const j: any = await r.json();
  if (j.error) throw new Error(`the NEAR node refused the call: ${String(j.error.message ?? "").slice(0, 200)}`);
  return j.result?.result ?? null;
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

// A manual run (POST /cycle/run) and the automatic schedule share this one
// mutex, so a click from the dashboard and a due tick can never run two
// cycles at once -- whichever gets here first wins, and the other is told
// a cycle is already running rather than racing it.
let cycleBusy = false;
async function runGovernorCycle() {
  if (cycleBusy) throw new Error("a cycle is already running");
  cycleBusy = true;
  try {
    const { runCycle } = await import("./cycle.js");
    return await runCycle();
  } finally {
    cycleBusy = false;
  }
}

const realFacilitatorUrl = process.env.X402_FACILITATOR_URL;
const facilitator: Facilitator = realFacilitatorUrl
  ? new HttpFacilitator(realFacilitatorUrl, process.env.X402_FACILITATOR_API_KEY)
  : new MockFacilitator(DATA_DIR, {
      checkNamedAccountKey: process.env.X402_VERIFY_NAMED_PAYERS === "1" ? keyBelongsToAccount : undefined,
    });

// Paying for a check from another chain. CROSS_CHAIN_INBOUND=1 prices it
// (1Click, quote-only). CROSS_CHAIN_PAYABLE=1 goes further: the payer sends
// Base Sepolia ETH to an address the governor's NEAR account derives through
// Chain Signatures, and settlement is a balance check on it -- nothing is
// deployed or bridged anywhere (docs/CROSS_CHAIN.md).
const PAYABLE = process.env.CROSS_CHAIN_PAYABLE === "1";
const chainSig = PAYABLE ? {
  predecessor: GOVERNOR,
  mpcContract: process.env.MPC_CONTRACT ?? MPC_CONTRACT_TESTNET,
  nearRpc: async (method: string, params: unknown) => {
    if (method !== "query") throw new Error(`unsupported NEAR call ${method}`);
    return nearViewCall(params as { account_id: string; method_name: string; args_base64: string; finality?: "final" | "optimistic" });
  },
  evmRpc: evmRpc(process.env.BASE_SEPOLIA_RPC_URL ?? BASE_SEPOLIA_RPC),
  priceWei: process.env.CROSS_CHAIN_PRICE_WEI ?? "10000000000000",
} : undefined;

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
  // Paying for a check from another chain. Off by default: it either reaches
  // a mainnet pricing API (CROSS_CHAIN_INBOUND) or derives Chain Signature
  // addresses on NEAR testnet (CROSS_CHAIN_PAYABLE). Either flag, or both,
  // turns it on; see docs/CROSS_CHAIN.md.
  inboundQuotes: (process.env.CROSS_CHAIN_INBOUND === "1" || PAYABLE) ? {
    refundTo: GOVERNOR,
    // Show the 1Click quote-only routes (base:USDC) only when CROSS_CHAIN_INBOUND
    // is on. CROSS_CHAIN_PAYABLE alone should not drag in a mainnet pricing API.
    enableOneClickRoutes: process.env.CROSS_CHAIN_INBOUND === "1",
    // The route that can actually be paid. Nothing bridges to NEAR testnet,
    // so the payer pays on Base Sepolia and the governor receives there, at
    // an address only GOVERNOR can spend from via Chain Signatures. Nothing
    ...(PAYABLE ? { chainSig } : {}),
  } : undefined,
  readChainHead: async () => {
    const { getLatestMemoryRecord } = await import("./memory.js");
    const rec = await getLatestMemoryRecord(GOVERNOR);
    return rec ? { latest_hash: rec.decision_hash, prev_hash: rec.prev_memory_hash } : null;
  },
  dashboardHtml: readFileSync(join(REPO_ROOT, "web/dashboard.html"), "utf8"),
  dashboardFonts: Object.fromEntries(
    readdirSync(join(REPO_ROOT, "web/fonts")).filter((f) => f.endsWith(".woff2")).map((f) => [f, readFileSync(join(REPO_ROOT, "web/fonts", f))])
  ),
  auth: process.env.LOGIN === "0" ? undefined : {
    rpcUrl: RPC_URL,
    loginHtml: readFileSync(join(REPO_ROOT, "web/login.html"), "utf8"),
    loginScript: readFileSync(join(REPO_ROOT, "web/vendor/near-connect.js")),
    payHtml: readFileSync(join(REPO_ROOT, "web/pay.html"), "utf8"),
  },
  dashboardData: async () => {
    const { buildDashboard } = await import("./dashboard/data.js");
    const { getChainHead } = await import("./memory.js");
    return buildDashboard({ dataDir: DATA_DIR, contract: GOVERNOR, readHead: () => getChainHead(GOVERNOR) });
  },
  limits: {
    get: () => limitsView(DATA_DIR),
    set: (changes, by) => saveLimits(DATA_DIR, changes, by),
    reset: (by) => resetLimits(DATA_DIR, by),
  },
  schedule: {
    get: () => scheduleView(DATA_DIR),
    set: (changes, by) => saveSchedule(DATA_DIR, changes, by),
  },
  runCycle: async () => {
    const r = await runGovernorCycle();
    // A manual run counts the same as a scheduled one: it resets the clock
    // and the failure streak, so clicking "Run cycle" never leaves the
    // automatic schedule thinking it is still owed a run from before.
    recordScheduleRun(DATA_DIR, { committed: r.committed, error: r.committed ? null : "the cycle did not commit" });
    // Public parts only. privateDecision (the reasoning) never leaves.
    return {
      committed: r.committed,
      cycle_id: r.memoryRecord.cycle_id,
      decision_hash: r.memoryRecord.decision_hash,
      prev_memory_hash: r.memoryRecord.prev_memory_hash,
      decisions: r.memoryRecord.decisions,
      decision_path: r.memoryRecord.decision_path,
      private_commitment: r.memoryRecord.private_commitment,
      tee: r.memoryRecord.tee ?? null,
      reports: r.reports ?? [],
    };
  },
});

// The automatic schedule's own clock: roughly once a minute, check whether
// a run is due and nothing else is in flight. The schedule starts wherever
// PUT /schedule last left it (off, by default) -- a restart does not turn
// it on by itself.
const SCHEDULE_TICK_MS = Number(process.env.SCHEDULE_TICK_MS ?? 60_000);
if (!Number.isFinite(SCHEDULE_TICK_MS) || SCHEDULE_TICK_MS < 1000) throw new Error("SCHEDULE_TICK_MS must be a number of milliseconds, at least 1000");
const scheduleTimer = setInterval(() => {
  scheduleTick({
    dataDir: DATA_DIR,
    isBusy: () => cycleBusy,
    runCycle: async () => {
      const r = await runGovernorCycle();
      return { committed: r.committed, error: r.committed ? null : "the cycle did not commit" };
    },
  }).catch((err) => console.error("[schedule] tick failed:", err));
}, SCHEDULE_TICK_MS);
scheduleTimer.unref(); // the schedule never keeps the process alive on its own

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
  console.log(`  login:        ${process.env.LOGIN === "0" ? "off (LOGIN=0)" : `NEAR wallet sign-in and sign-up at http://localhost:${actualPort}/login`}`);
  console.log(`  dashboard:    http://localhost:${actualPort}/dashboard  (read-only${process.env.ADMIN_TOKEN ? "; limits can be changed with the admin token" : "; set ADMIN_TOKEN to be able to change limits"})`);
  const sched = scheduleView(DATA_DIR);
  console.log(`  schedule:     ${sched.enabled ? `on, every ${sched.interval_minutes} min` : "off"} (change it at PUT /schedule, or the dashboard's Settings panel)`);
});

// Close cleanly on container / terminal shutdown; synchronous stores have no
// background writes left to flush.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(scheduleTimer);
    server.close();
    server.closeIdleConnections();
  });
}
