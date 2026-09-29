import type { IcountCreds } from "./auth.js";
import { IcountApiError, type IcountErrorPayload } from "./errors.js";

export const ICOUNT_BASE_URL = "https://api.icount.co.il/api/v3.php";

export interface RequestOptions {
  /** If true, write endpoints short-circuit and return a synthetic dry-run response. */
  isWrite?: boolean;
  /** Timeout in ms (default 15000). */
  timeoutMs?: number;
}

export interface DryRunResult {
  dry_run: true;
  endpoint: string;
  request_body: Record<string, unknown>;
  message: string;
}

export type IcountResponse<T> = T | DryRunResult;

export interface UploadFile {
  /** Form field name iCount expects (e.g. "scan"). */
  field: string;
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/**
 * Stateless iCount HTTP client. One instance per request — owns the per-request creds.
 *
 * - `request()` for normal calls (returns parsed JSON or throws IcountApiError).
 * - `requestOrDryRun()` for write-style calls; returns a dry-run shape if creds.dryRun is set.
 */
export class IcountClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly creds: IcountCreds,
    fetchImpl?: typeof fetch,
    private readonly baseUrl: string = ICOUNT_BASE_URL,
  ) {
    // Bind to globalThis: in Cloudflare Workers, calling fetch as a method on
    // any other object throws "Illegal invocation". Tests pass their own mocks
    // (which don't care about `this`), so the default-only bind is enough.
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async request<T = unknown>(
    endpoint: string,
    body: Record<string, unknown> = {},
    opts: RequestOptions = {},
  ): Promise<T> {
    const fullBody = { cid: this.creds.cid, ...body };

    return this.send<T>(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.creds.token}`,
        Accept: "application/json",
      },
      body: JSON.stringify(fullBody),
    }, opts.timeoutMs ?? 15000);
  }

  /**
   * multipart/form-data POST — the only way iCount accepts file uploads
   * (e.g. the `scan` field on /expense/create). Scalar fields go as form fields;
   * booleans become "1"/"0". Nested objects are not supported here.
   */
  async requestMultipart<T = unknown>(
    endpoint: string,
    fields: Record<string, unknown>,
    file: UploadFile,
    opts: RequestOptions = {},
  ): Promise<T> {
    const form = new FormData();
    form.append("cid", this.creds.cid);
    for (const [k, v] of Object.entries(fields)) {
      if (v == null) continue;
      if (typeof v === "object") {
        throw new Error(`requestMultipart: field '${k}' is an object; only scalars are supported`);
      }
      form.append(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    }
    form.append(
      file.field,
      new Blob([file.data as BlobPart], { type: file.contentType }),
      file.filename,
    );
    // No Content-Type header: fetch sets multipart/form-data with the boundary.
    return this.send<T>(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.creds.token}`,
        Accept: "application/json",
      },
      body: form,
    }, opts.timeoutMs ?? 60000);
  }

  private async send<T>(endpoint: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new Error(`iCount request to ${endpoint} timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after") ?? "?";
      const text = await safeText(res);
      throw new IcountApiError(429, {
        reason: `Rate limited. Retry-After: ${retryAfter}s`,
        error_code: 429,
        raw: text,
      });
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      const text = await safeText(res);
      throw new IcountApiError(res.status, {
        reason: `Non-JSON response (HTTP ${res.status})`,
        raw: text,
      });
    }

    if (!res.ok) {
      throw new IcountApiError(res.status, asErrorPayload(parsed));
    }

    if (isApiFailure(parsed)) {
      throw new IcountApiError(res.status, parsed as IcountErrorPayload);
    }

    return parsed as T;
  }

  async requestOrDryRun<T extends Record<string, unknown>>(
    endpoint: string,
    body: Record<string, unknown>,
    fakeShape: T,
    opts: Omit<RequestOptions, "isWrite"> = {},
  ): Promise<IcountResponse<T>> {
    if (this.creds.dryRun) {
      return {
        dry_run: true,
        endpoint,
        request_body: { cid: this.creds.cid, ...body },
        message: `DRY-RUN — would POST to ${endpoint}; no data was changed in iCount.`,
        ...fakeShape,
      } as DryRunResult & T;
    }
    return this.request<T>(endpoint, body, opts);
  }

  get isDryRun(): boolean {
    return this.creds.dryRun;
  }
}

function isApiFailure(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    "status" in parsed &&
    (parsed as { status: unknown }).status === false
  );
}

function asErrorPayload(parsed: unknown): IcountErrorPayload {
  if (typeof parsed === "object" && parsed !== null) {
    return parsed as IcountErrorPayload;
  }
  return { reason: String(parsed) };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable response body>";
  }
}
