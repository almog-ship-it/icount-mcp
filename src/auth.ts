import { OAuthError, validateAccessToken } from "./oauth.js";

export interface IcountCreds {
  token: string;
  cid: string;
  dryRun: boolean;
}

export class AuthError extends Error {
  constructor(public status: number, message: string, public hint?: string) {
    super(message);
    this.name = "AuthError";
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Header-based credential extractor (legacy direct-bearer mode).
 *
 * Used by the stdio shim (via the same env shape) and by curl smoke tests.
 * The Worker calls `extractCredsFromRequest` instead, which tries the OAuth
 * path first and falls back here.
 */
export function extractCredsFromHeaders(
  headers: Headers,
  env: { MCP_ACCESS_KEY?: string },
): IcountCreds {
  if (env.MCP_ACCESS_KEY) {
    const provided = headers.get("x-mcp-key") ?? "";
    if (!provided || !constantTimeEqual(provided, env.MCP_ACCESS_KEY)) {
      throw new AuthError(401, "Missing or invalid X-Mcp-Key", "Set the X-Mcp-Key header to the shared access key.");
    }
  }

  const authHeader = headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    throw new AuthError(
      401,
      "Missing Authorization header",
      "Pass your iCount API token as 'Authorization: Bearer <token>'.",
    );
  }

  const cid = headers.get("x-icount-cid")?.trim();
  if (!cid) {
    throw new AuthError(
      401,
      "Missing X-Icount-Cid header",
      "Pass your iCount company ID as 'X-Icount-Cid: <cid>'.",
    );
  }

  const dryRun = (headers.get("x-icount-dry-run") ?? "").trim() === "1";

  return { token, cid, dryRun };
}

/**
 * Worker credential extractor.
 *
 * Resolution order:
 *   1. If Authorization is a Bearer token that decrypts as an OAuth access token,
 *      use that (the iCount token + cid are inside the encrypted payload).
 *   2. Otherwise fall back to legacy direct-bearer + X-Icount-Cid header mode.
 *
 * Either path also enforces the optional MCP_ACCESS_KEY gate when set.
 */
export async function extractCredsFromRequest(
  request: Request,
  env: { MCP_ACCESS_KEY?: string; OAUTH_ENCRYPTION_KEY?: string },
  audience: string,
): Promise<IcountCreds> {
  if (env.MCP_ACCESS_KEY) {
    const provided = request.headers.get("x-mcp-key") ?? "";
    if (!provided || !constantTimeEqual(provided, env.MCP_ACCESS_KEY)) {
      throw new AuthError(401, "Missing or invalid X-Mcp-Key", "Set the X-Mcp-Key header to the shared access key.");
    }
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1]?.trim();
  if (!bearer) {
    throw new AuthError(
      401,
      "Missing Authorization header",
      "Connect via the OAuth flow (Add custom connector in Claude Desktop) or send Bearer + X-Icount-Cid headers directly.",
    );
  }

  const dryRun = (request.headers.get("x-icount-dry-run") ?? "").trim() === "1";

  // Try OAuth-issued access token first.
  if (env.OAUTH_ENCRYPTION_KEY) {
    try {
      const payload = await validateAccessToken(bearer, env.OAUTH_ENCRYPTION_KEY, audience);
      return { token: payload.t, cid: payload.c, dryRun };
    } catch (e) {
      if (!(e instanceof OAuthError)) throw e;
      // Not an OAuth token (or invalid one) — fall through to legacy mode.
    }
  }

  // Legacy: direct iCount token in Bearer + cid in header.
  const cid = request.headers.get("x-icount-cid")?.trim();
  if (!cid) {
    throw new AuthError(
      401,
      "Missing X-Icount-Cid header",
      "Either complete the OAuth flow, or include 'X-Icount-Cid: <cid>' alongside your iCount token.",
    );
  }

  return { token: bearer, cid, dryRun };
}
