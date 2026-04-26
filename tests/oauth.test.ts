import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  isAllowedRedirectUri,
  issueAccessToken,
  issueAuthCode,
  OAuthError,
  pkceChallengeFromVerifier,
  validateAccessToken,
  validateAuthCode,
  verifyPkce,
} from "../src/oauth.js";

// 32 raw bytes, base64-encoded — only used for tests.
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const AUDIENCE = "https://icount-mcp.almogfish.workers.dev";
const REDIRECT = "http://localhost:9999/cb";

describe("oauth.ts crypto + token round-trip", () => {
  it("encrypts and decrypts an access token end-to-end", async () => {
    const { accessToken } = await issueAccessToken(
      { token: "icount-tok-abc", cid: "12345", audience: AUDIENCE },
      KEY,
    );
    const payload = await validateAccessToken(accessToken, KEY, AUDIENCE);
    expect(payload.kind).toBe("access");
    expect(payload.t).toBe("icount-tok-abc");
    expect(payload.c).toBe("12345");
    expect(payload.aud).toBe(AUDIENCE);
  });
});

describe("PKCE", () => {
  it("computes the S256 challenge from a known verifier (RFC 7636 vector)", async () => {
    // From RFC 7636 §4.4 example.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await pkceChallengeFromVerifier(verifier)).toBe(expected);
    expect(await verifyPkce(verifier, expected)).toBe(true);
    expect(await verifyPkce(verifier + "x", expected)).toBe(false);
  });
});

describe("auth code expiry + redirect_uri binding", () => {
  it("rejects an auth code that has expired", async () => {
    const past = Math.floor(Date.now() / 1000) - 99999;
    const code = await issueAuthCode(
      { token: "tok", codeChallenge: "abc", redirectUri: REDIRECT },
      KEY,
      past,
    );
    await expect(validateAuthCode(code, KEY, REDIRECT)).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects an auth code presented at /token with a different redirect_uri", async () => {
    const code = await issueAuthCode(
      { token: "tok", codeChallenge: "abc", redirectUri: REDIRECT },
      KEY,
    );
    await expect(
      validateAuthCode(code, KEY, "http://localhost:9999/different"),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("access token audience binding", () => {
  it("rejects an access token presented at the wrong audience", async () => {
    const { accessToken } = await issueAccessToken(
      { token: "tok", cid: "1", audience: AUDIENCE },
      KEY,
    );
    await expect(
      validateAccessToken(accessToken, KEY, "https://attacker.example.com"),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it("rejects an expired access token", async () => {
    const past = Math.floor(Date.now() / 1000) - ACCESS_TOKEN_TTL_SECONDS - 10;
    const { accessToken } = await issueAccessToken(
      { token: "tok", cid: "1", audience: AUDIENCE },
      KEY,
      past,
    );
    await expect(validateAccessToken(accessToken, KEY, AUDIENCE)).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("redirect URI policy", () => {
  it("allows HTTPS and loopback, rejects everything else", () => {
    expect(isAllowedRedirectUri("https://app.example.com/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:1234/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:5555/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:5555/cb")).toBe(true);
    // Wrong scheme on non-loopback host
    expect(isAllowedRedirectUri("http://evil.example.com/cb")).toBe(false);
    // Fragment is forbidden
    expect(isAllowedRedirectUri("https://app.example.com/cb#frag")).toBe(false);
    // Garbage
    expect(isAllowedRedirectUri("not-a-url")).toBe(false);
  });
});
