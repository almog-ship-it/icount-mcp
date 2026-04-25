import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IcountClient } from "../client.js";
import { asContent } from "./_helpers.js";

const SupplierIdSchema = z.union([z.number().int(), z.string()]);

const SupplierFieldsSchema = z.object({
  supplier_name: z.string().optional(),
  vat_id: z.string().optional().describe("ח.פ./ת.ז. of the supplier"),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  notes: z.string().optional(),
});

export function registerSupplierTools(server: McpServer, client: IcountClient): void {
  server.registerTool(
    "icount_supplier_get",
    {
      title: "Get iCount supplier",
      description: "Retrieve a supplier by ID.",
      inputSchema: { supplier_id: SupplierIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>("/supplier/info", {
        supplier_id: args.supplier_id,
      });
      return asContent(out, `Fetched supplier #${args.supplier_id}`);
    },
  );

  server.registerTool(
    "icount_supplier_list",
    {
      title: "List iCount suppliers",
      description: "List suppliers. detail_level='full' returns all fields.",
      inputSchema: {
        detail_level: z.enum(["minimal", "full"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>("/supplier/get_list", {
        ...(args.detail_level ? { detail_level: args.detail_level } : {}),
      });
      return asContent(out, summarize(out));
    },
  );

  server.registerTool(
    "icount_supplier_add",
    {
      title: "Add iCount supplier",
      description: "Create a new supplier.",
      inputSchema: {
        ...SupplierFieldsSchema.required({ supplier_name: true }).shape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await client.requestOrDryRun(
        "/supplier/add",
        { ...args },
        { supplier_id: "DRY-SUP-1" },
      );
      return asContent(out, summarizeOne(out));
    },
  );

  server.registerTool(
    "icount_supplier_update",
    {
      title: "Update iCount supplier",
      description: "Update fields on an existing supplier.",
      inputSchema: {
        supplier_id: SupplierIdSchema,
        ...SupplierFieldsSchema.shape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await client.requestOrDryRun(
        "/supplier/update",
        { ...args },
        { updated: true, supplier_id: args.supplier_id },
      );
      return asContent(out, `Supplier #${args.supplier_id} updated`);
    },
  );
}

function summarize(out: unknown): string {
  if (typeof out !== "object" || out === null) return "OK.";
  const o = out as Record<string, unknown>;
  for (const key of ["suppliers", "results", "list", "items"]) {
    if (Array.isArray(o[key])) return `${(o[key] as unknown[]).length} supplier(s).`;
  }
  return "OK.";
}

function summarizeOne(out: unknown): string {
  if (typeof out !== "object" || out === null) return "Supplier created.";
  const o = out as Record<string, unknown>;
  if (o.dry_run) return String(o.message ?? "Supplier (dry-run).");
  return `Supplier created. id=${o.supplier_id ?? "?"}`;
}
