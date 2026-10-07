#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { loadConfig } from "./config.js";
import { registerAllTools } from "./tools/index.js";
import { login, refreshSites, selectSite } from "./oauth/token.js";
import { clearTokens, readTokens, tokenFileLocation } from "./store.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const INSTRUCTIONS = `Jira Cloud integration acting as the connected Atlassian user.
- If a tool returns NOT_CONNECTED, call jira_connect and ask the user to approve in the browser.
- Issue keys look like PROJ-123. Project keys are the part before the dash.
- Before creating a ticket from a conversation, consider jira_find_duplicate_ticket; prefer jira_create_ticket_from_context for bugs/stories with real content.
- Hierarchy: Epic -> (Feature | Story | Task | Bug) -> Sub-task. Use parentKey, jira_create_child_issue, jira_create_subtask.
- Descriptions and comments accept Markdown.
- Use jira_get_issue_types / jira_get_create_fields when a create fails with a field error.`;

async function runCli(argv: string[]): Promise<boolean> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "login": {
      const state = await login((url) => console.log(`Open this URL in your browser if it did not open automatically:\n\n${url}\n`));
      console.log(`Connected as ${state.account?.displayName ?? "unknown"}${state.account?.email ? ` <${state.account.email}>` : ""}.`);
      console.log(`Sites: ${state.sites.map((s) => `${s.name} (${s.url})`).join(", ")}`);
      if (!state.selectedCloudId) console.log("Several sites available. Run `jira-mcp select <name>` or set JIRA_DEFAULT_SITE.");
      console.log(`Tokens stored in ${tokenFileLocation()}`);
      return true;
    }
    case "status": {
      const t = readTokens();
      if (!t) {
        console.log("Not connected. Run `jira-mcp login`.");
        return true;
      }
      const sel = t.sites.find((s) => s.id === t.selectedCloudId);
      console.log(`Connected as ${t.account?.displayName ?? "unknown"}. Selected site: ${sel ? `${sel.name} (${sel.url})` : "none"}.`);
      console.log(`Sites: ${t.sites.map((s) => `${s.name} (${s.url})`).join(", ")}`);
      return true;
    }
    case "sites": {
      const t = await refreshSites();
      for (const s of t.sites) console.log(`${s.id === t.selectedCloudId ? "*" : " "} ${s.name}\t${s.url}\t${s.id}`);
      return true;
    }
    case "select": {
      if (!arg) throw new Error("Usage: jira-mcp select <site name|url|cloudId>");
      const s = selectSite(arg);
      console.log(`Selected ${s.name} (${s.url}).`);
      return true;
    }
    case "logout": {
      console.log(clearTokens() ? "Tokens removed." : "Not connected.");
      return true;
    }
    case "config": {
      const cfg = loadConfig();
      console.log(JSON.stringify({ ...cfg, clientSecret: cfg.clientSecret ? "(set)" : "(missing)" }, null, 2));
      return true;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(`jira-mcp ${version}
Usage:
  jira-mcp            start the MCP server on stdio (used by Claude)
  jira-mcp login      authorize with Atlassian in the browser
  jira-mcp status     show connection status
  jira-mcp sites      list accessible Jira sites
  jira-mcp select X   select the default site (name, URL or cloud id)
  jira-mcp logout     delete stored tokens
  jira-mcp config     print resolved configuration`);
      return true;
    default:
      return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length && (await runCli(argv))) return;

  const server = new McpServer({ name: "jira-mcp", version }, { instructions: INSTRUCTIONS });
  registerAllTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[jira-mcp] ${version} ready on stdio`);
}

main().catch((err) => {
  console.error(`[jira-mcp] fatal: ${(err as Error).message}`);
  process.exit(1);
});
