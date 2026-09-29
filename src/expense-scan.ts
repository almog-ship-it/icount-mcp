import type { IcountClient } from "./client.js";

/**
 * Shared logic for creating an expense with an attached scan.
 *
 * iCount's /expense/create takes the scan only as a multipart file part named
 * `scan` (no base64/URL variant). Accounts with "scan required" turned on reject
 * any create without it (`missing_expense_scan`), so both the MCP tool and the
 * Worker's /upload/<token> page funnel through here.
 */

export const MAX_SCAN_BYTES = 10 * 1024 * 1024;

export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanError";
  }
}

export interface ValidatedScan {
  field: "scan";
  filename: string;
  contentType: string;
  data: Uint8Array;
}

const KINDS: { ext: string; mime: string; test: (b: Uint8Array) => boolean }[] = [
  { ext: "pdf", mime: "application/pdf", test: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]) },
  { ext: "jpg", mime: "image/jpeg", test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { ext: "png", mime: "image/png", test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  { ext: "gif", mime: "image/gif", test: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
];

/**
 * Checks size and the real file type (magic bytes, not the claimed name/MIME),
 * and returns a normalized file ready for IcountClient.requestMultipart.
 */
export function validateScan(data: Uint8Array, filename?: string): ValidatedScan {
  if (data.length === 0) throw new ScanError("The scan file is empty.");
  if (data.length > MAX_SCAN_BYTES) {
    throw new ScanError(
      `The scan is ${(data.length / 1024 / 1024).toFixed(1)}MB; the limit is ${MAX_SCAN_BYTES / 1024 / 1024}MB. Compress or resize it and try again.`,
    );
  }
  const kind = KINDS.find((k) => k.test(data));
  if (!kind) {
    if (isHeic(data)) {
      throw new ScanError(
        "HEIC photos are not supported by iCount. Convert to JPEG first (macOS: sips -s format jpeg in.heic --out out.jpg).",
      );
    }
    throw new ScanError("Unsupported file type. Send a JPEG, PNG, GIF or PDF.");
  }
  const base = (filename ?? "").split(/[\\/]/).pop()?.replace(/\.[^.]*$/, "").trim() || "expense-scan";
  return {
    field: "scan",
    filename: `${base}.${kind.ext}`,
    contentType: kind.mime,
    data,
  };
}

/** Decodes plain base64 or a data: URL. */
export function decodeBase64Scan(input: string): Uint8Array {
  const b64 = input.trim().replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new ScanError("scan_base64 is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Looks for an expense with the same supplier + document number, so a retry
 * (or a double-submitted upload page) doesn't book the same receipt twice.
 * Returns undefined when nothing matches or the lookup itself fails.
 */
export async function findExistingExpense(
  client: IcountClient,
  supplierId: unknown,
  docnum: unknown,
): Promise<Record<string, unknown> | undefined> {
  if (supplierId == null || docnum == null || String(docnum).trim() === "") return undefined;
  try {
    const out = await client.request<Record<string, unknown>>("/expense/search", {
      supplier_id: supplierId,
      expense_docnum: String(docnum),
    });
    const list = listOf(out);
    return list.find(
      (e) =>
        String(e.expense_docnum ?? "") === String(docnum) &&
        String(e.supplier_id ?? supplierId) === String(supplierId),
    );
  } catch {
    return undefined;
  }
}

export async function createExpenseWithScan(
  client: IcountClient,
  body: Record<string, unknown>,
  scan: ValidatedScan,
): Promise<Record<string, unknown>> {
  return client.requestMultipart<Record<string, unknown>>("/expense/create", body, scan);
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

function startsWith(b: Uint8Array, sig: number[]): boolean {
  return sig.every((x, i) => b[i] === x);
}

function isHeic(b: Uint8Array): boolean {
  const brand = String.fromCharCode(...b.slice(4, 12));
  return brand.startsWith("ftyphei") || brand.startsWith("ftypmif1") || brand.startsWith("ftypheic");
}
