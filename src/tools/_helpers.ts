import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wraps any iCount response into an MCP CallToolResult.
 * The structured payload goes into structuredContent (for clients that consume JSON);
 * a one-line markdown summary goes into the text content (for human readability).
 */
export function asContent(
  payload: unknown,
  summary: string,
): CallToolResult {
  const structured =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : { value: payload };
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: structured,
  };
}

export function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}
