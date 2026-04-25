import { describe, expect, it, vi } from "vitest";
import { IcountClient } from "../src/client.js";
import { IcountApiError } from "../src/errors.js";

const baseCreds = { token: "tok-abc", cid: "12345", dryRun: false };

function mockFetch(impl: (req: { url: string; init: RequestInit }) => Response | Promise<Response>) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    return impl({ url, init: init ?? {} });
  }) as unknown as typeof fetch;
}

describe("IcountClient.request", () => {
  it("posts JSON with bearer auth and includes cid in body", async () => {
    let captured: { url: string; body: unknown; headers: Record<string, string> } | undefined;
    const fetchImpl = mockFetch(({ url, init }) => {
      const hdrs: Record<string, string> = {};
      new Headers(init.headers as HeadersInit).forEach((v, k) => {
        hdrs[k.toLowerCase()] = v;
      });
      captured = {
        url,
        body: JSON.parse(init.body as string),
        headers: hdrs,
      };
      return new Response(JSON.stringify({ status: true, hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new IcountClient(baseCreds, fetchImpl);

    const out = await client.request<Record<string, unknown>>("/account/info", { x: 1 });

    expect(captured).toBeDefined();
    expect(captured!.url).toBe("https://api.icount.co.il/api/v3.php/account/info");
    expect(captured!.body).toEqual({ cid: "12345", x: 1 });
    expect(captured!.headers.authorization).toBe("Bearer tok-abc");
    expect(captured!.headers["content-type"]).toBe("application/json");
    expect(out).toEqual({ status: true, hello: "world" });
  });

  it("throws IcountApiError when API returns status:false", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(JSON.stringify({ status: false, reason: "Bad token", error_code: 4001 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new IcountClient(baseCreds, fetchImpl);

    await expect(client.request("/account/info")).rejects.toBeInstanceOf(IcountApiError);
  });

  it("maps 429 to a rate-limit error", async () => {
    const fetchImpl = mockFetch(() =>
      new Response("rate limit", {
        status: 429,
        headers: { "retry-after": "20" },
      }),
    );
    const client = new IcountClient(baseCreds, fetchImpl);

    try {
      await client.request("/doc/list");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IcountApiError);
      expect((e as IcountApiError).httpStatus).toBe(429);
      expect((e as Error).message).toContain("Retry-After");
    }
  });
});

describe("IcountClient.requestOrDryRun", () => {
  it("returns dry-run shape without calling fetch when dryRun=true", async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error("network must not be called in dry-run");
    });
    const client = new IcountClient({ ...baseCreds, dryRun: true }, fetchImpl);

    const out = await client.requestOrDryRun(
      "/doc/create",
      { doctype: "invoice", items: [] },
      { doc_id: "DRY-DOC-1", docnum: "DRY-1234" },
    );

    expect(out).toMatchObject({
      dry_run: true,
      endpoint: "/doc/create",
      doc_id: "DRY-DOC-1",
      docnum: "DRY-1234",
    });
    expect((out as { request_body: Record<string, unknown> }).request_body).toEqual({
      cid: "12345",
      doctype: "invoice",
      items: [],
    });
  });

  it("calls fetch and returns parsed body when dryRun=false", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(JSON.stringify({ status: true, doc_id: 99, docnum: "INV-099" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new IcountClient(baseCreds, fetchImpl);

    const out = await client.requestOrDryRun(
      "/doc/create",
      { doctype: "invoice" },
      { doc_id: "FAKE", docnum: "FAKE" },
    );
    expect(out).toEqual({ status: true, doc_id: 99, docnum: "INV-099" });
  });
});
