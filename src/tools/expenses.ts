import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IcountClient } from "../client.js";
import { CurrencySchema, DateStringSchema } from "../schemas.js";
import { asContent } from "./_helpers.js";

export function registerExpenseTools(server: McpServer, client: IcountClient): void {
  // ───────── expense create ─────────
  server.registerTool(
    "icount_expense_create",
    {
      title: "Create iCount expense",
      description:
        "Record an expense (incoming invoice from a supplier). Use after photographing/parsing a supplier receipt.",
      inputSchema: {
        supplier_id: z.union([z.number().int(), z.string()]),
        expense_type_id: z
          .union([z.number().int(), z.string()])
          .describe("Category — call icount_expense_types to list options"),
        expense_doctype: z
          .string()
          .describe("Supplier document type — call icount_expense_doctypes to list"),
        expense_docnum: z.string().describe("Supplier's invoice/receipt number"),
        expense_sum: z.number().describe("Total amount (with VAT, in expense currency)"),
        invoice_date: DateStringSchema.describe("Date on the supplier document"),
        expense_date: DateStringSchema.describe("Date the expense is recognized in your books"),
        expense_paid: z
          .boolean()
          .optional()
          .describe("Whether you have already paid the supplier"),
        expense_paid_date: DateStringSchema.optional().describe("Required if expense_paid=true"),
        currency: CurrencySchema.optional(),
        vat_amount: z.number().optional().describe("VAT amount included in expense_sum"),
        notes: z.string().optional(),
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
        supplier_id: args.supplier_id,
        expense_type_id: args.expense_type_id,
        expense_doctype: args.expense_doctype,
        expense_docnum: args.expense_docnum,
        expense_sum: args.expense_sum,
        invoice_date: args.invoice_date,
        expense_date: args.expense_date,
        expense_paid: args.expense_paid ? 1 : 0,
        ...(args.expense_paid_date ? { expense_paid_date: args.expense_paid_date } : {}),
        ...(args.currency ? { currency_code: args.currency } : {}),
        ...(args.vat_amount != null ? { vat_amount: args.vat_amount } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
      };
      const out = await client.requestOrDryRun("/expense/create", body, {
        expense_id: "DRY-EXP-1",
      });
      return asContent(out, summarizeCreate(out, "Expense"));
    },
  );

  // ───────── expense search ─────────
  server.registerTool(
    "icount_expense_search",
    {
      title: "Search iCount expenses",
      description:
        "Find expenses in a date range, optionally filtered by supplier. " +
        "Both dates are optional: to_date defaults to today, from_date defaults to one year ago.",
      inputSchema: {
        from_date: DateStringSchema.nullish(),
        to_date: DateStringSchema.nullish(),
        supplier_id: z.union([z.number().int(), z.string()]).nullish(),
        expense_type_id: z.union([z.number().int(), z.string()]).nullish(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const today = new Date();
      const toDate = args.to_date ?? today.toISOString().slice(0, 10);
      const oneYearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
      const fromDate = args.from_date ?? oneYearAgo.toISOString().slice(0, 10);

      const out = await client.request<Record<string, unknown>>("/expense/search", {
        start_date: fromDate,
        end_date: toDate,
        ...(args.supplier_id != null ? { supplier_id: args.supplier_id } : {}),
        ...(args.expense_type_id != null ? { expense_type_id: args.expense_type_id } : {}),
      });
      return asContent(
        out,
        `${summarizeArrayLike(out, "expense(s)")} (range ${fromDate} → ${toDate})`,
      );
    },
  );

  // ───────── expense types ─────────
  server.registerTool(
    "icount_expense_types",
    {
      title: "List expense types",
      description: "List the user-defined expense categories. Use to find an expense_type_id.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const out = await client.request<Record<string, unknown>>("/expense/types", {});
      return asContent(out, summarizeArrayLike(out, "type(s)"));
    },
  );

  // ───────── expense doctypes ─────────
  server.registerTool(
    "icount_expense_doctypes",
    {
      title: "List expense document types",
      description:
        "List the supported supplier document types (e.g. 'invoice', 'receipt'). Use to fill expense_doctype.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const out = await client.request<Record<string, unknown>>("/expense/doctypes", {});
      return asContent(out, summarizeArrayLike(out, "doctype(s)"));
    },
  );
}

function summarizeCreate(out: unknown, label: string): string {
  if (typeof out !== "object" || out === null) return `${label} created.`;
  const o = out as Record<string, unknown>;
  if (o.dry_run) return String(o.message ?? `${label} (dry-run).`);
  return `${label} created. id=${o.expense_id ?? "?"}`;
}

function summarizeArrayLike(out: unknown, label: string): string {
  if (typeof out !== "object" || out === null) return "OK.";
  const o = out as Record<string, unknown>;
  for (const key of ["expenses", "types", "doctypes", "results", "list", "items"]) {
    if (Array.isArray(o[key])) return `${(o[key] as unknown[]).length} ${label}.`;
  }
  return "OK.";
}
