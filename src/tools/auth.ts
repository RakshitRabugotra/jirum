import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { clearTokens, readTokens, tokenFileLocation } from "../store.js";
import { lastLoginFailure, pendingLogin, refreshSites, selectSite, startLogin } from "../oauth/token.js";
import { json, plainTool, text } from "./helpers.js";

export function registerAuthTools(server: McpServer): void {
  plainTool(
    server,
    "jira_auth_status",
    {
      title: "Jira connection status",
      description: "Shows whether Jira is connected, which Atlassian account is in use, the accessible sites and which one is selected. Call this first if any other tool reports NOT_CONNECTED.",
      readOnly: true,
    },
    {},
    async () => {
      const cfg = loadConfig();
      const t = readTokens();
      if (!t) {
        return json({
          connected: false,
          loginInProgress: Boolean(pendingLogin()),
          lastLoginError: lastLoginFailure(),
          hasClientCredentials: Boolean(cfg.clientId && cfg.clientSecret),
          redirectUri: cfg.redirectUri,
          scopes: cfg.scopes,
          next: "Run jira_connect to authorize with Atlassian.",
        });
      }
      const selected = t.sites.find((s) => s.id === t.selectedCloudId);
      return json({
        connected: true,
        account: t.account,
        selectedSite: selected ? { name: selected.name, url: selected.url, cloudId: selected.id } : null,
        sites: t.sites.map((s) => ({ name: s.name, url: s.url, cloudId: s.id })),
        grantedScopes: t.scopes,
        accessTokenExpiresAt: new Date(t.expiresAt).toISOString(),
        tokenFile: tokenFileLocation(),
      });
    },
  );

  plainTool(
    server,
    "jira_connect",
    {
      title: "Connect Jira (OAuth login)",
      description:
        "Starts the Atlassian OAuth 2.0 login: opens the system browser for consent and returns the authorization URL. Waits up to `waitSeconds` for the user to approve; if they have not yet, the login keeps waiting in the background (5 minutes total) and you can call this tool again or jira_auth_status to check. Show the user the URL if the browser did not open.",
    },
    {
      force: z.boolean().optional().describe("Re-authorize even if already connected."),
      waitSeconds: z.number().int().min(0).max(240).optional().describe("How long to wait for the browser approval before returning (default 45)."),
    },
    async ({ force, waitSeconds }) => {
      const existing = readTokens();
      const failure = lastLoginFailure();
      if (failure && !pendingLogin() && !force) {
        return { content: [{ type: "text", text: `The previous login attempt failed at ${failure.at}: ${failure.message}\nFix the cause (credentials, callback URL, scopes) and call jira_connect with force=true to try again.` }], isError: true };
      }
      if (existing && !force && !pendingLogin()) {
        return text(`Already connected as ${existing.account?.displayName ?? "an Atlassian user"} with ${existing.sites.length} site(s). Pass force=true to re-authorize.`);
      }
      const p = startLogin();
      console.error(`[jira-mcp] Open this URL to authorize Jira:\n${p.url}`);
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), (waitSeconds ?? 45) * 1000));
      const outcome = await Promise.race([p.done, timeout]);
      if (outcome === "timeout") {
        return json({
          connected: false,
          status: "pending",
          authorizationUrl: p.url,
          message: "Waiting for approval in the browser. Ask the user to open the URL and approve, then call jira_connect again (or jira_auth_status) to confirm.",
        });
      }
      const state = outcome;
      const selected = state.sites.find((s) => s.id === state.selectedCloudId);
      return json({
        connected: true,
        account: state.account,
        sites: state.sites.map((s) => ({ name: s.name, url: s.url, cloudId: s.id })),
        selectedSite: selected ? selected.name : null,
        note: selected ? undefined : "Several sites are accessible; call jira_select_site to choose one, or pass `site` on each call.",
      });
    },
  );

  plainTool(
    server,
    "jira_list_sites",
    { title: "List accessible Jira sites", description: "Lists the Jira Cloud sites this account can use through this integration. Re-fetches from Atlassian.", readOnly: true },
    {},
    async () => {
      const t = await refreshSites();
      return json(t.sites.map((s) => ({ name: s.name, url: s.url, cloudId: s.id, selected: s.id === t.selectedCloudId })));
    },
  );

  plainTool(
    server,
    "jira_select_site",
    { title: "Select Jira site", description: "Chooses the default Jira site for all tools (by cloud id, name, or URL). Persists across restarts." },
    { site: z.string().min(1).describe("Cloud id, site name, or URL such as 'acme.atlassian.net'.") },
    async ({ site }) => {
      const s = selectSite(site);
      return text(`Selected ${s.name} (${s.url}).`);
    },
  );

  plainTool(
    server,
    "jira_disconnect",
    { title: "Disconnect Jira", description: "Deletes the stored tokens so this machine is no longer authorized. Revoke the app at https://id.atlassian.com/manage-profile/apps to fully revoke access.", destructive: true },
    {},
    async () => text(clearTokens() ? "Tokens removed. Run jira_connect to authorize again." : "Nothing to remove; Jira was not connected."),
  );
}
