import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IcountClient } from "../client.js";
import {
  ClientRefSchema,
  CurrencySchema,
  DateStringSchema,
  DocItemSchema,
  DocTypeSchema,
  LangSchema,
  PaginationSchema,
  PaymentSchema,
} from "../schemas.js";
import { textResult, asContent } from "./_helpers.js";

export function registerDocTools(server: McpServer, client: IcountClient): void {
  // ───────── doc create ─────────
  server.registerTool(
    "icount_doc_create",
    {
      title: "Create iCount document",
      description:
        "Create an invoice, receipt, invoice-receipt (חשבונית מס/קבלה), refund, order, offer, delivery note, or deal in iCount. Returns the new doc_id, docnum, and a hosted PDF URL.",
      inputSchema: {
        doctype: DocTypeSchema,
        client: ClientRefSchema,
        items: z.array(DocItemSchema).min(1),
        payment: PaymentSchema.optional(),
        currency: CurrencySchema.optional().describe("Defaults to ILS"),
        lang: LangSchema.optional(),
        comments: z.string().optional().describe("Free-text notes shown on the document"),
        due_date: DateStringSchema.optional().describe("Payment due date (invoices only)"),
        send_email: z
          .boolean()
          .optional()
          .describe("If true, iCount will email the document to the client"),
        email_to: z.string().email().optional().describe("Override recipient email"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const body: Record<string, unknown> = {
        doctype: args.doctype,
        items: args.items.map((i) => ({
          description: i.description,
          unitprice: i.unitprice,
          quantity: i.quantity ?? 1,
          ...(i.discount != null ? { discount: i.discount } : {}),
          ...(i.vat_excluded ? { vat_excluded: 1 } : {}),
        })),
        ...flattenClient(args.client),
        ...(args.currency ? { currency_code: args.currency } : {}),
        ...(args.lang ? { lang: args.lang } : {}),
        ...(args.comments ? { hwc: args.comments } : {}),
        ...(args.due_date ? { due_date: args.due_date } : {}),
        ...(args.send_email ? { email_to_client: 1 } : {}),
        ...(args.email_to ? { email_address: args.email_to } : {}),
        ...(args.payment ? { payment: flattenPayment(args.payment) } : {}),
      };
      const out = await client.requestOrDryRun("/doc/create", body, {
        doc_id: "DRY-DOC-1",
        docnum: "DRY-1234",
        doc_url: "https://example.invalid/dry-run.pdf",
      });
      return asContent(out, summarizeCreate(out));
    },
  );

  // ───────── doc get ─────────
  server.registerTool(
    "icount_doc_get",
    {
      title: "Get iCount document",
      description: "Retrieve full details of a document by ID (or doctype + docnum).",
      inputSchema: {
        doctype: DocTypeSchema,
        doc_id: z.union([z.number().int(), z.string()]).optional(),
        docnum: z.union([z.number().int(), z.string()]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      if (!args.doc_id && !args.docnum) {
        return textResult("Pass either doc_id or docnum.", true);
      }
      const out = await client.request<Record<string, unknown>>("/doc/info", {
        doctype: args.doctype,
        ...(args.doc_id != null ? { doc_id: args.doc_id } : {}),
        ...(args.docnum != null ? { docnum: args.docnum } : {}),
      });
      return asContent(out, `Fetched ${args.doctype} ${args.doc_id ?? args.docnum}`);
    },
  );

  // ───────── doc search ─────────
  server.registerTool(
    "icount_doc_search",
    {
      title: "Search iCount documents",
      description:
        "Find documents matching filters (date range, doctype, client, status). Use for queries like 'invoices in March' or 'all docs for client X'.",
      inputSchema: {
        doctype: DocTypeSchema.optional(),
        client_id: z.union([z.number().int(), z.string()]).optional(),
        from_date: DateStringSchema.optional(),
        to_date: DateStringSchema.optional(),
        only_open: z.boolean().optional().describe("If true, only unpaid/open documents"),
        text: z.string().optional().describe("Full-text search across docnum, client name, etc."),
        ...PaginationSchema.shape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>("/doc/search", {
        ...(args.doctype ? { doctype: args.doctype } : {}),
        ...(args.client_id != null ? { client_id: args.client_id } : {}),
        ...(args.from_date ? { from_date: args.from_date } : {}),
        ...(args.to_date ? { to_date: args.to_date } : {}),
        ...(args.only_open ? { only_open: 1 } : {}),
        ...(args.text ? { text: args.text } : {}),
        ...(args.page ? { page: args.page } : {}),
        ...(args.per_page ? { per_page: args.per_page } : {}),
      });
      return asContent(out, summarizeList(out));
    },
  );

  // ───────── doc list ─────────
  // iCount has no dedicated /doc/list endpoint; this is a thin alias over
  // /doc/search with no filters, matching what users expect from a "list" tool.
  server.registerTool(
    "icount_doc_list",
    {
      title: "List iCount documents",
      description: "List documents (optionally filtered by doctype). Paginated. Backed by /doc/search.",
      inputSchema: {
        doctype: DocTypeSchema.optional(),
        ...PaginationSchema.shape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>("/doc/search", {
        ...(args.doctype ? { doctype: args.doctype } : {}),
        ...(args.page ? { page: args.page } : {}),
        ...(args.per_page ? { per_page: args.per_page } : {}),
      });
      return asContent(out, summarizeList(out));
    },
  );

  // ───────── doc get_url ─────────
  server.registerTool(
    "icount_doc_get_url",
    {
      title: "Get iCount document PDF URL",
      description: "Return the hosted PDF URL for a document. Read-only.",
      inputSchema: {
        doctype: DocTypeSchema,
        doc_id: z.union([z.number().int(), z.string()]),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>("/doc/get_url", {
        doctype: args.doctype,
        doc_id: args.doc_id,
      });
      return asContent(out, `URL fetched for ${args.doctype} #${args.doc_id}`);
    },
  );

  // ───────── doc cancel ─────────
  server.registerTool(
    "icount_doc_cancel",
    {
      title: "Cancel iCount document",
      description:
        "Cancel an existing document. For tax invoices this issues a credit document under the hood. Destructive — confirm before calling.",
      inputSchema: {
        doctype: DocTypeSchema,
        doc_id: z.union([z.number().int(), z.string()]),
        reason: z.string().optional().describe("Cancellation reason (recorded on the credit doc)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await client.requestOrDryRun(
        "/doc/cancel",
        {
          doctype: args.doctype,
          doc_id: args.doc_id,
          ...(args.reason ? { reason: args.reason } : {}),
        },
        { cancelled: true, doc_id: args.doc_id },
      );
      return asContent(out, `Cancelled ${args.doctype} #${args.doc_id}`);
    },
  );

  // ───────── doc close ─────────
  server.registerTool(
    "icount_doc_close",
    {
      title: "Close iCount document",
      description:
        "Mark a document as closed/paid. Use when payment was received outside iCount and you want the doc reconciled.",
      inputSchema: {
        doctype: DocTypeSchema,
        doc_id: z.union([z.number().int(), z.string()]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await client.requestOrDryRun(
        "/doc/close",
        { doctype: args.doctype, doc_id: args.doc_id },
        { closed: true, doc_id: args.doc_id },
      );
      return asContent(out, `Closed ${args.doctype} #${args.doc_id}`);
    },
  );

  // ───────── doc convert ─────────
  server.registerTool(
    "icount_doc_convert",
    {
      title: "Convert iCount document",
      description:
        "Convert a document from one type to another (e.g. quote → order, order → invoice). Source becomes linked.",
      inputSchema: {
        from_doctype: DocTypeSchema,
        from_doc_id: z.union([z.number().int(), z.string()]),
        to_doctype: DocTypeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await client.requestOrDryRun(
        "/doc/convert",
        {
          doctype: args.from_doctype,
          doc_id: args.from_doc_id,
          to_doctype: args.to_doctype,
        },
        {
          new_doc_id: "DRY-DOC-NEW",
          new_doctype: args.to_doctype,
          source_doc_id: args.from_doc_id,
        },
      );
      return asContent(
        out,
        `Converted ${args.from_doctype} #${args.from_doc_id} → ${args.to_doctype}`,
      );
    },
  );

  // ───────── doc update_income_type ─────────
  server.registerTool(
    "icount_doc_update_income_type",
    {
      title: "Update document income type",
      description: "Change the income-type classification on a document (used for accounting reports).",
      inputSchema: {
        doctype: DocTypeSchema,
        doc_id: z.union([z.number().int(), z.string()]),
        income_type_id: z.union([z.number().int(), z.string()]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await client.requestOrDryRun(
        "/doc/update_income_type",
        {
          doctype: args.doctype,
          doc_id: args.doc_id,
          income_type_id: args.income_type_id,
        },
        { updated: true, doc_id: args.doc_id, income_type_id: args.income_type_id },
      );
      return asContent(
        out,
        `Income type → ${args.income_type_id} on ${args.doctype} #${args.doc_id}`,
      );
    },
  );
}

// ─────────────────────────── helpers ───────────────────────────

function flattenClient(c: { client_id?: number | string } & Record<string, unknown>): Record<string, unknown> {
  if (c.client_id != null) return { client_id: c.client_id };
  const out: Record<string, unknown> = {};
  if (c.client_name) out.client_name = c.client_name;
  if (c.vat_id) out.vat_id = c.vat_id;
  if (c.email) out.email = c.email;
  if (c.phone) out.phone = c.phone;
  if (c.mobile) out.mobile = c.mobile;
  if (c.fax) out.fax = c.fax;
  if (c.address) out.address = c.address;
  if (c.city) out.city = c.city;
  if (c.zip) out.zip = c.zip;
  if (c.country) out.country = c.country;
  return out;
}

function flattenPayment(p: Record<string, unknown>): Record<string, unknown> {
  // iCount expects an array of payment legs; one element is the common case.
  return [p] as unknown as Record<string, unknown>;
}

function summarizeCreate(out: unknown): string {
  if (typeof out !== "object" || out === null) return "Document created.";
  const o = out as Record<string, unknown>;
  if (o.dry_run) return String(o.message ?? "Dry-run.");
  const id = o.doc_id ?? o.docnum;
  return `Created. doc_id=${id}${o.doc_url ? ` url=${o.doc_url}` : ""}`;
}

function summarizeList(out: unknown): string {
  if (typeof out !== "object" || out === null) return "OK.";
  const o = out as Record<string, unknown>;
  if (Array.isArray(o.docs)) return `${(o.docs as unknown[]).length} document(s).`;
  if (Array.isArray(o.results)) return `${(o.results as unknown[]).length} result(s).`;
  return "OK.";
}
