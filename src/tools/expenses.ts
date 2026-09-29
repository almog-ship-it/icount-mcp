import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IcountClient } from "../client.js";
import { IcountApiError } from "../errors.js";
import {
  describeFinalize,
  type ExpenseExpectation,
  finalizeExpense,
  getExpenseInfo,
  PAYMENT_METHODS,
  type PaymentIntent,
  paymentRows,
} from "../expense-ops.js";
import {
  createExpenseWithScan,
  decodeBase64Scan,
  findExistingExpense,
  MAX_SCAN_BYTES,
  ScanError,
  validateScan,
  type ValidatedScan,
} from "../expense-scan.js";
import { CurrencySchema, dateString } from "../schemas.js";
import type { ServerOptions } from "../server.js";
import { asContent, textResult } from "./_helpers.js";

// A factory: a shared instance makes the JSON-schema generator emit $refs between fields.
const idSchema = () => z.union([z.number().int(), z.string()]);

const paymentMethodSchema = () =>
  z
    .enum(PAYMENT_METHODS)
    .describe(
      "How the supplier was paid. cash / bank_transfer / credit_card record a payment row for the full " +
        "amount; other only sets the paid flag and date.",
    );

export function registerExpenseTools(
  server: McpServer,
  client: IcountClient,
  opts: ServerOptions = {},
): void {
  const maxMb = MAX_SCAN_BYTES / 1024 / 1024;

  // ───────── expense create ─────────
  server.registerTool(
    "icount_expense_create",
    {
      title: "Create iCount expense",
      description:
        "Record an expense (a supplier invoice/receipt) in iCount with the scanned document attached. " +
        `Many iCount accounts REQUIRE the scan (JPEG/PNG/GIF/PDF, max ${maxMb}MB; HEIC must be converted to JPEG first). ` +
        "How to attach it: " +
        (opts.readLocalFile
          ? "(a) scan_file_path — path to the file on this machine; (b) scan_base64 — the file bytes as base64; "
          : "(a) scan_base64 — the file bytes as base64 (only practical for small files); ") +
        (opts.issueUploadLink
          ? "(c) omit the scan — if the account requires one, NOTHING is created and the tool returns a one-hour " +
            "upload link. Give the link to the user (they pick the photo/PDF and press send), or, if you can run " +
            "shell commands with the file on disk, run the curl command returned. The upload itself creates the expense. "
          : "") +
        "If expense_paid is true, the payment is recorded right after creation (pass payment_method). " +
        "The tool then reads the expense back and lists any field iCount saved differently from the request. " +
        "It refuses to book the same supplier_id + expense_docnum twice (override with allow_duplicate).",
      inputSchema: {
        supplier_id: idSchema().describe("Supplier ID — call icount_supplier_list to find it"),
        expense_type_id: idSchema().describe("Category — call icount_expense_types to list options"),
        expense_doctype: z
          .string()
          .describe("Supplier document type — call icount_expense_doctypes to list"),
        expense_docnum: z.string().describe("Supplier's invoice/receipt number"),
        expense_sum: z
          .number()
          .positive()
          .describe("Total amount as printed on the document, VAT included, in the expense currency"),
        invoice_date: dateString("Date printed on the supplier document"),
        expense_date: dateString(
          "Payment due date (last day to pay the supplier). Defaults to invoice_date",
        ).optional(),
        expense_paid: z
          .boolean()
          .optional()
          .describe("Whether the supplier has already been paid in full"),
        expense_paid_date: dateString("Date the supplier was paid. Defaults to invoice_date").optional(),
        payment_method: paymentMethodSchema()
          .optional()
          .describe("How the supplier was paid (used when expense_paid is true; defaults to other)"),
        currency: CurrencySchema.optional(),
        vat_amount: z
          .number()
          .min(0)
          .optional()
          .describe(
            "VAT included in expense_sum, in ILS. Pass 0 for a document without VAT (e.g. a receipt, public " +
              "transport). Omit to let iCount compute VAT from the expense category. Note: iCount still shows " +
              "an amount-before-VAT derived from the category's own VAT setting.",
          ),
        notes: z.string().optional().describe("Free-text comment saved on the expense"),
        ...(opts.readLocalFile
          ? {
              scan_file_path: z
                .string()
                .optional()
                .describe("Absolute path to the receipt/invoice file (JPEG/PNG/GIF/PDF)"),
            }
          : {}),
        scan_base64: z
          .string()
          .optional()
          .describe(
            `Receipt/invoice file as base64 or a data: URL (JPEG/PNG/GIF/PDF, max ${maxMb}MB). ` +
              "Must be the real file bytes — never a placeholder.",
          ),
        scan_filename: z.string().optional().describe("Original file name, e.g. receipt.jpg"),
        allow_duplicate: z
          .boolean()
          .optional()
          .describe("Create even if an expense with the same supplier + document number exists"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const built = buildExpenseBody(args);
      if (typeof built === "string") return textResult(built, true);
      const body = built;
      const expect = buildExpectation(args);

      let scan: ValidatedScan | undefined;
      try {
        const scanFilePath = (args as { scan_file_path?: string }).scan_file_path;
        if (scanFilePath && opts.readLocalFile) {
          scan = validateScan(await opts.readLocalFile(scanFilePath), scanFilePath);
        } else if (args.scan_base64) {
          scan = validateScan(decodeBase64Scan(args.scan_base64), args.scan_filename);
        }
      } catch (e) {
        if (e instanceof ScanError) return textResult(`Scan rejected: ${e.message}`, true);
        return textResult(`Could not read the scan file: ${(e as Error).message}`, true);
      }

      if (client.isDryRun) {
        const out = await client.requestOrDryRun(
          "/expense/create",
          {
            ...body,
            ...(scan
              ? { scan: { filename: scan.filename, type: scan.contentType, bytes: scan.data.length } }
              : {}),
            ...(expect.payment
              ? { then_expense_update: { expense_paid: 1, expense_paid_date: expect.payment.date, payments: paymentRows(expect.payment) } }
              : {}),
          },
          { expense_id: "DRY-EXP-1" },
        );
        return asContent(out, summarizeCreate(out));
      }

      if (!args.allow_duplicate) {
        const existing = await findExistingExpense(client, body.supplier_id, body.expense_docnum);
        if (existing) {
          return asContent(
            compactExpense(existing),
            `NOT created — expense #${existing.expense_id ?? "?"} already exists for supplier ` +
              `${body.supplier_id} with document number ${body.expense_docnum}. ` +
              "Pass allow_duplicate=true only if this really is a second, separate expense.",
          );
        }
      }

      let out: Record<string, unknown>;
      if (scan) {
        out = await createExpenseWithScan(client, body, { ...scan });
        expect.scan = true;
      } else {
        try {
          out = await client.request<Record<string, unknown>>("/expense/create", body);
        } catch (e) {
          if (!(e instanceof IcountApiError) || e.raw.reason !== "missing_expense_scan") throw e;
          if (!opts.issueUploadLink) {
            return textResult(
              "NOT created — this iCount account requires a scan of the supplier document. " +
                "Call again with scan_file_path or scan_base64.",
              true,
            );
          }
          const link = await opts.issueUploadLink({ body, expect: { ...expect, scan: true } });
          return textResult(
            [
              "Expense NOT created yet — this iCount account requires a scan of the supplier document.",
              "",
              `Upload link (valid for 1 hour): ${link}`,
              "",
              "• The user opens the link, picks the receipt photo or PDF and presses send. The expense is created on upload" +
                (expect.payment ? ", the payment recorded," : "") +
                " and the saved values are checked against this request.",
              `• With a shell and the file on disk: curl -sS -F "scan=@/path/to/receipt.jpg" "${link}"`,
              "  The JSON reply contains the new expense_id, the saved fields and any warnings.",
              "",
              `Afterwards: icount_expense_search with expense_docnum=${body.expense_docnum}.`,
            ].join("\n"),
          );
        }
      }

      const fin = await finalizeExpense(client, out.expense_id, expect);
      return asContent(
        { expense_id: out.expense_id, saved: fin.saved, warnings: fin.warnings },
        [summarizeCreate(out) + (scan ? ` Scan attached (${scan.filename}).` : ""), describeFinalize(fin)]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  // ───────── expense mark paid ─────────
  server.registerTool(
    "icount_expense_mark_paid",
    {
      title: "Mark iCount expense as paid",
      description:
        "Record the payment of an existing expense (replaces any payment rows it already has), " +
        "then read it back to confirm it is saved as paid.",
      inputSchema: {
        expense_id: idSchema(),
        payment_method: paymentMethodSchema(),
        paid_date: dateString("Date the supplier was paid"),
        sum: z
          .number()
          .positive()
          .optional()
          .describe("Amount paid, in the expense currency. Defaults to the expense's open balance"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (client.isDryRun) {
        const out = await client.requestOrDryRun(
          "/expense/update",
          { expense_id: args.expense_id, expense_paid: 1, expense_paid_date: args.paid_date },
          { expense_id: args.expense_id },
        );
        return asContent(out, summarizeCreate(out));
      }
      const info = await getExpenseInfo(client, args.expense_id);
      if (!info) return textResult(`Expense #${args.expense_id} was not found.`, true);
      const sum = args.sum ?? openBalance(info);
      if (!sum || sum <= 0) {
        return textResult(
          `Expense #${args.expense_id} has no open balance to pay; pass sum explicitly if it should be recorded anyway.`,
          true,
        );
      }
      const payment: PaymentIntent = { method: args.payment_method, date: args.paid_date, sum };
      const fin = await finalizeExpense(client, args.expense_id, {
        expense_sum: Number(info.expense_sum),
        payment,
      });
      return asContent(
        { expense_id: args.expense_id, saved: fin.saved, warnings: fin.warnings, update_response: fin.payment_response },
        [`Payment of ${sum} (${args.payment_method}, ${args.paid_date}) sent for expense #${args.expense_id}.`, describeFinalize(fin)]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  // ───────── expense get ─────────
  server.registerTool(
    "icount_expense_get",
    {
      title: "Get iCount expense",
      description: "Retrieve one expense by ID, including its payment status and details.",
      inputSchema: { expense_id: idSchema() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>("/expense/info", {
        expense_id: args.expense_id,
      });
      return asContent(out, `Fetched expense #${args.expense_id}`);
    },
  );

  // ───────── expense search ─────────
  server.registerTool(
    "icount_expense_search",
    {
      title: "Search iCount expenses",
      description:
        "Find expenses by date range, supplier, category, supplier document number or id. " +
        "Returns compact rows (id, dates, supplier, category, document, amount, payment status, scan); " +
        "use icount_expense_get or full=true for every field. " +
        "Without a date range, a search by expense_docnum or expense_id covers all dates; " +
        "otherwise to_date defaults to today and from_date to one year ago.",
      inputSchema: {
        from_date: dateString("Start of the invoice-date range").nullish(),
        to_date: dateString("End of the invoice-date range").nullish(),
        supplier_id: idSchema().nullish(),
        expense_type_id: idSchema().nullish(),
        expense_docnum: z.string().nullish().describe("Supplier's invoice/receipt number (exact match)"),
        expense_id: idSchema().nullish(),
        limit: z.number().int().positive().max(500).nullish().describe("Max rows returned (default 50)"),
        full: z.boolean().nullish().describe("Return every field instead of compact rows"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const pinpoint = args.expense_docnum != null || args.expense_id != null;
      let range: { start_date: string; end_date: string } | undefined;
      if (!pinpoint || args.from_date != null || args.to_date != null) {
        const today = new Date();
        const oneYearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
        range = {
          start_date: args.from_date ?? oneYearAgo.toISOString().slice(0, 10),
          end_date: args.to_date ?? today.toISOString().slice(0, 10),
        };
      }

      const out = await client.request<Record<string, unknown>>("/expense/search", {
        ...(range ?? {}),
        ...(args.supplier_id != null ? { supplier_id: args.supplier_id } : {}),
        ...(args.expense_type_id != null ? { expense_type_id: args.expense_type_id } : {}),
        ...(args.expense_docnum != null ? { expense_docnum: args.expense_docnum } : {}),
        ...(args.expense_id != null ? { expense_id: args.expense_id } : {}),
        get_supplier_name: true,
      });

      // iCount's /expense/search ignores expense_docnum (verified: it returns every
      // expense in range), so every filter is also applied here.
      const matches = listOf(out).filter(
        (e) =>
          (args.expense_docnum == null || String(e.expense_docnum ?? "") === args.expense_docnum) &&
          (args.expense_id == null || String(e.expense_id) === String(args.expense_id)) &&
          (args.supplier_id == null || String(e.supplier_id) === String(args.supplier_id)) &&
          (args.expense_type_id == null || String(e.expense_type_id) === String(args.expense_type_id)),
      );
      const limit = args.limit ?? 50;
      const rows = matches.slice(0, limit).map((e) => (args.full ? e : compactExpense(e)));
      const scope = range ? `range ${range.start_date} → ${range.end_date}` : "all dates";
      const shown = rows.length < matches.length ? `, showing first ${rows.length} (raise limit for more)` : "";
      return asContent(
        { results_count: matches.length, results: rows },
        `${matches.length} expense(s) (${scope}${shown}).`,
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

interface ExpenseArgs {
  supplier_id: number | string;
  expense_type_id: number | string;
  expense_doctype: string;
  expense_docnum: string;
  expense_sum: number;
  invoice_date: string;
  expense_date?: string;
  expense_paid?: boolean;
  expense_paid_date?: string;
  payment_method?: (typeof PAYMENT_METHODS)[number];
  currency?: string;
  vat_amount?: number;
  notes?: string;
}

/**
 * Maps tool args to iCount's /expense/create fields (per the API reference):
 *   - notes → `comment` (iCount has no `notes` field on expenses)
 *   - vat_amount → detailed VAT mode: `adv_expense` + `expense_manual_vat`, or
 *     `manual_no_vat` when 0. In that mode iCount reads expense_sum as the NET
 *     amount, so VAT is subtracted from the gross total the caller passes.
 *   - payment fields are left out: the payment is recorded afterwards with
 *     /expense/update (see expense-ops.ts).
 * Returns an error string when the combination can't be expressed.
 */
export function buildExpenseBody(args: ExpenseArgs): Record<string, unknown> | string {
  const body: Record<string, unknown> = {
    supplier_id: args.supplier_id,
    expense_type_id: args.expense_type_id,
    expense_doctype: args.expense_doctype,
    expense_docnum: args.expense_docnum,
    expense_sum: args.expense_sum,
    invoice_date: args.invoice_date,
    ...(args.expense_date ? { expense_date: args.expense_date } : {}),
    ...(args.currency ? { currency_code: args.currency } : {}),
    ...(args.notes ? { comment: args.notes } : {}),
  };

  if (args.vat_amount != null) {
    if (args.currency && args.currency !== "ILS") {
      return "vat_amount is only supported for ILS expenses (iCount takes manual VAT in shekels). Omit it for foreign-currency expenses.";
    }
    if (args.vat_amount > args.expense_sum) {
      return `vat_amount (${args.vat_amount}) cannot exceed expense_sum (${args.expense_sum}).`;
    }
    body.adv_expense = 1;
    if (args.vat_amount === 0) {
      body.manual_no_vat = 1;
    } else {
      body.expense_manual_vat = args.vat_amount;
      body.expense_sum = round2(args.expense_sum - args.vat_amount);
    }
  }
  return body;
}

export function buildExpectation(args: ExpenseArgs): ExpenseExpectation {
  return {
    expense_sum: args.expense_sum,
    invoice_date: args.invoice_date,
    ...(args.vat_amount != null ? { vat_amount: args.vat_amount } : {}),
    ...(args.expense_paid
      ? {
          payment: {
            method: args.payment_method ?? "other",
            date: args.expense_paid_date ?? args.invoice_date,
            sum: args.expense_sum,
          },
        }
      : {}),
  };
}

const COMPACT_FIELDS = [
  "expense_id",
  "invoice_date",
  "expense_date",
  "supplier_id",
  "supplier_name",
  "expense_type_id",
  "expense_type_name",
  "expense_doctype",
  "expense_docnum",
  "expense_sum",
  "currency_icon",
  "expense_paid",
  "expense_paid_date",
  "remainingsum",
  "comment",
] as const;

function compactExpense(e: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of COMPACT_FIELDS) if (e[k] != null && e[k] !== "") out[k] = e[k];
  out.has_scan = e.s3storage_id != null && String(e.s3storage_id) !== "0";
  return out;
}

function openBalance(info: Record<string, unknown>): number {
  const remaining = Number(info.remainingsum);
  if (Number.isFinite(remaining) && remaining > 0) return remaining;
  return 0;
}

function listOf(out: unknown): Record<string, unknown>[] {
  if (typeof out !== "object" || out === null) return [];
  const o = out as Record<string, unknown>;
  for (const key of ["results_list", "expenses", "results"]) {
    const v = o[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    if (v && typeof v === "object") return Object.values(v) as Record<string, unknown>[];
  }
  return [];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarizeCreate(out: unknown): string {
  if (typeof out !== "object" || out === null) return "Expense created.";
  const o = out as Record<string, unknown>;
  if (o.dry_run) return String(o.message ?? "Expense (dry-run).");
  return `Expense created. id=${o.expense_id ?? "?"}.`;
}

function summarizeArrayLike(out: unknown, label: string): string {
  if (typeof out !== "object" || out === null) return "OK.";
  const o = out as Record<string, unknown>;
  if (typeof o.results_count === "number") return `${o.results_count} ${label}.`;
  for (const key of ["results_list", "expenses", "types", "doctypes", "results", "list", "items"]) {
    const v = o[key];
    if (Array.isArray(v)) return `${v.length} ${label}.`;
    if (v && typeof v === "object") return `${Object.keys(v).length} ${label}.`;
  }
  return "OK.";
}
