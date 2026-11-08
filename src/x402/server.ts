/**
 * Mnemosyne HTTP API (docs/BUILD_PLAN.md section 11), on node:http only.
 *
 *   GET  /health                 free
 *   GET  /memory/latest          free   on-chain memory head (NEAR RPC)
 *   POST /memory/check           x402   { query } -> match + citation only
 *   GET  /memory/receipt/:id     free   proof a check was paid + answered
 *   POST /memory/confess         admin  append a rule after a real failure
 *   GET  /audit                  free   recent paid checks + chain links
 *   POST /cycle/run              admin  run one governor cycle
 *   GET  /dashboard              free   read-only dashboard page
 *   GET  /dashboard.json         free   its data (public records + chain + keys)
 *   GET  /limits                 free   the owner's risk limits + their hard bounds
 *   PUT  /limits                 admin  change limits (validated; applies from the next cycle)
 *   POST /limits/reset           admin  back to the built-in defaults
 *   GET  /schedule               free   the automatic-run schedule (on/off, interval, next run)
 *   PUT  /schedule               admin  change it (validated; the running loop picks it up next tick)
 *   GET  /login, /me, ...        session  NEAR wallet login, sign-up, personal guardrails (src/auth/http.ts)
 *
 * x402 flow for /memory/check:
 *   no PAYMENT-SIGNATURE  -> 402 + PAYMENT-REQUIRED (price, payTo, network)
 *   bad/insufficient pay  -> 402 + reason (nothing answered, nothing charged)
 *   valid payment         -> verify -> compute answer -> settle -> 200
 *                            + PAYMENT-RESPONSE header + receipt_id
 * The answer is only released after settlement succeeds.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { join } from "node:path";
import { HttpError, readJson, send } from "../http.js";
import { createAuthRoutes, type AuthRoutes } from "../auth/http.js";
import { AuthService } from "../auth/service.js";
import { JsonStore } from "./jsonStore.js";
import { MemoryStore, MAX_QUERY_CHARS, type CheckResult } from "./memoryStore.js";
import { b64json, canonicalJson, fromB64json, sha256Hex } from "./crypto.js";
import { requirementsError } from "./validation.js";
import type { Facilitator } from "./facilitator.js";
import { createMockRail, type PaymentRail, type WireRequirements } from "./rails.js";
import { nearRpc, readPayerStatus } from "./wrap.js";
import { createInboundQuoter, type InboundQuoter, type OneClickInboundOptions, type StoredQuote, type ChainSigConfig, type SettlementProof, SettlementError } from "../payments/inbound.js";
import { RateLimiter } from "../auth/rateLimit.js";
import {
  MOCK_TRANSFER_METHOD,
  X402_VERSION,
  type PaymentRequirements,
} from "./types.js";

export interface ServerConfig {
  dataDir: string;
  seedPath: string;
  /** Pin the public origin. If omitted, derive it from each request's Host
   *  and forwarded protocol so local and proxied clients get the same binding. */
  publicUrl?: string;
  payTo: string;
  network: string;
  asset: string;
  /** price per check in base units (yoctoNEAR) */
  priceAmount: string;
  maxTimeoutSeconds: number;
  /** Mock rail (default): payTo/network/asset/priceAmount above + this facilitator. */
  facilitator?: Facilitator;
  mockSettlement: boolean;
  /** Real settlement: a prebuilt rail (e.g. createNearExactRail). When set,
   *  it defines the payment terms; facilitator/asset/priceAmount are ignored. */
  rail?: PaymentRail;
  adminToken?: string;
  /** Lazily loaded so the API runs (and tests run) without near-api-js. */
  readChainHead?: () => Promise<{ latest_hash: string; prev_hash: string | null } | null>;
  runCycle?: () => Promise<unknown>;
  /** Read-only dashboard: page HTML and its data (chain head, cycles, keys). */
  dashboardHtml?: string;
  dashboardData?: () => Promise<Record<string, unknown>>;
  /** Static files under /dashboard/fonts/<name> (woff2 only). */
  dashboardFonts?: Record<string, Buffer>;
  /** Per-user NEAR login, sign-up and personal guardrails (src/auth). Off unless configured. */
  auth?: {
    rpcUrl: string;
    loginHtml?: string;
    loginScript?: Buffer;
    /** /pay: pay for one memory check with a connected wallet instead of the terminal demo. */
    payHtml?: string;
    /** tests only */
    fetch?: typeof fetch;
  };
  /** The owner's risk limits (src/limits). Reads are public, writes need the admin token. */
  limits?: {
    get: () => unknown;
    set: (changes: unknown, by: string) => { ok: true; view: unknown } | { ok: false; errors: string[] };
    reset: (by: string) => { ok: true; view: unknown } | { ok: false; errors: string[] };
  };
  /** Paying for a check from another chain (src/payments/inbound.ts).
   *  Absent means this server quotes NEAR and nothing else. */
  inboundQuotes?: {
    /** where a refund would go on the source chain, if any of this were ever real */
    refundTo: string;
    oneClick?: OneClickInboundOptions;
    /** present when this server can actually be paid on another chain:
     *  the governor's NEAR account derives a deposit address via Chain Signatures,
     *  and settlement is a balance check on that address. */
    chainSig?: ChainSigConfig;
    /** false to hide the 1Click quote-only routes (CROSS_CHAIN_PAYABLE without
     *  CROSS_CHAIN_INBOUND). Default true. */
    enableOneClickRoutes?: boolean;
  };
  /** The automatic cycle schedule (src/schedule). Reads are public, writes need the admin token. */
  schedule?: {
    get: () => unknown;
    set: (changes: unknown, by: string) => { ok: true; view: unknown } | { ok: false; errors: string[] };
  };
}

export interface Receipt {
  receipt_id: string;
  created_at: string;
  resource: string;
  payer: string;
  amount: string;
  asset: string;
  network: string;
  settlement: string;
  /** public explorer link for a real on-chain settlement */
  explorer: string | null;
  mock: boolean;
  /** sha256 of the canonical request body -- the query itself is NOT stored */
  request_sha256: string;
  /** sha256 of the canonical answer body minus receipt_id; lets the payer
   *  prove later exactly what it was told */
  answer_sha256: string;
  match: boolean;
  citation_id: string | null;
  /** Paying from another chain: where the money moved (present only then). */
  source_chain?: string;
  /** The address the payer sent to, controlled by the governor's NEAR account. */
  source_address?: string;
  /** Which NEAR account controls the address above. */
  source_controlled_by?: string;
}

const RECEIPT_ID = /^R-[0-9a-f]{24}$/;

function tokenOk(given: string | undefined, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createMnemosyneServer(cfg: ServerConfig): { server: Server; memory: MemoryStore; requirements: PaymentRequirements; rail: PaymentRail } {
  const memory = new MemoryStore(cfg.dataDir, cfg.seedPath);
  const receipts = new JsonStore<{ receipts: Record<string, Receipt> }>(join(cfg.dataDir, "receipts.json"), () => ({ receipts: {} }));
  // Cross-chain price quotes (Multi-chain Phase 1). Bound to a question and
  // single-use, so Phase 2 can redeem one exactly once. Nothing redeems them yet.
  const quotes = new JsonStore<{ quotes: Record<string, StoredQuote> }>(join(cfg.dataDir, "quotes.json"), () => ({ quotes: {} }));
  if (cfg.publicUrl !== undefined) cfg.publicUrl = normalizePublicUrl(cfg.publicUrl);

  function checkUrlFor(req: IncomingMessage): string {
    if (cfg.publicUrl !== undefined) return cfg.publicUrl + "/memory/check";
    const host = req.headers.host;
    const forwarded = req.headers["x-forwarded-proto"];
    const protocol = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "http";
    if (!host || !["http", "https"].includes(protocol)) throw new HttpError(400, "invalid public host");
    let origin: URL;
    try { origin = new URL(`${protocol}://${host}`); } catch { throw new HttpError(400, "invalid public host"); }
    if (origin.hostname === "" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new HttpError(400, "invalid public host");
    }
    return origin.origin + "/memory/check";
  }

  let rail: PaymentRail;
  if (cfg.rail) {
    rail = cfg.rail;
  } else {
    if (!cfg.facilitator) throw new Error("invalid server payment configuration: need a facilitator or a rail");
    const mockRequirements: PaymentRequirements = {
      scheme: "exact",
      network: cfg.network,
      amount: cfg.priceAmount,
      asset: cfg.asset,
      payTo: cfg.payTo,
      maxTimeoutSeconds: cfg.maxTimeoutSeconds,
      extra: {
        assetTransferMethod: MOCK_TRANSFER_METHOD,
        mock: cfg.mockSettlement,
        note: cfg.mockSettlement
          ? "Demo settlement: payments are fully verified (signature, payer key, amount, nonce) but recorded by a mock facilitator, not transferred on-chain."
          : "Settled by the configured x402 facilitator.",
      },
    };
    const requirementsIssue = requirementsError(mockRequirements);
    if (requirementsIssue) throw new Error(`invalid server payment configuration: ${requirementsIssue}`);
    rail = createMockRail(cfg.facilitator, mockRequirements, cfg.mockSettlement);
  }
  const requirements: WireRequirements = rail.requirements;

  // Paying from another chain: off unless the host wires a quoter (serve.ts
  // does, behind CROSS_CHAIN_INBOUND=1). Quote-only; see src/payments/inbound.ts.
  const inbound: InboundQuoter | undefined = cfg.inboundQuotes
    ? createInboundQuoter({
        price: () => requirements.amount,
        payTo: requirements.payTo,
        refundTo: cfg.inboundQuotes.refundTo,
        record: (q) => quotes.update((s) => { s.quotes[q.quote_id] = q; }),
        oneClick: cfg.inboundQuotes.oneClick,
        chainSig: cfg.inboundQuotes.chainSig,
        enableOneClickRoutes: cfg.inboundQuotes.enableOneClickRoutes,
        load: (quoteId) => quotes.get().quotes[quoteId],
        markUsed: (quoteId, at) => {
          const q = quotes.get().quotes[quoteId];
          if (!q || q.used_at) return false;
          quotes.update((next) => {
            const target = next.quotes[quoteId];
            if (target && !target.used_at) target.used_at = at;
          });
          return true;
        },
      })
    : undefined;

  // Per-user login, sign-up and guardrails. Identity and personal policy only; see src/auth/service.ts.
  let auth: AuthRoutes | undefined;
  if (cfg.auth) {
    const service = new AuthService({
      dataDir: cfg.dataDir,
      rpcUrl: cfg.auth.rpcUrl,
      fetch: cfg.auth.fetch,
      paidChecks: (payer) => Object.values(receipts.get().receipts).filter((r) => r.payer === payer).map((r) => ({ at: r.created_at, amount: r.amount })),
    });
    auth = createAuthRoutes({
      service,
      publicUrl: cfg.publicUrl,
      price: () => BigInt(requirements.amount),
      loginHtml: cfg.auth.loginHtml,
      loginScript: cfg.auth.loginScript,
      payHtml: cfg.auth.payHtml,
      // Only on a rail that moves real tokens: the mock rail settles into a
      // local ledger, so there is never anything to wrap.
      payerStatus: rail.mock ? undefined : (accountId) => readPayerStatus({
        rpc: nearRpc(cfg.auth!.rpcUrl, cfg.auth!.fetch),
        accountId,
        asset: requirements.asset,
        price: BigInt(requirements.amount),
      }),
      receiptsFor: (payer, limit) =>
        Object.values(receipts.get().receipts)
          .filter((r) => r.payer === payer)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, limit)
          .map((r) => ({ receipt_id: r.receipt_id, at: r.created_at, amount: r.amount, match: r.match, citation_id: r.citation_id, settlement: r.settlement, explorer: r.explorer ?? null, mock: r.mock })),
    });
  }
  const isMock = rail.mock;
  const adminFailures: number[] = [];

  const paymentRequired = (error: string, checkUrl: string) => ({
    x402Version: X402_VERSION,
    error,
    resource: {
      url: checkUrl,
      description: "Mnemosyne memory check: does this situation match a known failure? Returns match + citation id + public advice only.",
      mimeType: "application/json",
    },
    accepts: [requirements],
  });

  const require402 = (res: ServerResponse, error: string, checkUrl: string) => {
    const body = paymentRequired(error, checkUrl);
    send(res, 402, body, { "PAYMENT-REQUIRED": b64json(body) });
  };

  /**
   * Compute the answer and write the receipt -- shared by the NEAR path and
   * the payable-from-another-chain path. The answer is only released after
   * settlement succeeds; both paths settle first. `resource` is the URL the
   * answer was requested at (/memory/check).
   */
  function answerAndReceipt(resource: string, query: string, result: CheckResult, settled: {
    payer: string;
    amount: string;
    asset: string;
    network: string;
    settlement: string;
    explorer: string | null;
    mock: boolean;
    /** paying from another chain: where the money moved */
    source_chain?: string;
    /** the address the payer sent to */
    source_address?: string;
    /** the NEAR account that controls the address above */
    source_controlled_by?: string;
  }): { answer: Record<string, unknown>; receipt: Receipt } {
    const answer = {
      match: result.match,
      citation_id: result.citation_id,
      category: result.category,
      advice: result.advice,
      score: result.score,
    };
    const receipt: Receipt = {
      receipt_id: "R-" + randomBytes(12).toString("hex"),
      created_at: new Date().toISOString(),
      resource,
      payer: settled.payer,
      amount: settled.amount,
      asset: settled.asset,
      network: settled.network,
      settlement: settled.settlement,
      explorer: settled.explorer,
      mock: settled.mock,
      request_sha256: sha256Hex(canonicalJson({ query })),
      answer_sha256: sha256Hex(canonicalJson(answer)),
      match: result.match,
      citation_id: result.citation_id,
      ...(settled.source_chain ? { source_chain: settled.source_chain } : {}),
      ...(settled.source_address ? { source_address: settled.source_address } : {}),
      ...(settled.source_controlled_by ? { source_controlled_by: settled.source_controlled_by } : {}),
    };
    return { answer, receipt };
  }

  async function handleCheck(req: IncomingMessage, res: ServerResponse) {
    const checkUrl = checkUrlFor(req);
    auth?.guardSession(req); // a paused or capped signed-in browser gets 403/429 before any 402
    const body = await readJson(req);
    const query = body?.query;
    if (typeof query !== "string" || query.trim().length === 0) throw new HttpError(400, 'body must be {"query": "<text>"}');
    if (query.length > MAX_QUERY_CHARS) throw new HttpError(400, `query longer than ${MAX_QUERY_CHARS} chars`);

    // Redeeming a payable quote: the payment already happened on another
    // chain (Base Sepolia). Settle against the address the quote pointed to,
    // then answer exactly like the NEAR path. Nothing here touches a
    // payment-signature header or the NEAR rail.
    const quoteId = typeof body?.quote_id === "string" && body.quote_id.length > 0 ? body.quote_id : null;
    if (quoteId) {
      if (!inbound || typeof inbound.settle !== "function") {
        return require402(res, "this server does not take payment from another chain", checkUrl);
      }
      let proof: SettlementProof;
      try {
        proof = await inbound.settle({ query, quoteId });
      } catch (err) {
        if (err instanceof SettlementError) return require402(res, err.message, checkUrl);
        throw new HttpError(502, `settlement check failed: ${(err as Error).message}`);
      }
      const result: CheckResult = memory.check(query);
      const { answer, receipt } = answerAndReceipt(checkUrl, query, result, {
        payer: proof.controlled_by,
        amount: proof.source_amount,
        asset: proof.source_asset,
        network: proof.source_chain,
        settlement: `chain-signature settlement on ${proof.source_chain}`,
        explorer: proof.explorer,
        mock: false,
        source_chain: proof.source_chain,
        source_address: proof.deposit_address,
        source_controlled_by: proof.controlled_by,
      });
      receipts.update((r) => { r.receipts[receipt.receipt_id] = receipt; });
      return send(res, 200, { ...answer, receipt_id: receipt.receipt_id }, {
        "PAYMENT-RESPONSE": b64json({ ok: true, receipt_id: receipt.receipt_id, source_chain: proof.source_chain }),
      });
    }

    const header = req.headers["payment-signature"];
    if (typeof header !== "string" || header.length === 0) return require402(res, "payment required", checkUrl);

    let payment: unknown;
    try {
      payment = rail.decode(header);
    } catch {
      return require402(res, "invalid_payment_header", checkUrl);
    }
    const bindingIssue = rail.bindingError(payment, checkUrl);
    if (bindingIssue) return require402(res, bindingIssue, checkUrl);

    const v = await rail.verify(payment);
    if (!v?.isValid) return require402(res, v?.invalidReason ?? "invalid_payment", checkUrl);
    if (typeof v.payer !== "string" || v.payer.length === 0) throw new HttpError(502, "invalid facilitator verification");
    const verifiedPayer = v.payer;
    auth?.guardPayer(verifiedPayer); // the paying account's own limits, before anything is settled

    // Compute, then settle, then release. If settlement fails, the payer
    // gets nothing and isn't charged.
    const result: CheckResult = memory.check(query);
    const settlement = await rail.settle(payment);
    if (!settlement?.success) return require402(res, settlement?.errorReason ?? "settlement_failed", checkUrl);
    const settlementIssue = rail.settlementIssue(settlement, verifiedPayer);
    // Do not ask for a second payment when settlement succeeded but its proof
    // is inconsistent. Surface an upstream error instead.
    if (settlementIssue) throw new HttpError(502, settlementIssue);
    const transaction = settlement.transaction;
    if (!transaction) throw new HttpError(502, "invalid_settlement_transaction");
    const { answer, receipt } = answerAndReceipt(checkUrl, query, result, {
      payer: verifiedPayer,
      amount: requirements.amount,
      asset: requirements.asset,
      network: settlement.network,
      settlement: transaction,
      explorer: rail.explorerUrl(transaction),
      mock: isMock,
    });
    receipts.update((r) => { r.receipts[receipt.receipt_id] = receipt; });
    send(res, 200, { ...answer, receipt_id: receipt.receipt_id }, { "PAYMENT-RESPONSE": rail.responseHeader(settlement) });
  }

  /**
   * A price for paying from another chain (Multi-chain Phase 1).
   *
   * QUOTE ONLY. This hands back what a payer would send on Base for the
   * listed price to arrive on NEAR; it settles nothing, and `/memory/check`
   * does not accept a quote id. Asking for a price costs nothing and records
   * no usage, exactly like the unpaid 402 on the NEAR path.
   *
   * NEAR itself stays the default and is answered from the rail's own terms,
   * so a caller can use one endpoint for every chain and still get the
   * unchanged NEAR price.
   */
  const quoteLimiter = new RateLimiter(20, 60_000);
  async function handleQuote(req: IncomingMessage, res: ServerResponse) {
    auth?.guardSession(req);
    const body = await readJson(req);
    const query = body?.query;
    if (typeof query !== "string" || query.trim().length === 0) throw new HttpError(400, 'body must be {"query": "<text>"}');
    if (query.length > MAX_QUERY_CHARS) throw new HttpError(400, `query longer than ${MAX_QUERY_CHARS} chars`);

    const chain = typeof body?.chain === "string" && body.chain.trim() ? body.chain.trim() : "near";
    const available = inbound ? inbound.routes().map((r) => r.key) : [];

    if (chain === "near") {
      return send(res, 200, {
        chain: "near",
        chain_label: "NEAR",
        asset: requirements.asset,
        amount: requirements.amount,
        pay_to: requirements.payTo,
        network: requirements.network,
        mock_settlement: isMock,
        quote_only: false,
        how: "Pay this on NEAR through /memory/check, the way the 402 describes.",
        other_chains: available,
      });
    }

    if (!inbound) throw new HttpError(503, "this server quotes NEAR only; paying from another chain is not configured");
    if (!available.includes(chain)) throw new HttpError(400, `unknown chain "${chain}"; this server quotes ${["near", ...available].join(", ")}`);
    if (!quoteLimiter.allow(req.socket.remoteAddress ?? "unknown")) throw new HttpError(429, "too many price requests; wait a minute");

    let decisionHash: string | null = null;
    try { decisionHash = (await cfg.readChainHead?.())?.latest_hash ?? null; } catch { decisionHash = null; }

    try {
      return send(res, 200, await inbound.quote({ query, routeKey: chain, decisionHash }));
    } catch (err) {
      // The cross-chain provider being down must never take the NEAR path with
      // it: say so, and say what still works.
      throw new HttpError(503, `${(err as Error).message}. Paying in ${requirements.asset} on NEAR still works.`);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const admin = () => {
      if (!cfg.adminToken) throw new HttpError(503, "admin routes disabled (set ADMIN_TOKEN)");
      // too many wrong tokens in a minute: stop answering for a while
      const now = Date.now();
      while (adminFailures.length && now - adminFailures[0] > 60_000) adminFailures.shift();
      if (adminFailures.length >= 10) throw new HttpError(429, "too many wrong tokens; wait a minute");
      const auth = req.headers.authorization ?? "";
      const given = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!tokenOk(given, cfg.adminToken)) { adminFailures.push(now); throw new HttpError(401, "admin token required"); }
    };

    if (auth && (await auth.handle(req, res, path, method))) return;

    if (method === "GET" && path === "/" && cfg.dashboardHtml && String(req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(302, { location: "/dashboard" });
      return res.end();
    }
    if (method === "GET" && path === "/dashboard") {
      if (!cfg.dashboardHtml) throw new HttpError(404, "dashboard not configured");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
          "font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      return res.end(cfg.dashboardHtml);
    }
    if (method === "GET" && path.startsWith("/dashboard/fonts/")) {
      const font = cfg.dashboardFonts?.[path.slice("/dashboard/fonts/".length)];
      if (!font) throw new HttpError(404, "not found");
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });
      return res.end(font);
    }
    if (method === "GET" && path === "/admin/check") {
      admin();
      return send(res, 200, { ok: true });
    }
    if (method === "GET" && path === "/dashboard.json") {
      if (!cfg.dashboardData) throw new HttpError(404, "dashboard not configured");
      const data = await cfg.dashboardData();
      const all = Object.values(receipts.get().receipts).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return send(res, 200, {
        ...data,
        // the page hides the operator controls unless this is true; it never carries the token
        operator: { enabled: !!cfg.adminToken },
        limits: cfg.limits ? cfg.limits.get() : null,
        schedule: cfg.schedule ? cfg.schedule.get() : null,
        x402: {
          payment_rail: rail.mode,
          mock_settlement: isMock,
          price: requirements.amount,
          asset: requirements.asset,
          pay_to: requirements.payTo,
          memory_entries: memory.size,
          paid_checks_total: all.length,
          // Chains a price can be asked for. NEAR is always there and always
          // the one that can actually be paid; the rest are quote-only today.
          chains: [
            { key: "near", label: "NEAR", asset: requirements.asset, quote_only: false },
            ...(inbound ? inbound.routes().map((r) => ({ key: r.key, label: `${r.chain_label} ${r.symbol}`, asset: r.symbol, quote_only: !r.payable })) : []),
          ],
          recent: all.slice(0, 12).map((r) => ({
            receipt_id: r.receipt_id, at: r.created_at, payer: r.payer, amount: r.amount,
            match: r.match, citation_id: r.citation_id, settlement: r.settlement, explorer: r.explorer ?? null, mock: r.mock,
          })),
        },
      });
    }
    if (method === "GET" && path === "/") {
      return send(res, 200, {
        name: "mnemosyne",
        routes: {
          "GET /health": "free",
          "GET /memory/latest": "free -- on-chain memory head",
          "POST /memory/check": `x402 -- ${requirements.amount} ${requirements.asset} base units per check${isMock ? " (mock settlement)" : ` (real ${requirements.network} settlement)`}`,
          "GET /memory/receipt/:id": "free",
          "GET /audit": "free",
          "POST /memory/confess": "admin",
          "POST /cycle/run": "admin",
          ...(cfg.dashboardHtml ? { "GET /dashboard": "free -- read-only dashboard", "GET /dashboard.json": "free" } : {}),
          ...(cfg.adminToken ? { "GET /admin/check": "admin token -- says whether the token is right, changes nothing" } : {}),
          ...(cfg.limits ? { "GET /limits": "free", "PUT /limits": "admin", "POST /limits/reset": "admin" } : {}),
          ...(cfg.schedule ? { "GET /schedule": "free", "PUT /schedule": "admin" } : {}),
          ...(auth ? { "GET /login": "sign in / sign up with a NEAR wallet", "GET /me": "session", "PUT /me/guardrails": "session", "GET /me/receipts": "session" } : {}),
        },
      });
    }
    if (method === "GET" && path === "/health") {
      return send(res, 200, {
        ok: true, memory_entries: memory.size, payTo: requirements.payTo, network: requirements.network,
        asset: requirements.asset, price: requirements.amount, payment_rail: rail.mode, mock_settlement: isMock,
      });
    }
    if (method === "POST" && path === "/memory/check") return handleCheck(req, res);
    if (method === "POST" && path === "/memory/quote") return handleQuote(req, res);

    if (method === "GET" && path.startsWith("/memory/receipt/")) {
      const id = path.slice("/memory/receipt/".length);
      if (!RECEIPT_ID.test(id)) throw new HttpError(400, "bad receipt id");
      const r = receipts.get().receipts[id];
      if (!r) throw new HttpError(404, "no such receipt");
      return send(res, 200, r);
    }

    if (method === "GET" && path === "/memory/latest") {
      if (!cfg.readChainHead) throw new HttpError(503, "chain reader not configured");
      try {
        const head = await cfg.readChainHead();
        return send(res, 200, head
          ? { ...head, contract: cfg.payTo, explorer: `https://testnet.nearblocks.io/address/${cfg.payTo}` }
          : { latest_hash: null, note: "no commits yet" });
      } catch (err) {
        throw new HttpError(502, `could not read chain: ${(err as Error).message}`);
      }
    }

    if (method === "GET" && path === "/audit") {
      const all = Object.values(receipts.get().receipts).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return send(res, 200, {
        governor_contract: `https://testnet.nearblocks.io/address/${cfg.payTo}`,
        paid_checks_total: all.length,
        mock_settlement: isMock,
        payment_rail: rail.mode,
        recent: all.slice(0, 20).map((r) => ({
          receipt_id: r.receipt_id,
          at: r.created_at,
          payer: r.payer,
          amount: r.amount,
          match: r.match,
          citation_id: r.citation_id,
          settlement: r.settlement,
          explorer: r.explorer ?? null,
        })),
      });
    }

    if (method === "POST" && path === "/memory/confess") {
      admin();
      const b = await readJson(req);
      const ok =
        typeof b?.category === "string" && b.category.length > 0 && b.category.length <= 64 &&
        Array.isArray(b?.keywords) && b.keywords.length >= 3 && b.keywords.length <= 30 &&
        b.keywords.every((k: unknown) => typeof k === "string" && /^[a-z0-9]{2,32}$/.test(k)) &&
        typeof b?.public_summary === "string" && b.public_summary.length >= 10 && b.public_summary.length <= 500 &&
        typeof b?.private_detail === "string" && b.private_detail.length <= 4000;
      if (!ok) throw new HttpError(400, "need category, keywords (3-30 lowercase words), public_summary (10-500 chars), private_detail");
      const id = memory.confess({ category: b.category, keywords: b.keywords, public_summary: b.public_summary, private_detail: b.private_detail });
      return send(res, 201, { citation_id: id });
    }

    if (method === "GET" && path === "/limits") {
      if (!cfg.limits) throw new HttpError(404, "limits not configured");
      return send(res, 200, cfg.limits.get());
    }
    if (method === "PUT" && path === "/limits") {
      admin();
      if (!cfg.limits) throw new HttpError(404, "limits not configured");
      const r = cfg.limits.set(await readJson(req), "owner-token");
      if (!r.ok) return send(res, 400, { error: "invalid limits", errors: r.errors });
      return send(res, 200, r.view);
    }
    if (method === "POST" && path === "/limits/reset") {
      admin();
      if (!cfg.limits) throw new HttpError(404, "limits not configured");
      const r = cfg.limits.reset("owner-token");
      if (!r.ok) return send(res, 400, { error: "invalid limits", errors: r.errors });
      return send(res, 200, r.view);
    }

    if (method === "GET" && path === "/schedule") {
      if (!cfg.schedule) throw new HttpError(404, "schedule not configured");
      return send(res, 200, cfg.schedule.get());
    }
    if (method === "PUT" && path === "/schedule") {
      admin();
      if (!cfg.schedule) throw new HttpError(404, "schedule not configured");
      const r = cfg.schedule.set(await readJson(req), "owner-token");
      if (!r.ok) return send(res, 400, { error: "invalid schedule", errors: r.errors });
      return send(res, 200, r.view);
    }

    if (method === "POST" && path === "/cycle/run") {
      admin();
      if (!cfg.runCycle) throw new HttpError(503, "cycle runner not configured");
      const result = await cfg.runCycle();
      return send(res, 200, { ran: true, result });
    }

    throw new HttpError(404, "not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error("[server] unexpected error:", err);
      send(res, 500, { error: "internal error" });
    });
  });

  return { server, memory, requirements: requirements as unknown as PaymentRequirements, rail };
}

function normalizePublicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("PUBLIC_URL must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_URL must be an HTTP(S) origin without credentials, query, or fragment");
  }
  return url.href.replace(/\/+$/, "");
}
