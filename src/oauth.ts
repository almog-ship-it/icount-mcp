/**
 * OAuth 2.1 helpers for the iCount MCP Worker.
 *
 * The Worker plays both roles: protected resource (it exposes the MCP endpoint)
 * AND authorization server (it issues access tokens). Both auth codes and
 * access tokens are AES-GCM-encrypted JSON envelopes, so the Worker stays
 * stateless — no KV/D1 needed.
 *
 * Token wire format:
 *   <type-byte 0x01>.<base64url(iv-12-bytes)>.<base64url(ciphertext+tag)>
 *
 * Two payload kinds, distinguished by the `kind` field in the JSON plaintext:
 *   - "code"   — authorization code (5-minute TTL), produced by /authorize, consumed by /token
 *   - "access" — access token (24-hour TTL), used as Bearer on MCP requests
 */

const TOKEN_VERSION = "01";
const AUTH_CODE_TTL_SECONDS = 5 * 60;
export const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface AuthCodePayload {
  kind: "code";
  /** iCount API token (originally `client_id` in the OAuth /authorize request). */
  t: string;
  /** PKCE code_challenge (base64url-encoded SHA-256 of the verifier). */
  cc: string;
  /** redirect_uri the client supplied in /authorize. Must match on /token. */
  ru: string;
  /** Optional `resource` parameter (RFC 8707). */
  r?: string;
  /** Unix-seconds expiry. */
  exp: number;
}

export interface AccessTokenPayload {
  kind: "access";
  /** iCount API token. */
  t: string;
  /** iCount CID (originally `client_secret` in the OAuth /token request). */
  c: string;
  /** Audience — the canonical Worker URL. Must match on resource use. */
  aud: string;
  /** Unix-seconds expiry. */
  exp: number;
}

export type TokenPayload = AuthCodePayload | AccessTokenPayload;

// ──────────────────────────── crypto ────────────────────────────

let cachedKey: CryptoKey | undefined;
let cachedKeyMaterial: string | undefined;

async function loadKey(rawSecret: string): Promise<CryptoKey> {
  if (cachedKey && cachedKeyMaterial === rawSecret) return cachedKey;
  const bytes = base64Decode(rawSecret);
  if (bytes.length !== 32) {
    throw new Error(
      `OAUTH_ENCRYPTION_KEY must decode to 32 bytes (got ${bytes.length}). Generate one via: node -e 'console.log(crypto.randomBytes(32).toString("base64"))'`,
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    bytes as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  cachedKey = key;
  cachedKeyMaterial = rawSecret;
  return key;
}

export async function encryptPayload(
  payload: TokenPayload,
  secret: string,
): Promise<string> {
  const key = await loadKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return `${TOKEN_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptPayload(
  token: string,
  secret: string,
): Promise<TokenPayload> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    throw new OAuthError("invalid_token", "Malformed token");
  }
  const iv = base64UrlDecode(parts[1]!);
  const ciphertext = base64UrlDecode(parts[2]!);
  const key = await loadKey(secret);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
  } catch {
    throw new OAuthError("invalid_token", "Decryption failed");
  }
  let parsed: TokenPayload;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as TokenPayload;
  } catch {
    throw new OAuthError("invalid_token", "Decrypted payload is not JSON");
  }
  if (parsed.kind !== "code" && parsed.kind !== "access") {
    throw new OAuthError("invalid_token", "Unknown token kind");
  }
  return parsed;
}

// ──────────────────────────── PKCE ────────────────────────────

export async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

export async function verifyPkce(verifier: string, expectedChallenge: string): Promise<boolean> {
  const computed = await pkceChallengeFromVerifier(verifier);
  return constantTimeEqualString(computed, expectedChallenge);
}

// ──────────────────────────── issuance ────────────────────────────

export async function issueAuthCode(
  args: { token: string; codeChallenge: string; redirectUri: string; resource?: string },
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: AuthCodePayload = {
    kind: "code",
    t: args.token,
    cc: args.codeChallenge,
    ru: args.redirectUri,
    ...(args.resource ? { r: args.resource } : {}),
    exp: now + AUTH_CODE_TTL_SECONDS,
  };
  return encryptPayload(payload, secret);
}

export async function issueAccessToken(
  args: { token: string; cid: string; audience: string },
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ accessToken: string; expiresIn: number }> {
  const payload: AccessTokenPayload = {
    kind: "access",
    t: args.token,
    c: args.cid,
    aud: args.audience,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  };
  const accessToken = await encryptPayload(payload, secret);
  return { accessToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

// ──────────────────────────── validation ────────────────────────────

export async function validateAuthCode(
  code: string,
  secret: string,
  expectedRedirectUri: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<AuthCodePayload> {
  const payload = await decryptPayload(code, secret);
  if (payload.kind !== "code") {
    throw new OAuthError("invalid_grant", "Token is not an auth code");
  }
  if (payload.exp < now) {
    throw new OAuthError("invalid_grant", "Authorization code expired");
  }
  if (payload.ru !== expectedRedirectUri) {
    throw new OAuthError("invalid_grant", "redirect_uri mismatch");
  }
  return payload;
}

export async function validateAccessToken(
  accessToken: string,
  secret: string,
  expectedAudience: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<AccessTokenPayload> {
  const payload = await decryptPayload(accessToken, secret);
  if (payload.kind !== "access") {
    throw new OAuthError("invalid_token", "Bearer is not an access token");
  }
  if (payload.exp < now) {
    throw new OAuthError("invalid_token", "Access token expired");
  }
  if (!audienceMatches(payload.aud, expectedAudience)) {
    throw new OAuthError("invalid_token", "Audience mismatch");
  }
  return payload;
}

function audienceMatches(tokenAud: string, expected: string): boolean {
  return normalizeUrl(tokenAud) === normalizeUrl(expected);
}

function normalizeUrl(s: string): string {
  return s.replace(/\/+$/, "").toLowerCase();
}

// ──────────────────────────── redirect URI ────────────────────────────

export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.protocol === "https:") return true;
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
  ) {
    return true;
  }
  return false;
}

// ──────────────────────────── errors ────────────────────────────

export class OAuthError extends Error {
  constructor(public code: string, public description: string) {
    super(`${code}: ${description}`);
    this.name = "OAuthError";
  }
}

// ──────────────────────────── base64 helpers ────────────────────────────

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Decode(s: string): Uint8Array {
  // accept either standard or url-safe base64
  return base64UrlDecode(s.replace(/\+/g, "-").replace(/\//g, "_"));
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
