import type { IcountClient } from "./client.js";

/**
 * Post-create steps for an expense: record the payment, then read the expense
 * back and compare what iCount stored with what was asked for.
 *
 * Why the payment is a separate /expense/update call: iCount tracks expense
 * payments as payment rows (`payments` → total_paid / remainingsum). The bare
 * `expense_paid` flag on /expense/create was stored as unpaid (expense #517),
 * so the flag alone is not reliable. /expense/update takes the rows as plain
 * JSON, which also keeps nested objects out of the multipart upload request.
 */

export const PAYMENT_METHODS = ["cash", "bank_transfer", "credit_card", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface PaymentIntent {
  method: PaymentMethod;
  /** YYYY-MM-DD */
  date: string;
  /** Amount paid, in the expense currency (VAT included). */
  sum: number;
}

/** What the caller asked for, used to check what iCount actually stored. */
export interface ExpenseExpectation {
  expense_sum: number;
  invoice_date?: string;
  vat_amount?: number;
  payment?: PaymentIntent;
  scan?: boolean;
}

export interface FinalizeResult {
  expense_id: unknown;
  saved?: Record<string, unknown>;
  warnings: string[];
  /** Raw /expense/update response of the payment step, when one ran. */
  payment_response?: unknown;
}

export function paymentRows(p: PaymentIntent): Record<string, unknown> | undefined {
  switch (p.method) {
    case "cash":
      return { cash: { sum: p.sum } };
    case "bank_transfer":
      return { banktransfer: { sum: p.sum, date: p.date } };
    case "credit_card":
      return { cc: [{ sum: p.sum, date: p.date, num_of_payments: 1 }] };
    case "other":
      return undefined;
  }
}

export async function recordPayment(
  client: IcountClient,
  expenseId: unknown,
  p: PaymentIntent,
): Promise<unknown> {
  const rows = paymentRows(p);
  return client.request("/expense/update", {
    expense_id: expenseId,
    expense_paid: 1,
    expense_paid_date: p.date,
    ...(rows ? { payments: rows } : {}),
  });
}

export async function getExpenseInfo(
  client: IcountClient,
  expenseId: unknown,
): Promise<Record<string, unknown> | undefined> {
  const out = await client.request<Record<string, unknown>>("/expense/info", {
    expense_id: expenseId,
  });
  const info = out.expense_info;
  return info && typeof info === "object" ? (info as Record<string, unknown>) : undefined;
}

/**
 * Runs the payment step (if requested) and the read-back check. Never throws for
 * a failure after the expense exists — it is already booked, so problems are
 * returned as warnings next to the id instead of hiding it behind an error.
 */
export async function finalizeExpense(
  client: IcountClient,
  expenseId: unknown,
  expect: ExpenseExpectation,
): Promise<FinalizeResult> {
  const result: FinalizeResult = { expense_id: expenseId, warnings: [] };
  if (expenseId == null) {
    result.warnings.push("iCount did not return an expense_id; could not verify what was saved.");
    return result;
  }

  if (expect.payment) {
    try {
      result.payment_response = await recordPayment(client, expenseId, expect.payment);
    } catch (e) {
      result.warnings.push(
        `The expense was created, but recording the ${expect.payment.method} payment failed: ` +
          `${(e as Error).message}. It is saved as unpaid — mark it paid in iCount or retry with icount_expense_mark_paid.`,
      );
    }
  }

  try {
    const info = await getExpenseInfo(client, expenseId);
    if (!info) {
      result.warnings.push("Could not read the expense back from iCount to verify it.");
      return result;
    }
    result.saved = pickSaved(info);
    result.warnings.push(...compareSaved(info, expect));
  } catch (e) {
    result.warnings.push(`Could not read the expense back to verify it: ${(e as Error).message}`);
  }
  return result;
}

const SAVED_FIELDS = [
  "expense_id",
  "supplier_id",
  "supplier_name",
  "expense_type_id",
  "expense_type_name",
  "expense_doctype",
  "expense_docnum",
  "invoice_date",
  "expense_date",
  "expense_sum",
  "expense_sum_exc_vat",
  "manual_no_vat",
  "expense_manual_vat",
  "expense_paid",
  "expense_paid_date",
  "total_paid",
  "remainingsum",
  "status_text",
  "comment",
  "s3storage_link",
] as const;

function pickSaved(info: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SAVED_FIELDS) if (k in info) out[k] = info[k];
  return out;
}

export function compareSaved(info: Record<string, unknown>, expect: ExpenseExpectation): string[] {
  const w: string[] = [];
  const num = (v: unknown) => (v == null || v === "" ? NaN : Number(v));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

  if (expect.invoice_date && info.invoice_date !== expect.invoice_date) {
    w.push(`invoice_date saved as ${String(info.invoice_date)}, expected ${expect.invoice_date}.`);
  }

  if (expect.vat_amount == null || expect.vat_amount === 0) {
    const sum = num(info.expense_sum);
    if (!near(sum, expect.expense_sum)) {
      w.push(`expense_sum saved as ${String(info.expense_sum)}, expected ${expect.expense_sum}.`);
    }
  }

  if (expect.vat_amount != null) {
    if (expect.vat_amount === 0) {
      if (String(info.manual_no_vat) !== "1") {
        w.push(`Asked for no VAT, but manual_no_vat was saved as ${String(info.manual_no_vat)}.`);
      }
      const exc = num(info.expense_sum_exc_vat);
      const sum = num(info.expense_sum);
      if (!Number.isNaN(exc) && !Number.isNaN(sum) && !near(exc, sum)) {
        w.push(
          `Saved without manual VAT, but iCount shows an amount before VAT of ${exc} (of ${sum}). ` +
            `That figure comes from the expense category's own VAT setting ` +
            `(${String(info.expense_type_name ?? info.expense_type_id)}). ` +
            "Whether VAT may be deducted here is a question for the accountant; a category marked " +
            "without VAT avoids it.",
        );
      }
    } else if (!near(num(info.expense_manual_vat), expect.vat_amount)) {
      w.push(
        `VAT saved as ${String(info.expense_manual_vat)}, expected ${expect.vat_amount}.`,
      );
    }
  }

  if (expect.payment) {
    if (String(info.expense_paid) !== "1") {
      w.push(`Asked to mark it paid, but it is saved as unpaid (status: ${String(info.status_text ?? "?")}).`);
    }
    if (info.expense_paid_date !== expect.payment.date) {
      w.push(`expense_paid_date saved as ${String(info.expense_paid_date)}, expected ${expect.payment.date}.`);
    }
    if (expect.payment.method !== "other") {
      const remaining = num(info.remainingsum);
      if (!Number.isNaN(remaining) && remaining > 0.009) {
        w.push(`A remaining balance of ${remaining} is still open after recording the payment.`);
      }
    }
  }

  if (expect.scan && (info.s3storage_id == null || String(info.s3storage_id) === "0")) {
    w.push("The scan does not appear on the saved expense.");
  }
  return w;
}

/** Human-readable block for tool output and the upload response. */
export function describeFinalize(r: FinalizeResult): string {
  const lines: string[] = [];
  if (r.warnings.length) {
    lines.push("⚠ Check these against what was requested:");
    for (const w of r.warnings) lines.push(`  - ${w}`);
  } else if (r.saved) {
    lines.push("Verified: the saved expense matches the request.");
  }
  return lines.join("\n");
}
