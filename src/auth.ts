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
