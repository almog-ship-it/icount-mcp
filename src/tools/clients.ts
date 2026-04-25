import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { IcountClient } from "../client.js";
import { PaginationSchema } from "../schemas.js";
import { asContent } from "./_helpers.js";

const ClientFieldsSchema = z.object({
  client_name: z.string().optional().describe("Display name (Hebrew or English)"),
  vat_id: z.string().optional().describe("ח.פ./ת.ז."),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  fax: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  country: z.string().optional(),
  notes: z.string().optional(),
});

const ClientIdSchema = z
  .union([z.number().int(), z.string()])
  .describe("iCount client ID");

const ContactFieldsSchema = z.object({
  contact_name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  position: z.string().optional(),
  notes: z.string().optional(),
});

export function registerClientTools(server: McpServer, client: IcountClient): void {
  // ───────── client create ─────────
  server.registerTool(
    "icount_client_create",
    {
      title: "Create iCount client",
      description: "Create a new client in iCount. client_name is required.",
      inputSchema: { ...ClientFieldsSchema.required({ client_name: true }).shape },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await client.requestOrDryRun("/client/create", { ...args }, {
        client_id: "DRY-CLIENT-1",
      });
      return asContent(out, summarizeOne(out, "Client created"));
    },
  );

  // ───────── client update ─────────
  server.registerTool(
    "icount_client_update",
    {
      title: "Update iCount client",
      description: "Update fields on an existing client. Only provided fields are changed.",
      inputSchema: {
        client_id: ClientIdSchema,
        ...ClientFieldsSchema.shape,
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
        "/client/update",
        { ...args },
        { client_id: args.client_id, updated: true },
      );
      return asContent(out, `Client #${args.client_id} updated`);
    },
  );

  // ───────── client upsert ─────────
  server.registerTool(
    "icount_client_upsert",
    {
      title: "Upsert iCount client",
      description:
        "Create or update a client matched by vat_id (preferred) or email. Use when you don't know if the client exists yet.",
      inputSchema: {
        ...ClientFieldsSchema.required({ client_name: true }).shape,
        match_by: z
          .enum(["vat_id", "email"])
          .default("vat_id")
          .describe("Field used to find an existing record"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { match_by, ...fields } = args;
      const out = await client.requestOrDryRun(
        "/client/upsert",
        { match_by, ...fields },
        { client_id: "DRY-CLIENT-UPSERT", upserted: true },
      );
      return asContent(out, summarizeOne(out, "Client upserted"));
    },
  );

  // ───────── client get ─────────
  server.registerTool(
    "icount_client_get",
    {
      title: "Get iCount client",
      description: "Retrieve a client by ID.",
      inputSchema: { client_id: ClientIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>("/client/info", {
        client_id: args.client_id,
      });
      return asContent(out, `Fetched client #${args.client_id}`);
    },
  );

  // ───────── client delete ─────────
  server.registerTool(
    "icount_client_delete",
    {
      title: "Delete iCount client",
      description:
        "Delete a client. Destructive — iCount may refuse if the client has linked documents.",
      inputSchema: { client_id: ClientIdSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await client.requestOrDryRun(
        "/client/delete",
        { client_id: args.client_id },
        { deleted: true, client_id: args.client_id },
      );
      return asContent(out, `Client #${args.client_id} deleted`);
    },
  );

  // ───────── client list ─────────
  server.registerTool(
    "icount_client_list",
    {
      title: "List iCount clients",
      description: "List clients. Paginated. Use detail_level=full for all fields.",
      inputSchema: {
        detail_level: z
          .enum(["minimal", "full"])
          .optional()
          .describe("'minimal' returns id+name only; 'full' returns all fields"),
        ...PaginationSchema.shape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>("/client/get_list", {
        ...(args.detail_level ? { detail_level: args.detail_level } : {}),
        ...(args.page ? { page: args.page } : {}),
        ...(args.per_page ? { per_page: args.per_page } : {}),
      });
      return asContent(out, summarizeArrayLike(out, "client(s)"));
    },
  );

  // ───────── client get_open_docs ─────────
  server.registerTool(
    "icount_client_get_open_docs",
    {
      title: "Get client open documents",
      description: "List unpaid/open documents for a client. Read-only.",
      inputSchema: { client_id: ClientIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>(
        "/client/get_open_docs",
        { client_id: args.client_id },
      );
      return asContent(out, summarizeArrayLike(out, "open document(s)"));
    },
  );

  // ───────── client get_contacts ─────────
  server.registerTool(
    "icount_client_get_contacts",
    {
      title: "Get client contacts",
      description: "List contact persons attached to a client.",
      inputSchema: { client_id: ClientIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const out = await client.request<Record<string, unknown>>(
        "/client/get_contacts",
        { client_id: args.client_id },
      );
      return asContent(out, summarizeArrayLike(out, "contact(s)"));
    },
  );

  // ───────── client add_contact ─────────
  server.registerTool(
    "icount_client_add_contact",
    {
      title: "Add contact to client",
      description: "Attach a new contact person to a client.",
      inputSchema: {
        client_id: ClientIdSchema,
        ...ContactFieldsSchema.shape,
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
        "/client/add_contact",
        { ...args },
        { contact_id: "DRY-CONTACT-1", client_id: args.client_id },
      );
      return asContent(out, `Contact added to client #${args.client_id}`);
    },
  );

  // ───────── client update_contact ─────────
  server.registerTool(
    "icount_client_update_contact",
    {
      title: "Update client contact",
      description: "Update fields on an existing contact.",
      inputSchema: {
        client_id: ClientIdSchema,
        contact_id: z.union([z.number().int(), z.string()]),
        ...ContactFieldsSchema.partial().shape,
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
        "/client/update_contact",
        { ...args },
        { updated: true, contact_id: args.contact_id },
      );
      return asContent(out, `Contact #${args.contact_id} updated`);
    },
  );

  // ───────── client delete_contact ─────────
  server.registerTool(
    "icount_client_delete_contact",
    {
      title: "Delete client contact",
      description: "Remove a contact from a client. Destructive.",
      inputSchema: {
        client_id: ClientIdSchema,
        contact_id: z.union([z.number().int(), z.string()]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const out = await client.requestOrDryRun(
        "/client/delete_contact",
        { client_id: args.client_id, contact_id: args.contact_id },
        { deleted: true, contact_id: args.contact_id },
      );
      return asContent(out, `Contact #${args.contact_id} deleted`);
    },
  );
}

function summarizeOne(out: unknown, prefix: string): string {
  if (typeof out !== "object" || out === null) return prefix;
  const o = out as Record<string, unknown>;
  if (o.dry_run) return String(o.message ?? `${prefix} (dry-run).`);
  return `${prefix}. id=${o.client_id ?? "?"}`;
}

function summarizeArrayLike(out: unknown, label: string): string {
  if (typeof out !== "object" || out === null) return "OK.";
  const o = out as Record<string, unknown>;
  for (const key of ["clients", "results", "contacts", "docs", "items", "list"]) {
    if (Array.isArray(o[key])) return `${(o[key] as unknown[]).length} ${label}.`;
  }
  return "OK.";
}
