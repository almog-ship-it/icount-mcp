import { describe, expect, it } from "vitest";
import { AuthError, extractCredsFromHeaders } from "../src/auth.js";

function h(record: Record<string, string>): Headers {
  return new Headers(record);
}

describe("extractCredsFromHeaders", () => {
  it("extracts token + cid from headers", () => {
    const creds = extractCredsFromHeaders(
      h({ authorization: "Bearer abc-123", "x-icount-cid": "999" }),
      {},
    );
    expect(creds).toEqual({ token: "abc-123", cid: "999", dryRun: false });
  });

  it("treats X-Icount-Dry-Run: 1 as dry-run", () => {
    const creds = extractCredsFromHeaders(
      h({
        authorization: "Bearer abc",
        "x-icount-cid": "1",
        "x-icount-dry-run": "1",
      }),
      {},
    );
    expect(creds.dryRun).toBe(true);
  });

  it("rejects when token is missing", () => {
    expect(() => extractCredsFromHeaders(h({ "x-icount-cid": "1" }), {})).toThrow(AuthError);
  });

  it("rejects when cid is missing", () => {
    expect(() => extractCredsFromHeaders(h({ authorization: "Bearer abc" }), {})).toThrow(
      AuthError,
    );
  });

  it("enforces MCP_ACCESS_KEY when configured", () => {
    expect(() =>
      extractCredsFromHeaders(
        h({ authorization: "Bearer abc", "x-icount-cid": "1" }),
        { MCP_ACCESS_KEY: "shared-secret" },
      ),
    ).toThrow(AuthError);
  });

  it("accepts requests with the right MCP_ACCESS_KEY", () => {
    const creds = extractCredsFromHeaders(
      h({
        authorization: "Bearer abc",
        "x-icount-cid": "1",
        "x-mcp-key": "shared-secret",
      }),
      { MCP_ACCESS_KEY: "shared-secret" },
    );
    expect(creds.token).toBe("abc");
  });

  it("skips MCP_ACCESS_KEY check when env is unset", () => {
    const creds = extractCredsFromHeaders(
      h({ authorization: "Bearer abc", "x-icount-cid": "1" }),
      {},
    );
    expect(creds.token).toBe("abc");
  });
});
