import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IcountCreds } from "./auth.js";
import type { ExpenseExpectation } from "./expense-ops.js";
import { IcountClient } from "./client.js";
import { registerAccountTools } from "./tools/account.js";
import { registerClientTools } from "./tools/clients.js";
import { registerDocTools } from "./tools/docs.js";
import { registerExpenseTools } from "./tools/expenses.js";
import { registerSupplierTools } from "./tools/suppliers.js";

export const SERVER_NAME = "icount-mcp";
export const SERVER_VERSION = "0.1.0";

/** An expense waiting for its scan: the /expense/create body plus what to verify afterwards. */
export interface PendingExpense {
  body: Record<string, unknown>;
  expect: ExpenseExpectation;
}

export interface ServerOptions {
  /**
   * Mints a short-lived link where the user (or an agent with a shell) uploads the
   * receipt file to finish an /expense/create. Only the Worker can do this — it
   * needs the OAuth encryption key and the public URL.
   */
  issueUploadLink?: (pending: PendingExpense) => Promise<string>;
  /** Reads a file from the local disk. Only the stdio shim sets this. */
  readLocalFile?: (path: string) => Promise<Uint8Array>;
}

export function buildServer(creds: IcountCreds, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  const client = new IcountClient(creds);

  registerDocTools(server, client);
  registerClientTools(server, client);
  registerExpenseTools(server, client, opts);
  registerSupplierTools(server, client);
  registerAccountTools(server, client);

  return server;
}
