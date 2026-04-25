import type { IncomingMessage, ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AuthError, extractCredsFromHeaders } from "../src/auth.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "../src/server.js";

export const runtime = "nodejs";

const TOOL_COUNT = 29;

/**
 * Vercel Node-runtime entry. Bridges (req, res) ↔ Web Standard Request/Response,
 * then delegates to the SDK's WebStandardStreamableHTTPServerTransport.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const request = await nodeReqToFetchRequest(req);
    const response = await handle(request);
    await writeFetchResponseToNode(response, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
    }
    res.end(JSON.stringify({ error: "internal_error", message }));
  }
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Health check on GET (no creds required)
  if (
    request.method === "GET" &&
    !request.headers.get("accept")?.includes("text/event-stream")
  ) {
    return json({
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      tools: TOOL_COUNT,
      endpoint: url.origin + url.pathname,
      note: "POST JSON-RPC here with headers: Authorization, X-Icount-Cid, optional X-Icount-Dry-Run, optional X-Mcp-Key.",
    });
  }

  // Per-request credential extraction.
  let creds;
  try {
    creds = extractCredsFromHeaders(request.headers, {
      MCP_ACCESS_KEY: process.env.MCP_ACCESS_KEY,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return json({ error: e.message, hint: e.hint }, e.status);
    }
    throw e;
  }

  const server = buildServer(creds);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => {});
  }
}

// ─────────────────────── Node ↔ Fetch adapters ───────────────────────

async function nodeReqToFetchRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const url = new URL(req.url ?? "/", `${proto}://${host}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((item) => headers.append(k, item));
    else headers.set(k, v);
  }

  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    init.body = Buffer.concat(chunks);
  }

  return new Request(url.toString(), init);
}

async function writeFetchResponseToNode(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  }
  res.end();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
