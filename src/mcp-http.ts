import type { IncomingHttpHeaders } from "node:http";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { firstHeaderValue } from "./http-security";

const MUTATING_MCP_TOOLS = new Set([
  "update_board_brief",
  "create_comment",
  "update_comment",
  "delete_comment",
  "create_epic",
  "update_epic",
  "delete_epic",
  "create_feature",
  "update_feature",
  "delete_feature",
  "create_user_story",
  "update_user_story",
  "delete_user_story",
  "create_task",
  "update_task",
  "check_acceptance_criterion",
  "add_acceptance_criterion",
  "update_acceptance_criterion",
  "delete_acceptance_criterion",
  "reorder_acceptance_criteria",
  "delete_task",
  "upload_attachment",
  "create_link",
  "update_link",
  "delete_link"
]);

function jsonRpcMessages(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [body];
}

export function getMcpSessionId(headers: IncomingHttpHeaders): string | undefined {
  return firstHeaderValue(headers["mcp-session-id"]);
}

export function isMcpInitializeBody(body: unknown): boolean {
  return jsonRpcMessages(body).some((message) => isInitializeRequest(message));
}

export function getMcpToolNames(body: unknown): string[] {
  return jsonRpcMessages(body).flatMap((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return [];
    }

    const record = message as { method?: unknown; params?: unknown };
    if (record.method !== "tools/call" || typeof record.params !== "object" || record.params === null || Array.isArray(record.params)) {
      return [];
    }

    const name = (record.params as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? [name] : [];
  });
}

export function hasMutatingMcpTool(body: unknown): boolean {
  return getMcpToolNames(body).some((name) => MUTATING_MCP_TOOLS.has(name));
}

export function mcpError(code: number, message: string): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: { code, message },
    id: null
  };
}
