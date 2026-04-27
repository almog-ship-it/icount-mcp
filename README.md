# icount-mcp

Multi-tenant **MCP server** for **iCount** ([icount.co.il](https://www.icount.co.il/)) — Israeli invoicing, receipts, customers, expenses, and suppliers — exposed as 29 typed tools any MCP client can call.

- **Streamable HTTP** transport on **Cloudflare Workers** (one shared URL, anyone with their own iCount API token can use it).
- **Stateless multi-tenancy**: each request carries its own `Authorization: Bearer <icount_token>` and `X-Icount-Cid: <company_id>` header. The server stores nothing.
- **Dry-run sandbox** via `X-Icount-Dry-Run: 1` — write tools log the would-be payload instead of POSTing.
- **Local stdio shim** for personal use without deploying.

---

## Quick deploy

```bash
git clone <this repo>
cd icount-mcp
npm install
npx wrangler login                                  # one-time browser flow

# REQUIRED: generate an OAuth encryption key (32 random bytes, base64).
node -e 'console.log(crypto.randomBytes(32).toString("base64"))'
npx wrangler secret put OAUTH_ENCRYPTION_KEY        # paste the key when prompted

npx wrangler deploy
```

That gives you `https://icount-mcp.<your-subdomain>.workers.dev`. The OAuth encryption key is what lets the Worker issue and verify access tokens for Claude Desktop's "Add custom connector" dialog.

### Optional: gate the URL with a shared secret

```bash
npx wrangler secret put MCP_ACCESS_KEY
# paste any random string when prompted
```

Clients now must send `X-Mcp-Key: <that string>` on every request.

---

## Connecting an MCP client

Each user supplies their own iCount credentials — the server never stores them.

### Get an iCount API token

1. Log in to iCount.
2. **Settings → API** (אזור הגדרות → API).
3. Generate a token. Copy the company ID (`cid`) shown on the same page.

### Option 1 (recommended) — Claude Desktop "Add custom connector"

The Worker speaks OAuth 2.1, with a clever twist: the dialog's `OAuth Client ID` field is the **iCount API token**, and `OAuth Client Secret` is the **iCount CID**. There is no real OAuth provider behind the scenes — the Worker just encrypts your two values into a self-contained access token and decrypts on each request.

In Claude Desktop, **Settings → Connectors → Add custom connector**:

- **URL:** `https://icount-mcp.<your-subdomain>.workers.dev`
- **OAuth Client ID:** your iCount API token
- **OAuth Client Secret:** your iCount CID

Click Connect. After the OAuth handshake completes, the 29 `icount_*` tools appear in the chat tool picker.

### Option 2 — direct bearer (curl, scripts, Cursor, etc.)

For non-OAuth clients, send the credentials in headers directly:

```http
POST https://icount-mcp.<your-subdomain>.workers.dev
Authorization: Bearer YOUR_ICOUNT_API_TOKEN
X-Icount-Cid: YOUR_ICOUNT_COMPANY_ID
```

Add `X-Mcp-Key: ...` if you set the URL gate, or `X-Icount-Dry-Run: 1` to test without writes.

For HTTP-capable JSON-config clients (e.g. via `mcp-remote`):

```json
{
  "mcpServers": {
    "icount": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://icount-mcp.<your-subdomain>.workers.dev",
        "--header", "Authorization: Bearer ${ICOUNT_API_TOKEN}",
        "--header", "X-Icount-Cid: ${ICOUNT_CID}"
      ],
      "env": { "ICOUNT_API_TOKEN": "...", "ICOUNT_CID": "..." }
    }
  }
}
```

---

## Local development

### Run the Worker locally

```bash
npm run dev          # starts wrangler dev on http://localhost:8787
```

Point [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:8787` with the same headers documented above. Use `X-Icount-Dry-Run: 1` to develop tools without burning real iCount credits.

To set `MCP_ACCESS_KEY` for local dev only, create a `.dev.vars` file:

```
MCP_ACCESS_KEY=local-dev-secret
```

Wrangler reads `.dev.vars` automatically. Don't commit it.

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

## Tool catalogue (30)

All tools are prefixed `icount_`. Annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are set so clients can decide when to confirm.

### Documents (10)
- `icount_doc_create` — create invoice / receipt / invrec / refund / order / offer / delivery / deal
- `icount_doc_get` — by id or docnum
- `icount_doc_search` — date range, client, status, free-text
- `icount_doc_list` — paginated (alias of doc_search)
- `icount_doc_get_url` — hosted PDF URL
- `icount_doc_send_email` — (re)send an existing document by email
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
