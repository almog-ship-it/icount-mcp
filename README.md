# icount-mcp

Multi-tenant **MCP server** for **iCount** ([icount.co.il](https://www.icount.co.il/)) — Israeli invoicing, receipts, customers, expenses, and suppliers — exposed as 29 typed tools any MCP client can call.

- **Streamable HTTP** transport on **Vercel Edge** (one shared URL, anyone with their own iCount API token can use it).
- **Stateless multi-tenancy**: each request carries its own `Authorization: Bearer <icount_token>` and `X-Icount-Cid: <company_id>` header. The server stores nothing.
- **Dry-run sandbox** via `X-Icount-Dry-Run: 1` — write tools log the would-be payload instead of POSTing.
- **Local stdio shim** for personal use without deploying.

---

## Quick deploy

```bash
git clone <this repo>
cd icount-mcp
npm install
npx vercel link        # one-time
npx vercel --prod
```

That gives you `https://icount-mcp-<your-account>.vercel.app/api/mcp` (also `…/mcp` via the rewrite in `vercel.json`).

### Optional: gate the URL with a shared secret

```bash
npx vercel env add MCP_ACCESS_KEY production
# paste any random string
npx vercel --prod
```

Clients now must send `X-Mcp-Key: <that string>` on every request.

---

## Connecting an MCP client

Each user supplies their own iCount credentials in headers — the server never sees them at deploy time.

### Claude Desktop / Claude Code (HTTP transport)

```json
{
  "mcpServers": {
    "icount": {
      "url": "https://icount-mcp-<your-account>.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_ICOUNT_API_TOKEN",
        "X-Icount-Cid": "YOUR_ICOUNT_COMPANY_ID"
      }
    }
  }
}
```

Add `"X-Mcp-Key": "..."` if you set the gate, or `"X-Icount-Dry-Run": "1"` to test without writes.

### Get an iCount API token

1. Log in to iCount.
2. **Settings → API** (אזור הגדרות → API).
3. Generate a token. Copy the company ID (`cid`) shown on the same page.

---

## Local development

### Run the Edge function locally

```bash
cp .env.local.example .env.local   # only needed if you set MCP_ACCESS_KEY
npm run dev                         # starts vercel dev on http://localhost:3000
```

Point [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:3000/api/mcp` with the same headers documented above. Use `X-Icount-Dry-Run: 1` to develop tools without burning real iCount credits.

### Run as local stdio (no HTTP)

```bash
cp .env.example .env
# fill in ICOUNT_API_TOKEN, ICOUNT_CID
npm run stdio
```

Or register it directly in a stdio-capable MCP client:

```json
{
  "mcpServers": {
    "icount": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/icount-mcp/src/stdio.ts"],
      "env": {
        "ICOUNT_API_TOKEN": "...",
        "ICOUNT_CID": "...",
        "ICOUNT_DRY_RUN": "0"
      }
    }
  }
}
```

---

## Tool catalogue (29)

All tools are prefixed `icount_`. Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are set so clients can decide when to confirm.

### Documents (9)
- `icount_doc_create` — create invoice / receipt / invrec / refund / order / offer / delivery / deal
- `icount_doc_get` — by id or docnum
- `icount_doc_search` — date range, client, status, free-text
- `icount_doc_list` — paginated
- `icount_doc_get_url` — hosted PDF URL
- `icount_doc_cancel` — destructive (issues credit doc for tax invoices)
- `icount_doc_close` — mark paid/closed
- `icount_doc_convert` — quote → order → invoice
- `icount_doc_update_income_type`

### Customers (11)
- `icount_client_create` / `_update` / `_upsert` (by vat_id or email)
- `icount_client_get` / `_delete` / `_list`
- `icount_client_get_open_docs`
- `icount_client_get_contacts` / `_add_contact` / `_update_contact` / `_delete_contact`

### Expenses (4)
- `icount_expense_create`
- `icount_expense_search`
- `icount_expense_types` (list categories)
- `icount_expense_doctypes` (list supplier doc types)

### Suppliers (4)
- `icount_supplier_get` / `_list` / `_add` / `_update`

### Account (1)
- `icount_account_info` — connectivity check

---

## Notes & limits

- **Rate limit:** iCount caps at **30 requests/minute per token**. The client surfaces 429s with the `Retry-After` value; clients should backoff or batch.
- **Dry-run scope:** writes are short-circuited (return a `DRY-*` synthetic payload); reads still hit the real API. This lets you test connectivity without risking changes.
- **Tax invoice cancellation:** `icount_doc_cancel` is irreversible from the agent's perspective — for tax invoices iCount issues a credit document under the hood. Always confirm with the user.
- **Currencies & VAT:** items are sent at unit price *before* VAT; iCount calculates totals from your account's VAT rate. Use `vat_excluded:true` per-item to mark tax-exempt lines.
- **Hebrew strings** pass through unchanged. RTL formatting is the caller's responsibility.

## License

MIT.
