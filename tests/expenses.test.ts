import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { IcountClient } from "../src/client.js";
import { decodeBase64Scan, MAX_SCAN_BYTES, ScanError, validateScan } from "../src/expense-scan.js";
import { buildServer, type ServerOptions } from "../src/server.js";
import { compareSaved } from "../src/expense-ops.js";
import { buildExpectation, buildExpenseBody } from "../src/tools/expenses.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode("%PDF-1.7 fake");
const HEIC = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic"), 0, 0]);

const baseArgs = {
  supplier_id: 157,
  expense_type_id: 94,
  expense_doctype: "other",
  expense_docnum: "7290114673709",
  expense_sum: 100,
  invoice_date: "2026-09-20",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function connect(fetchImpl: typeof fetch, opts: ServerOptions = {}) {
  vi.stubGlobal("fetch", fetchImpl);
  const server = buildServer({ token: "tok", cid: "12345", dryRun: false }, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join("\n");
}

describe("buildExpenseBody (field mapping per iCount API reference)", () => {
  it("sends notes as comment and leaves VAT to iCount when vat_amount is omitted", () => {
    const body = buildExpenseBody({ ...baseArgs, notes: "טעינת רב-קו" });
    expect(body).toMatchObject({ comment: "טעינת רב-קו", expense_sum: 100 });
    expect(body).not.toHaveProperty("notes");
    expect(body).not.toHaveProperty("adv_expense");
    expect(body).not.toHaveProperty("vat_amount");
  });

  it("vat_amount=0 marks the expense as without VAT", () => {
    const body = buildExpenseBody({ ...baseArgs, vat_amount: 0 }) as Record<string, unknown>;
    expect(body).toMatchObject({ adv_expense: 1, manual_no_vat: 1, expense_sum: 100 });
    expect(body).not.toHaveProperty("expense_manual_vat");
  });

  it("vat_amount>0 switches to manual VAT with a net expense_sum", () => {
    const body = buildExpenseBody({ ...baseArgs, expense_sum: 117, vat_amount: 17 });
    expect(body).toMatchObject({ adv_expense: 1, expense_manual_vat: 17, expense_sum: 100 });
  });

  it("rejects vat_amount on foreign-currency expenses and VAT above the total", () => {
    expect(typeof buildExpenseBody({ ...baseArgs, currency: "USD", vat_amount: 5 })).toBe("string");
    expect(typeof buildExpenseBody({ ...baseArgs, vat_amount: 101 })).toBe("string");
  });

  it("keeps payment out of the create body and turns it into a payment step", () => {
    const args = { ...baseArgs, expense_paid: true, expense_paid_date: "2026-09-21", payment_method: "cash" as const };
    const body = buildExpenseBody(args);
    expect(body).not.toHaveProperty("expense_paid");
    expect(body).not.toHaveProperty("expense_paid_date");
    expect(buildExpectation(args).payment).toEqual({ method: "cash", date: "2026-09-21", sum: 100 });
    expect(buildExpectation({ ...baseArgs, expense_paid: true }).payment).toEqual({
      method: "other",
      date: "2026-09-20",
      sum: 100,
    });
    expect(buildExpectation({ ...baseArgs, expense_paid: false }).payment).toBeUndefined();
  });
});

describe("validateScan", () => {
  it("detects the real type from magic bytes and fixes the extension", () => {
    expect(validateScan(JPEG, "FullSizeRender.jpeg")).toMatchObject({
      field: "scan",
      filename: "FullSizeRender.jpg",
      contentType: "image/jpeg",
    });
    expect(validateScan(PDF, "/Users/x/receipt.bin").filename).toBe("receipt.pdf");
  });

  it("rejects HEIC, unknown types, empty and oversized files", () => {
    expect(() => validateScan(HEIC, "a.heic")).toThrow(/HEIC/);
    expect(() => validateScan(new Uint8Array([1, 2, 3]), "a.txt")).toThrow(ScanError);
    expect(() => validateScan(new Uint8Array(), "a.jpg")).toThrow(/empty/);
    const big = new Uint8Array(MAX_SCAN_BYTES + 1);
    big.set(JPEG);
    expect(() => validateScan(big, "a.jpg")).toThrow(/limit/);
  });

  it("decodes plain base64 and data: URLs", () => {
    const b64 = btoa(String.fromCharCode(...JPEG));
    expect(decodeBase64Scan(b64)).toEqual(JPEG);
    expect(decodeBase64Scan(`data:image/jpeg;base64,${b64}`)).toEqual(JPEG);
  });
});

describe("IcountClient.requestMultipart", () => {
  it("posts multipart form data with cid, scalar fields and the scan part", async () => {
    let form: FormData | undefined;
    let headers: Headers | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      form = init!.body as FormData;
      headers = new Headers(init!.headers as HeadersInit);
      return jsonResponse({ status: true, expense_id: 55 });
    }) as unknown as typeof fetch;
    const client = new IcountClient({ token: "tok", cid: "12345", dryRun: false }, fetchImpl);

    const out = await client.requestMultipart(
      "/expense/create",
      { supplier_id: 157, expense_sum: 100, manual_no_vat: true, skipped: undefined },
      validateScan(JPEG, "r.jpg"),
    );

    expect(out).toMatchObject({ expense_id: 55 });
    expect(form).toBeInstanceOf(FormData);
    expect(form!.get("cid")).toBe("12345");
    expect(form!.get("supplier_id")).toBe("157");
    expect(form!.get("manual_no_vat")).toBe("1");
    expect(form!.has("skipped")).toBe(false);
    const scan = form!.get("scan") as File;
    expect(scan.name).toBe("r.jpg");
    expect(scan.type).toBe("image/jpeg");
    expect(new Uint8Array(await scan.arrayBuffer())).toEqual(JPEG);
    expect(headers!.get("authorization")).toBe("Bearer tok");
    expect(headers!.get("content-type")).toBeNull();
  });
});

describe("icount_expense_create tool", () => {
  it("returns an upload link (and creates nothing) when iCount requires a scan", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      const endpoint = String(url).split("v3.php")[1]!;
      calls.push(endpoint);
      if (endpoint === "/expense/search") return jsonResponse({ status: true, results_count: 0, results_list: [] });
      return jsonResponse({ status: false, reason: "missing_expense_scan" });
    }) as unknown as typeof fetch;
    const issueUploadLink = vi.fn(async () => "https://worker.example/upload/TOKEN");
    const client = await connect(fetchImpl, { issueUploadLink });

    const result = await client.callTool({
      name: "icount_expense_create",
      arguments: { ...baseArgs, expense_paid: true, payment_method: "cash" },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("NOT created yet");
    expect(textOf(result)).toContain("https://worker.example/upload/TOKEN");
    expect(issueUploadLink).toHaveBeenCalledWith({
      body: expect.objectContaining({ supplier_id: 157, expense_docnum: "7290114673709" }),
      expect: expect.objectContaining({
        scan: true,
        payment: { method: "cash", date: "2026-09-20", sum: 100 },
      }),
    });
    expect(calls).toEqual(["/expense/search", "/expense/create"]);
    vi.unstubAllGlobals();
  });

  it("uploads scan_base64 as multipart and reports the new expense id", async () => {
    let createBody: unknown;
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const endpoint = String(url).split("v3.php")[1]!;
      if (endpoint === "/expense/search") return jsonResponse({ status: true, results_count: 0, results_list: [] });
      if (endpoint === "/expense/info") {
        return jsonResponse({ status: true, expense_info: { ...EXPENSE_517, expense_id: "901" } });
      }
      createBody = init!.body;
      return jsonResponse({ status: true, expense_id: 901 });
    }) as unknown as typeof fetch;
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "icount_expense_create",
      arguments: { ...baseArgs, scan_base64: btoa(String.fromCharCode(...JPEG)), scan_filename: "r.jpeg" },
    });

    expect(textOf(result)).toContain("id=901");
    expect(createBody).toBeInstanceOf(FormData);
    expect(((createBody as FormData).get("scan") as File).name).toBe("r.jpg");
    vi.unstubAllGlobals();
  });

  it("does not create a duplicate when the same supplier + docnum exists", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      const endpoint = String(url).split("v3.php")[1]!;
      calls.push(endpoint);
      return jsonResponse({
        status: true,
        results_count: 1,
        results_list: [{ expense_id: 42, supplier_id: 157, expense_docnum: "7290114673709" }],
      });
    }) as unknown as typeof fetch;
    const client = await connect(fetchImpl);

    const result = await client.callTool({ name: "icount_expense_create", arguments: baseArgs });

    expect(textOf(result)).toContain("#42 already exists");
    expect(calls).toEqual(["/expense/search"]);
    vi.unstubAllGlobals();
  });
});

describe("tool JSON schemas", () => {
  it("emit no $ref and carry the YYYY-MM-DD hint on every date field", async () => {
    const client = await connect(vi.fn() as unknown as typeof fetch);
    const { tools } = await client.listTools();
    const create = tools.find((t) => t.name === "icount_expense_create")!;
    const props = create.inputSchema.properties as Record<string, { description?: string }>;
    expect(JSON.stringify(tools)).not.toContain("$ref");
    for (const f of ["invoice_date", "expense_date", "expense_paid_date"]) {
      expect(props[f]!.description).toContain("YYYY-MM-DD");
    }
    expect(create.inputSchema.required).toEqual(
      expect.arrayContaining(["supplier_id", "expense_docnum", "expense_sum", "invoice_date"]),
    );
    expect(create.inputSchema.required).not.toContain("expense_date");
    vi.unstubAllGlobals();
  });
});

// Fields of expense #517 exactly as iCount stored them (created with expense_paid=true,
// vat_amount=0 before the payment step existed).
const EXPENSE_517 = {
  expense_id: "517",
  supplier_id: "157",
  expense_type_id: "94",
  expense_type_name: "נסיעות בתחבורה ציבורית",
  expense_docnum: "7290114673709",
  invoice_date: "2026-09-20",
  expense_sum: "100",
  expense_sum_exc_vat: "84.75",
  manual_no_vat: "1",
  expense_manual_vat: "0",
  expense_paid: "0",
  expense_paid_date: "0000-00-00",
  remainingsum: "100",
  status_text: "לא שולם",
  s3storage_id: "9296906",
};

describe("compareSaved (post-create verification)", () => {
  it("flags the unpaid status of #517 and explains the category-derived VAT figure", () => {
    const w = compareSaved(EXPENSE_517, {
      expense_sum: 100,
      invoice_date: "2026-09-20",
      vat_amount: 0,
      payment: { method: "cash", date: "2026-09-20", sum: 100 },
      scan: true,
    });
    expect(w.some((x) => x.includes("saved as unpaid"))).toBe(true);
    expect(w.some((x) => x.includes("expense_paid_date saved as 0000-00-00"))).toBe(true);
    expect(w.some((x) => x.includes("remaining balance of 100"))).toBe(true);
    expect(w.some((x) => x.includes("84.75") && x.includes("category"))).toBe(true);
    expect(w.some((x) => x.includes("manual_no_vat"))).toBe(false);
    expect(w.some((x) => x.includes("scan"))).toBe(false);
  });

  it("reports nothing once the expense is saved as requested", () => {
    const paid = {
      ...EXPENSE_517,
      expense_type_name: "ללא מעמ",
      expense_sum_exc_vat: "100.00",
      expense_paid: "1",
      expense_paid_date: "2026-09-20",
      remainingsum: "0",
    };
    expect(
      compareSaved(paid, {
        expense_sum: 100,
        invoice_date: "2026-09-20",
        vat_amount: 0,
        payment: { method: "cash", date: "2026-09-20", sum: 100 },
        scan: true,
      }),
    ).toEqual([]);
  });
});

function routedFetch(routes: Record<string, (init?: RequestInit) => unknown>, calls: { endpoint: string; init?: RequestInit }[] = []) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const endpoint = String(url).split("v3.php")[1]!;
    calls.push({ endpoint, init });
    const route = routes[endpoint];
    if (!route) throw new Error(`unexpected call to ${endpoint}`);
    return jsonResponse(route(init));
  }) as unknown as typeof fetch;
}

describe("payment step and read-back", () => {
  it("records a cash payment via /expense/update after creating, then verifies", async () => {
    const calls: { endpoint: string; init?: RequestInit }[] = [];
    let paid = false;
    const fetchImpl = routedFetch(
      {
        "/expense/search": () => ({ status: true, results_count: 0, results_list: {} }),
        "/expense/create": () => ({ status: true, expense_id: 900 }),
        "/expense/update": () => ((paid = true), { status: true }),
        "/expense/info": () => ({
          status: true,
          expense_info: paid
            ? { ...EXPENSE_517, expense_id: "900", expense_paid: "1", expense_paid_date: "2026-09-20", remainingsum: "0" }
            : EXPENSE_517,
        }),
      },
      calls,
    );
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "icount_expense_create",
      arguments: {
        ...baseArgs,
        vat_amount: 0,
        expense_paid: true,
        expense_paid_date: "2026-09-20",
        payment_method: "cash",
        scan_base64: btoa(String.fromCharCode(...JPEG)),
      },
    });

    expect(calls.map((c) => c.endpoint)).toEqual([
      "/expense/search",
      "/expense/create",
      "/expense/update",
      "/expense/info",
    ]);
    const update = JSON.parse(calls[2]!.init!.body as string);
    expect(update).toMatchObject({
      expense_id: 900,
      expense_paid: 1,
      expense_paid_date: "2026-09-20",
      payments: { cash: { sum: 100 } },
    });
    const text = textOf(result);
    expect(text).toContain("id=900");
    expect(text).not.toContain("saved as unpaid");
    // Category 94 still computes an amount before VAT; that is reported, not hidden.
    expect(text).toContain("84.75");
    vi.unstubAllGlobals();
  });

  it("icount_expense_mark_paid pays the open balance and confirms it", async () => {
    const calls: { endpoint: string; init?: RequestInit }[] = [];
    let paid = false;
    const fetchImpl = routedFetch(
      {
        "/expense/update": () => ((paid = true), { status: true }),
        "/expense/info": () => ({
          status: true,
          expense_info: paid
            ? { ...EXPENSE_517, expense_paid: "1", expense_paid_date: "2026-09-20", remainingsum: "0" }
            : EXPENSE_517,
        }),
      },
      calls,
    );
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "icount_expense_mark_paid",
      arguments: { expense_id: 517, payment_method: "cash", paid_date: "2026-09-20" },
    });

    const update = JSON.parse(calls.find((c) => c.endpoint === "/expense/update")!.init!.body as string);
    expect(update.payments).toEqual({ cash: { sum: 100 } });
    expect(textOf(result)).toContain("Payment of 100 (cash, 2026-09-20)");
    expect(textOf(result)).not.toContain("unpaid");
    vi.unstubAllGlobals();
  });
});

describe("icount_expense_search", () => {
  it("filters by expense_docnum itself (iCount ignores it) and returns compact rows", async () => {
    const fetchImpl = routedFetch({
      "/expense/search": () => ({
        status: true,
        results_count: 3,
        results_list: {
          "452": { expense_id: "452", expense_docnum: "49306932", supplier_id: "60", s3storage_id: "0" },
          "517": { ...EXPENSE_517, expense_add_date: "2026-09-29", accountant_status: "0" },
          "481": { expense_id: "481", expense_docnum: "3494840", supplier_id: "0", s3storage_id: "1" },
        },
      }),
    });
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "icount_expense_search",
      arguments: { expense_docnum: "7290114673709" },
    });

    const data = result.structuredContent as { results_count: number; results: Record<string, unknown>[] };
    expect(data.results_count).toBe(1);
    expect(data.results[0]).toMatchObject({ expense_id: "517", has_scan: true, remainingsum: "100" });
    expect(data.results[0]).not.toHaveProperty("accountant_status");
    vi.unstubAllGlobals();
  });
});
