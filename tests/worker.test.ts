import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueAccessToken,
  issueRefreshToken,
  issueUploadToken,
  pkceChallengeFromVerifier,
  validateAccessToken,
} from "../src/oauth.js";
import worker from "../src/worker.js";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const ORIGIN = "https://icount-mcp.example.workers.dev";
const env = { OAUTH_ENCRYPTION_KEY: KEY };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, init), env as never);
}

function tokenRequest(fields: Record<string, string>): Promise<Response> {
  return call("/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("OAuth token endpoint", () => {
  it("advertises the refresh_token grant", async () => {
    const meta = (await (await call("/.well-known/oauth-authorization-server")).json()) as {
      grant_types_supported: string[];
    };
    expect(meta.grant_types_supported).toContain("refresh_token");
  });

  it("returns a refresh token with the code exchange, and the refresh grant yields a working access token", async () => {
    const verifier = "v".repeat(50);
    const authorize = await call(
      "/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: "icount-token",
          redirect_uri: "http://localhost:9999/cb",
          code_challenge: await pkceChallengeFromVerifier(verifier),
          code_challenge_method: "S256",
          state: "s",
        }),
    );
    const code = new URL(authorize.headers.get("location")!).searchParams.get("code")!;

    const first = (await (
      await tokenRequest({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: "http://localhost:9999/cb",
        client_id: "icount-token",
        client_secret: "12345",
      })
    ).json()) as Record<string, string>;
    expect(first.access_token).toBeTruthy();
    expect(first.refresh_token).toBeTruthy();

    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token!,
      client_id: "icount-token",
    });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as Record<string, string>;
    const payload = await validateAccessToken(body.access_token!, KEY, ORIGIN);
    expect(payload).toMatchObject({ t: "icount-token", c: "12345" });
    expect(body.refresh_token).toBeTruthy();
  });

  it("rejects an access token used as a refresh token, and a mismatched client_id", async () => {
    const { accessToken } = await issueAccessToken({ token: "t", cid: "1", audience: ORIGIN }, KEY);
    const asRefresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: accessToken });
    expect(asRefresh.status).toBe(400);

    const refresh = await issueRefreshToken({ token: "t", cid: "1", audience: ORIGIN }, KEY);
    const wrongClient = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: "someone-else",
    });
    expect(wrongClient.status).toBe(400);
  });
});

describe("MCP endpoint", () => {
  it("answers an expired OAuth token with 401 invalid_token so the client refreshes", async () => {
    const past = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const { accessToken } = await issueAccessToken({ token: "t", cid: "1", audience: ORIGIN }, KEY, past);
    const res = await call("/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("returns 405 for the standalone GET stream and DELETE (stateless server)", async () => {
    const get = await call("/", { headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(405);
    const del = await call("/", { method: "DELETE" });
    expect(del.status).toBe(405);
  });
});

describe("/upload/<token>", () => {
  const body = {
    supplier_id: 157,
    expense_type_id: 94,
    expense_doctype: "other",
    expense_docnum: "7290114673709",
    expense_sum: 100,
    invoice_date: "2026-09-20",
    adv_expense: 1,
    manual_no_vat: 1,
  };

  it("serves the upload form", async () => {
    const token = await issueUploadToken({ token: "t", cid: "1", audience: ORIGIN, body }, KEY);
    const res = await call(`/upload/${token}`, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('name="scan"');
    expect(page).toContain("7290114673709");
  });

  it("creates the expense with the uploaded scan", async () => {
    let createForm: FormData | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const endpoint = String(url).split("v3.php")[1];
        const reply =
          endpoint === "/expense/search"
            ? { status: true, results_count: 0, results_list: [] }
            : endpoint === "/expense/info"
              ? { status: true, expense_info: { expense_id: "777", expense_sum: "100", s3storage_id: "5" } }
              : ((createForm = init!.body as FormData), { status: true, expense_id: 777 });
        return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
      }),
    );
    const token = await issueUploadToken({ token: "t", cid: "1", audience: ORIGIN, body }, KEY);
    const form = new FormData();
    form.append("scan", new Blob([JPEG], { type: "image/jpeg" }), "FullSizeRender.jpeg");

    const res = await call(`/upload/${token}`, { method: "POST", body: form });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, expense_id: 777, warnings: [] });
    expect(createForm!.get("cid")).toBe("1");
    expect(createForm!.get("expense_docnum")).toBe("7290114673709");
    expect((createForm!.get("scan") as File).name).toBe("FullSizeRender.jpg");
  });

  it("rejects an expired link and a non-image file without calling iCount", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const past = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const expired = await issueUploadToken({ token: "t", cid: "1", audience: ORIGIN, body }, KEY, past);
    expect((await call(`/upload/${expired}`)).status).toBe(410);

    const token = await issueUploadToken({ token: "t", cid: "1", audience: ORIGIN, body }, KEY);
    const form = new FormData();
    form.append("scan", new Blob(["hello"], { type: "text/plain" }), "x.txt");
    const res = await call(`/upload/${token}`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
