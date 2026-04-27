import { describe, expect, it, vi } from "vitest";
import { IcountClient } from "../src/client.js";
import { buildServer } from "../src/server.js";

const fakeCreds = { token: "fake-token", cid: "12345", dryRun: true };

describe("server tool registration", () => {
  it("exposes 30 tools", async () => {
    const server = buildServer(fakeCreds);
    // Reach into the underlying low-level Server to list registered tool names.
    // The McpServer keeps tools in a private map; the public API exposes them via the protocol,
    // so we verify the count by reading the internals (valid for an internal test).
    const internals = server as unknown as {
      _registeredTools: Record<string, unknown>;
    };
    const names = Object.keys(internals._registeredTools);
    expect(names.length).toBe(30);

    expect(names).toEqual(
      expect.arrayContaining([
        "icount_doc_create",
        "icount_doc_get",
        "icount_doc_search",
        "icount_doc_list",
        "icount_doc_get_url",
        "icount_doc_cancel",
        "icount_doc_close",
        "icount_doc_convert",
        "icount_doc_update_income_type",
        "icount_doc_send_email",
        "icount_client_create",
        "icount_client_update",
        "icount_client_upsert",
        "icount_client_get",
        "icount_client_delete",
        "icount_client_list",
        "icount_client_get_open_docs",
        "icount_client_get_contacts",
        "icount_client_add_contact",
        "icount_client_update_contact",
        "icount_client_delete_contact",
        "icount_expense_create",
        "icount_expense_search",
        "icount_expense_types",
        "icount_expense_doctypes",
        "icount_supplier_get",
        "icount_supplier_list",
        "icount_supplier_add",
        "icount_supplier_update",
        "icount_account_info",
      ]),
    );
  });
});

describe("dry-run payload shapes", () => {
  it("doc_create dry-run captures the snake_case body and never hits the network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("must not call fetch in dry-run");
    }) as unknown as typeof fetch;
    const client = new IcountClient(fakeCreds, fetchImpl);

    const out = await client.requestOrDryRun(
      "/doc/create",
      {
        doctype: "invrec",
        client_name: "Test Client",
        items: [{ description: "Consulting", unitprice: 1000, quantity: 2 }],
      },
      { doc_id: "DRY-DOC-1", docnum: "DRY-1234" },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      dry_run: true,
      endpoint: "/doc/create",
      doc_id: "DRY-DOC-1",
    });
  });

  it("read-only call still hits the network in dry-run", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: true, results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const client = new IcountClient(fakeCreds, fetchImpl);

    await client.request("/doc/search", { from_date: "2026-01-01" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
