/**
 * The small HTML page behind /upload/<token>: shows what expense is about to be
 * booked and lets the user pick the receipt file. Hebrew, RTL, works on a phone.
 */

export interface UploadSummary {
  supplier_id?: unknown;
  expense_docnum?: unknown;
  expense_sum?: unknown;
  expense_manual_vat?: unknown;
  currency_code?: unknown;
  invoice_date?: unknown;
  comment?: unknown;
}

export function uploadFormPage(summary: UploadSummary, maxMb: number): string {
  // With manual VAT, expense_sum holds the net amount; show the document total.
  const total =
    typeof summary.expense_sum === "number" && typeof summary.expense_manual_vat === "number"
      ? Math.round((summary.expense_sum + summary.expense_manual_vat) * 100) / 100
      : summary.expense_sum;
  const rows: [string, unknown][] = [
    ["ספק (מזהה)", summary.supplier_id],
    ["מספר מסמך", summary.expense_docnum],
    ["סכום", currencyLabel(total, summary.currency_code)],
    ["תאריך מסמך", summary.invoice_date],
    ["הערה", summary.comment],
  ];
  const table = rows
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(String(v))}</td></tr>`)
    .join("");
  return page(
    "צירוף קבלה להוצאה",
    `<h1>צירוף קבלה להוצאה</h1>
<p class="sub">ההוצאה תירשם ב-iCount רק אחרי שתצרפו את הקובץ.</p>
<table>${table}</table>
<form method="post" enctype="multipart/form-data">
  <label class="pick">
    <input type="file" name="scan" accept="image/jpeg,image/png,image/gif,application/pdf,image/*" required>
  </label>
  <p class="hint">JPEG, PNG, GIF או PDF, עד ${maxMb}MB.</p>
  <button type="submit">שליחה ורישום ההוצאה</button>
</form>
<script>
document.querySelector("form").addEventListener("submit", function (e) {
  var b = e.target.querySelector("button");
  b.disabled = true; b.textContent = "שולח…";
});
</script>`,
  );
}

export function uploadResultPage(
  ok: boolean,
  title: string,
  detail: string,
  warnings: string[] = [],
): string {
  const warn = warnings.length
    ? `<div class="warn"><strong>לבדיקה — iCount שמר חלק מהשדות אחרת מהבקשה:</strong><ul dir="ltr">${warnings
        .map((w) => `<li>${esc(w)}</li>`)
        .join("")}</ul></div>`
    : "";
  return page(
    title,
    `<h1 class="${ok ? "ok" : "err"}">${esc(title)}</h1><p>${esc(detail)}</p>${warn}` +
      (ok ? `<p class="sub">אפשר לסגור את החלון ולחזור ל-Claude.</p>` : ""),
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root { --bg:#f7f7f5; --fg:#1d1d1b; --muted:#6b6b66; --card:#fff; --line:#e3e3de; --accent:#1f5eff; --ok:#177245; --err:#b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#161615; --fg:#ededea; --muted:#a0a09a; --card:#20201e; --line:#34342f; --accent:#7aa2ff; --ok:#5fcf8f; --err:#ff8a80; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif; }
main { max-width:480px; margin:0 auto; padding:32px 16px; }
h1 { font-size:22px; margin:0 0 4px; }
h1.ok { color:var(--ok); } h1.err { color:var(--err); }
.sub, .hint { color:var(--muted); font-size:14px; margin:4px 0 16px; }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; margin-bottom:20px; }
th, td { text-align:start; padding:10px 12px; border-bottom:1px solid var(--line); font-size:15px; }
th { color:var(--muted); font-weight:500; width:40%; }
tr:last-child th, tr:last-child td { border-bottom:0; }
input[type=file] { width:100%; padding:12px; background:var(--card); border:1px dashed var(--line); border-radius:10px; color:var(--fg); }
button { width:100%; padding:14px; font-size:16px; font-weight:600; color:#fff; background:var(--accent); border:0; border-radius:10px; cursor:pointer; }
button:disabled { opacity:.6; }
.warn { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin:16px 0; font-size:14px; }
.warn ul { margin:8px 0 0; padding-left:18px; text-align:left; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function currencyLabel(amount: unknown, code: unknown): string {
  const c = code == null || code === "ILS" ? "₪" : String(code);
  return `${amount} ${c}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
