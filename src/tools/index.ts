import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthTools } from "./auth.js";
import { registerMetaTools } from "./meta.js";
import { registerIssueTools } from "./issues.js";
import { registerHierarchyTools } from "./hierarchy.js";
import { registerAgileTools } from "./agile.js";
import { registerSmartTools } from "./smart.js";

export function registerAllTools(server: McpServer): void {
  registerAuthTools(server);
  registerMetaTools(server);
  registerIssueTools(server);
  registerHierarchyTools(server);
  registerAgileTools(server);
  registerSmartTools(server);
}
