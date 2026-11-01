/** Small shared HTTP helpers for the node:http routes (server.ts and auth/http.ts). */

import { type IncomingMessage, type ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function readJson(req: IncomingMessage): Promise<any> {
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

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
    ...headers,
  });
  res.end(text);
}
