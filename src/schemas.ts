import { z } from "zod";

export const CurrencySchema = z
  .enum(["ILS", "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD"])
  .describe("ISO currency code (ILS for shekels)");

export const DocTypeSchema = z
  .enum([
    "invoice",
    "invrec",
    "receipt",
    "refund",
    "order",
    "offer",
    "delivery",
    "deal",
  ])
  .describe(
    "iCount document type. invoice=חשבונית מס, invrec=חשבונית-קבלה, receipt=קבלה, refund=זיכוי, order=הזמנה, offer=הצעת מחיר, delivery=תעודת משלוח, deal=עסקה",
  );

export const DocItemSchema = z.object({
  description: z.string().min(1).describe("Line-item description (Hebrew or English)"),
  unitprice: z.number().describe("Price per unit, before VAT"),
  quantity: z.number().positive().default(1).describe("Quantity (default 1)"),
  discount: z
    .number()
    .min(0)
    .optional()
    .describe("Per-line discount in absolute currency units (not percentage)"),
  vat_excluded: z
    .boolean()
    .optional()
    .describe("Set true if this specific item is VAT-exempt"),
});
export type DocItem = z.infer<typeof DocItemSchema>;

export const ClientRefSchema = z
  .object({
    client_id: z
      .union([z.number().int(), z.string()])
      .optional()
      .describe("Existing iCount client ID. If set, other fields are ignored."),
    client_name: z.string().optional().describe("Client display name"),
    vat_id: z.string().optional().describe("Israeli ח.פ. / ת.ז."),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    mobile: z.string().optional(),
    fax: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    zip: z.string().optional(),
    country: z.string().optional().describe("Two-letter or full name (e.g. 'IL', 'Israel')"),
  })
  .refine(
    (v) => v.client_id != null || (v.client_name && v.client_name.length > 0),
    { message: "Either client_id or client_name must be provided." },
  );
export type ClientRef = z.infer<typeof ClientRefSchema>;

export const PaymentSchema = z
  .object({
    payment_type: z
      .enum(["cash", "check", "credit_card", "bank_transfer", "paypal", "other"])
      .describe("How the payment was made"),
    sum: z.number().positive().describe("Amount paid (after VAT, in document currency)"),
    payment_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("YYYY-MM-DD; defaults to today"),
    cc_type: z
      .enum(["visa", "mastercard", "amex", "diners", "isracard", "other"])
      .optional()
      .describe("Card brand (only for credit_card)"),
    cc_number: z
      .string()
      .optional()
      .describe("Last 4 digits of card; do NOT pass full PAN"),
    bank: z.string().optional(),
    branch: z.string().optional(),
    account: z.string().optional(),
    check_number: z.string().optional(),
  })
  .describe("Optional payment record attached to the document (used for invrec/receipt)");
export type Payment = z.infer<typeof PaymentSchema>;

export const LangSchema = z
  .enum(["he", "en"])
  .default("he")
  .describe("Document language (he=Hebrew, en=English)");

/**
 * Accepts any reasonable date string Claude may produce (strict YYYY-MM-DD,
 * ISO 8601 datetime, RFC dates) and normalizes to YYYY-MM-DD for iCount.
 * Strict format is documented in the description so the model prefers it.
 */
export const DateStringSchema = z
  .string()
  .transform((raw, ctx) => {
    const s = raw.trim();
    if (!s) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Date is empty" });
      return z.NEVER;
    }
    // Fast path: already YYYY-MM-DD.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Lenient: YYYY-M-D, YYYY/MM/DD, etc.
    const lenient = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (lenient) {
      const [, y, m, d] = lenient;
      return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
    }
    // Last resort: let JS try to parse (handles ISO-8601 with time, RFC, etc.).
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Could not parse as a date. Use YYYY-MM-DD.",
    });
    return z.NEVER;
  })
  .describe("Date in YYYY-MM-DD format (ISO datetimes also accepted, normalized to YYYY-MM-DD)");

export const PaginationSchema = z.object({
  page: z.number().int().positive().optional().describe("Page number (1-indexed)"),
  per_page: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Page size, max 100"),
});
