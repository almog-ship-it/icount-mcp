import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AuthError, extractCredsFromHeaders } from "./auth.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

interface Env {
  MCP_ACCESS_KEY?: string;
}

const TOOL_COUNT = 29;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

    let creds;
    try {
      creds = extractCredsFromHeaders(request.headers, {
        MCP_ACCESS_KEY: env.MCP_ACCESS_KEY,
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
  },
} satisfies ExportedHandler<Env>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
