import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AuthError, extractCredsFromRequest } from "./auth.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  isAllowedRedirectUri,
  issueAccessToken,
  issueAuthCode,
  OAuthError,
  validateAuthCode,
  verifyPkce,
} from "./oauth.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

interface Env {
  MCP_ACCESS_KEY?: string;
  OAUTH_ENCRYPTION_KEY?: string;
}

const TOOL_COUNT = 30;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Icount-Cid, X-Icount-Dry-Run, X-Mcp-Key",
  "Access-Control-Expose-Headers":
    "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const response = await handle(request, env);
    return withCors(response);
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const canonicalUrl = canonicalServerUrl(url);

  // OAuth discovery + endpoints — checked before any auth.
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    return json({
      resource: canonicalUrl,
      authorization_servers: [canonicalUrl],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  }

  if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: canonicalUrl,
      authorization_endpoint: `${canonicalUrl}/authorize`,
      token_endpoint: `${canonicalUrl}/token`,
      registration_endpoint: `${canonicalUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      scopes_supported: ["mcp"],
    });
  }

  if (request.method === "POST" && url.pathname === "/register") {
    return handleRegister(request, canonicalUrl);
  }

  if (request.method === "GET" && url.pathname === "/authorize") {
    return handleAuthorize(request, env);
  }

  if (request.method === "POST" && url.pathname === "/token") {
    return handleToken(request, env, canonicalUrl);
  }

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
      endpoint: canonicalUrl,
      authorization_url: `${canonicalUrl}/.well-known/oauth-authorization-server`,
      note: "Use the OAuth flow (Add custom connector in Claude Desktop) or POST JSON-RPC with Bearer + X-Icount-Cid headers.",
    });
  }

  // MCP — auth required.
  let creds;
  try {
    creds = await extractCredsFromRequest(request, env, canonicalUrl);
  } catch (e) {
    if (e instanceof AuthError) {
      return jsonWithWwwAuth(
        { error: e.message, hint: e.hint },
        e.status,
        canonicalUrl,
      );
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

// ──────────────────────── OAuth handlers ────────────────────────

async function handleRegister(request: Request, canonicalUrl: string): Promise<Response> {
  // Permissive Dynamic Client Registration. We don't actually persist anything —
  // the iCount token IS the credential, supplied by the user via the dialog.
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* tolerate empty body */
  }
  const clientId =
    typeof body.client_id === "string" && body.client_id.length > 0
      ? body.client_id
      : `auto-${crypto.randomUUID()}`;
  return json(
    {
      ...body,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method:
        typeof body.token_endpoint_auth_method === "string"
          ? body.token_endpoint_auth_method
          : "client_secret_post",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      registration_client_uri: `${canonicalUrl}/register`,
    },
    201,
  );
}

async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.OAUTH_ENCRYPTION_KEY) {
    return json(
      {
        error: "server_misconfigured",
        error_description:
          "OAUTH_ENCRYPTION_KEY is not set. Run: wrangler secret put OAUTH_ENCRYPTION_KEY",
      },
      500,
    );
  }
  const url = new URL(request.url);
  const params = url.searchParams;

  const responseType = params.get("response_type");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");
  const state = params.get("state") ?? "";
  const resource = params.get("resource") ?? undefined;

  if (responseType !== "code") {
    return oauthError("unsupported_response_type", "response_type must be 'code'", redirectUri, state);
  }
  if (!clientId) {
    return oauthError("invalid_request", "client_id is required (use your iCount API token)", redirectUri, state);
  }
  if (!redirectUri || !isAllowedRedirectUri(redirectUri)) {
    return json(
      {
        error: "invalid_request",
        error_description: "redirect_uri must be loopback (http://localhost:*) or HTTPS",
      },
      400,
    );
  }
  if (!codeChallenge) {
    return oauthError("invalid_request", "code_challenge is required (PKCE)", redirectUri, state);
  }
  if (codeChallengeMethod !== "S256") {
    return oauthError("invalid_request", "code_challenge_method must be S256", redirectUri, state);
  }

  const code = await issueAuthCode(
    { token: clientId, codeChallenge, redirectUri, resource },
    env.OAUTH_ENCRYPTION_KEY,
  );

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { Location: redirect.toString() },
  });
}

async function handleToken(
  request: Request,
  env: Env,
  canonicalUrl: string,
): Promise<Response> {
  if (!env.OAUTH_ENCRYPTION_KEY) {
    return json(
      {
        error: "server_misconfigured",
        error_description:
          "OAUTH_ENCRYPTION_KEY is not set. Run: wrangler secret put OAUTH_ENCRYPTION_KEY",
      },
      500,
    );
  }
  let form: URLSearchParams;
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      form = new URLSearchParams(await request.text());
    } else if (contentType.includes("application/json")) {
      const j = (await request.json()) as Record<string, string>;
      form = new URLSearchParams(j);
    } else {
      form = new URLSearchParams(await request.text());
    }
  } catch {
    return json({ error: "invalid_request", error_description: "Could not parse request body" }, 400);
  }

  const grantType = form.get("grant_type");
  const code = form.get("code");
  const codeVerifier = form.get("code_verifier");
  const redirectUri = form.get("redirect_uri");
  const clientId = form.get("client_id");
  const clientSecret = form.get("client_secret");

  if (grantType !== "authorization_code") {
    return json({ error: "unsupported_grant_type", error_description: "grant_type must be authorization_code" }, 400);
  }
  if (!code || !codeVerifier || !redirectUri || !clientId) {
    return json({ error: "invalid_request", error_description: "code, code_verifier, redirect_uri, and client_id are required" }, 400);
  }
  if (!clientSecret) {
    return json(
      {
        error: "invalid_request",
        error_description:
          "client_secret is required (set the iCount Company ID as OAuth Client Secret in the dialog)",
      },
      400,
    );
  }

  let payload;
  try {
    payload = await validateAuthCode(code, env.OAUTH_ENCRYPTION_KEY, redirectUri);
  } catch (e) {
    if (e instanceof OAuthError) {
      return json({ error: e.code, error_description: e.description }, 400);
    }
    throw e;
  }

  if (payload.t !== clientId) {
    return json({ error: "invalid_grant", error_description: "client_id does not match the authorization code" }, 400);
  }

  if (!(await verifyPkce(codeVerifier, payload.cc))) {
    return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  const { accessToken, expiresIn } = await issueAccessToken(
    { token: clientId, cid: clientSecret, audience: canonicalUrl },
    env.OAUTH_ENCRYPTION_KEY,
  );

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: "mcp",
  });
}

// ──────────────────────── helpers ────────────────────────

function canonicalServerUrl(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonWithWwwAuth(body: unknown, status: number, canonicalUrl: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (status === 401) {
    headers.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${canonicalUrl}/.well-known/oauth-protected-resource", scope="mcp"`,
    );
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function oauthError(
  code: string,
  description: string,
  redirectUri: string | null,
  state: string,
): Response {
  // If we have a valid redirect, OAuth says return errors via redirect, not body.
  if (redirectUri && isAllowedRedirectUri(redirectUri)) {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("error", code);
    redirect.searchParams.set("error_description", description);
    if (state) redirect.searchParams.set("state", state);
    return new Response(null, {
      status: 302,
      headers: { Location: redirect.toString() },
    });
  }
  return json({ error: code, error_description: description }, 400);
}

// Suppress unused-export warnings for vars that future helpers may use.
void ACCESS_TOKEN_TTL_SECONDS;
