import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const token = process.env.ICOUNT_API_TOKEN;
  const cid = process.env.ICOUNT_CID;
  const dryRun = process.env.ICOUNT_DRY_RUN === "1";

  if (!token || !cid) {
    process.stderr.write(
      "icount-mcp (stdio): ICOUNT_API_TOKEN and ICOUNT_CID must be set in the environment.\n",
    );
    process.exit(1);
  }

  const server = buildServer({ token, cid, dryRun });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `icount-mcp stdio ready (dry_run=${dryRun ? "on" : "off"}).\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`icount-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
