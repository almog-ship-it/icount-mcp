export interface IcountErrorPayload {
  status?: boolean;
  reason?: string;
  error_code?: number | string;
  errors?: unknown;
  [k: string]: unknown;
}

export class IcountApiError extends Error {
  readonly httpStatus: number;
  readonly errorCode?: number | string;
  readonly raw: IcountErrorPayload;

  constructor(httpStatus: number, payload: IcountErrorPayload) {
    super(toMessage(httpStatus, payload));
    this.name = "IcountApiError";
    this.httpStatus = httpStatus;
    this.errorCode = payload.error_code;
    this.raw = payload;
  }
}

function toMessage(httpStatus: number, payload: IcountErrorPayload): string {
  const reason = payload.reason ?? "Unknown error";
  const code = payload.error_code != null ? ` [code ${payload.error_code}]` : "";
  const hint = hintFor(httpStatus, payload);
  return hint ? `iCount: ${reason}${code}. ${hint}` : `iCount: ${reason}${code}`;
}

function hintFor(httpStatus: number, payload: IcountErrorPayload): string | undefined {
  if (httpStatus === 401 || httpStatus === 403) {
    return "Check your API token at iCount › Settings › API and confirm X-Icount-Cid matches the company.";
  }
  if (httpStatus === 429) {
    return "Rate limited (iCount caps at 30 req/min per token). Slow down or batch.";
  }
  const reason = (payload.reason ?? "").toLowerCase();
  if (reason.includes("token")) return "Re-issue the token from iCount › Settings › API.";
  if (reason.includes("required") || reason.includes("missing")) {
    return "A required field is missing from the request body — check the tool input schema.";
  }
  return undefined;
}
