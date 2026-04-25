import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IcountClient } from "../client.js";
import { asContent } from "./_helpers.js";

export function registerAccountTools(server: McpServer, client: IcountClient): void {
  server.registerTool(
    "icount_account_info",
    {
      title: "Get iCount account info",
      description:
        "Retrieve metadata about the authenticated iCount account (company name, VAT settings, plan, etc.). Useful as a connectivity/auth check.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const out = await client.request<Record<string, unknown>>("/account/info", {});
      return asContent(out, "Account info fetched.");
    },
  );
}
