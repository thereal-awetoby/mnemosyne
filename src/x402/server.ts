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
import { JsonStore } from "./jsonStore.js";
import { MemoryStore, MAX_QUERY_CHARS, type CheckResult } from "./memoryStore.js";
import { b64json, canonicalJson, fromB64json, sha256Hex } from "./crypto.js";
import type { Facilitator } from "./facilitator.js";
import {
  MOCK_TRANSFER_METHOD,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "./types.js";

export interface ServerConfig {
  dataDir: string;
  seedPath: string;
  /** Public base URL; payments are bound to `${publicUrl}/memory/check`. */
  publicUrl: string;
  payTo: string;
  network: string;
  asset: string;
  /** price per check in base units (yoctoNEAR) */
  priceAmount: string;
  maxTimeoutSeconds: number;
  facilitator: Facilitator;
  mockSettlement: boolean;
  adminToken?: string;
  /** Lazily loaded so the API runs (and tests run) without near-api-js. */
  readChainHead?: () => Promise<{ latest_hash: string; prev_hash: string | null } | null>;
  runCycle?: () => Promise<unknown>;
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
  mock: boolean;
  /** sha256 of the canonical request body -- the query itself is NOT stored */
  request_sha256: string;
  /** sha256 of the canonical answer body minus receipt_id; lets the payer
   *  prove later exactly what it was told */
  answer_sha256: string;
  match: boolean;
  citation_id: string | null;
}

const MAX_BODY_BYTES = 16 * 1024;
const RECEIPT_ID = /^R-[0-9a-f]{24}$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    ...headers,
  });
  res.end(text);
}

function tokenOk(given: string | undefined, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createMnemosyneServer(cfg: ServerConfig): { server: Server; memory: MemoryStore; requirements: PaymentRequirements } {
  const memory = new MemoryStore(cfg.dataDir, cfg.seedPath);
  const receipts = new JsonStore<{ receipts: Record<string, Receipt> }>(join(cfg.dataDir, "receipts.json"), () => ({ receipts: {} }));
  const checkUrl = cfg.publicUrl.replace(/\/$/, "") + "/memory/check";

  const requirements: PaymentRequirements = {
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

  const paymentRequired = (error: string): PaymentRequired => ({
    x402Version: X402_VERSION,
    error,
    resource: {
      url: checkUrl,
      description: "Mnemosyne memory check: does this situation match a known failure? Returns match + citation id + public advice only.",
      mimeType: "application/json",
    },
    accepts: [requirements],
  });

  const require402 = (res: ServerResponse, error: string) => {
    const body = paymentRequired(error);
    send(res, 402, body, { "PAYMENT-REQUIRED": b64json(body) });
  };

  async function handleCheck(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req);
    const query = body?.query;
    if (typeof query !== "string" || query.trim().length === 0) throw new HttpError(400, 'body must be {"query": "<text>"}');
    if (query.length > MAX_QUERY_CHARS) throw new HttpError(400, `query longer than ${MAX_QUERY_CHARS} chars`);

    const header = req.headers["payment-signature"];
    if (typeof header !== "string" || header.length === 0) return require402(res, "payment required");

    let payment: PaymentPayload;
    try {
      payment = fromB64json<PaymentPayload>(header);
    } catch {
      return require402(res, "invalid_payment_header");
    }
    if (payment?.payload?.authorization?.resource !== checkUrl) return require402(res, "payment not bound to this resource");

    const v = await cfg.facilitator.verify(payment, requirements);
    if (!v.isValid) return require402(res, v.invalidReason ?? "invalid_payment");

    // Compute, then settle, then release. If settlement fails, the payer
    // gets nothing and isn't charged.
    const result: CheckResult = memory.check(query);
    const settlement = await cfg.facilitator.settle(payment, requirements);
    if (!settlement.success || !settlement.transaction) return require402(res, settlement.errorReason ?? "settlement_failed");

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
      resource: checkUrl,
      payer: settlement.payer ?? payment.payload.authorization.from,
      amount: settlement.amount ?? payment.payload.authorization.value,
      asset: requirements.asset,
      network: settlement.network,
      settlement: settlement.transaction,
      mock: cfg.mockSettlement,
      request_sha256: sha256Hex(canonicalJson({ query })),
      answer_sha256: sha256Hex(canonicalJson(answer)),
      match: result.match,
      citation_id: result.citation_id,
    };
    receipts.update((r) => {
      r.receipts[receipt.receipt_id] = receipt;
    });
    send(res, 200, { ...answer, receipt_id: receipt.receipt_id }, { "PAYMENT-RESPONSE": b64json({ ...settlement, mock: cfg.mockSettlement }) });
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const admin = () => {
      if (!cfg.adminToken) throw new HttpError(503, "admin routes disabled (set ADMIN_TOKEN)");
      const auth = req.headers.authorization ?? "";
      const given = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!tokenOk(given, cfg.adminToken)) throw new HttpError(401, "admin token required");
    };

    if (method === "GET" && path === "/") {
      return send(res, 200, {
        name: "mnemosyne",
        routes: {
          "GET /health": "free",
          "GET /memory/latest": "free -- on-chain memory head",
          "POST /memory/check": `x402 -- ${cfg.priceAmount} ${cfg.asset} base units per check${cfg.mockSettlement ? " (mock settlement)" : ""}`,
          "GET /memory/receipt/:id": "free",
          "GET /audit": "free",
          "POST /memory/confess": "admin",
          "POST /cycle/run": "admin",
        },
      });
    }
    if (method === "GET" && path === "/health") {
      return send(res, 200, { ok: true, memory_entries: memory.size, payTo: cfg.payTo, network: cfg.network, mock_settlement: cfg.mockSettlement });
    }
    if (method === "POST" && path === "/memory/check") return handleCheck(req, res);

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
        mock_settlement: cfg.mockSettlement,
        recent: all.slice(0, 20).map((r) => ({
          receipt_id: r.receipt_id,
          at: r.created_at,
          payer: r.payer,
          amount: r.amount,
          match: r.match,
          citation_id: r.citation_id,
          settlement: r.settlement,
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

  return { server, memory, requirements };
}
