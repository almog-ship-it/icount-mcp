import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wraps any iCount response into an MCP CallToolResult.
 *
 * We put BOTH the summary AND the full JSON in `content[].text` because
 * many MCP clients (including Claude Desktop) primarily render `text`, and
 * any data that lives only in `structuredContent` ends up invisible to the
 * end user. The structured form is also returned for clients that prefer it.
 */
export function asContent(
  payload: unknown,
  summary: string,
): CallToolResult {
  const structured =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : { value: payload };
  const jsonText = JSON.stringify(structured, null, 2);
  return {
    content: [{ type: "text", text: `${summary}\n\n${jsonText}` }],
    structuredContent: structured,
  };
}

export function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}
