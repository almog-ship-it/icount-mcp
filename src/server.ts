import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IcountCreds } from "./auth.js";
import { IcountClient } from "./client.js";
import { registerAccountTools } from "./tools/account.js";
import { registerClientTools } from "./tools/clients.js";
import { registerDocTools } from "./tools/docs.js";
import { registerExpenseTools } from "./tools/expenses.js";
import { registerSupplierTools } from "./tools/suppliers.js";

export const SERVER_NAME = "icount-mcp";
export const SERVER_VERSION = "0.1.0";

export function buildServer(creds: IcountCreds): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  const client = new IcountClient(creds);

  registerDocTools(server, client);
  registerClientTools(server, client);
  registerExpenseTools(server, client);
  registerSupplierTools(server, client);
  registerAccountTools(server, client);

  return server;
}
