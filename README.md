# jira-mcp

An MCP server that lets Claude (Desktop or Code) create, search and update Jira Cloud work items **as you**, using Atlassian OAuth 2.0 (3LO). Works with any Atlassian tenant; each user authorizes with their own Atlassian account and tokens stay on their machine.

```
Claude Desktop / Claude Code
        │  MCP (stdio)
        ▼
     jira-mcp  ──── OAuth 2.0 access token ────▶  api.atlassian.com/ex/jira/{cloudId}
        │
        └── ~/.config/jira-mcp/tokens.json (0600, rotating refresh token)
```

## What Claude can do

| Area | Tools |
| --- | --- |
| Auth | `jira_connect`, `jira_auth_status`, `jira_list_sites`, `jira_select_site`, `jira_disconnect` |
| Discovery | `jira_myself`, `jira_list_projects`, `jira_get_project`, `jira_get_issue_types`, `jira_get_create_fields`, `jira_get_fields`, `jira_get_link_types`, `jira_get_priorities`, `jira_search_users` |
| Issues | `jira_search_issues` (JQL), `jira_count_issues`, `jira_get_issue`, `jira_create_issue`, `jira_update_issue`, `jira_assign_issue`, `jira_get_transitions`, `jira_transition_issue`, `jira_add_comment`, `jira_get_comments`, `jira_link_issues`, `jira_delete_issue` |
| Hierarchy | `jira_create_epic`, `jira_create_child_issue` (Feature/Story/Task/Bug under an Epic), `jira_create_subtask`, `jira_create_epic_with_children`, `jira_get_children` |
| Sprints | `jira_get_boards`, `jira_get_sprints`, `jira_get_sprint_issues`, `jira_add_to_sprint` |
| Opinionated | `jira_search_my_tickets`, `jira_find_duplicate_ticket`, `jira_create_ticket_from_context` |

Descriptions and comments are written in **Markdown** and converted to Atlassian Document Format (headings, lists, code blocks, tables, links, bold/italic/strike, inline code). Issue descriptions and comments are returned as Markdown.

Your Jira permissions still apply: OAuth scopes never grant more than your Jira user can do.

## 1. Create the Atlassian OAuth app (once per organisation)

Step-by-step with screenshots-level detail and troubleshooting: see [GUIDE.md](GUIDE.md). Short version:

Atlassian's guidance is to ship **one** OAuth app per integration rather than asking every user to create their own. Whoever owns the integration does this once and shares the client ID/secret with users through your usual secrets channel.

1. Open the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/) and choose **Create → OAuth 2.0 integration**. Name it (e.g. `Claude Jira`).
2. **Permissions → Jira API → Add → Configure**, then add these scopes:
   - Classic tab: `read:jira-user`, `read:jira-work`, `write:jira-work`
   - Granular tab: `read:project:jira`
3. Still on the **Granular** tab of Jira API (there is no separate Jira Software card), search `jira-software` and add:
   - `read:board-scope:jira-software`, `read:sprint:jira-software`, `write:sprint:jira-software`, `read:issue:jira-software`
4. **Authorization → OAuth 2.0 (3LO) → Configure** and set the callback URL to exactly:
   ```
   http://localhost:8787/oauth/callback
   ```
5. **Settings** → copy the **Client ID** and **Secret**.
6. Optional but recommended: under **Distribution**, set the app to *Sharing* so users outside your Atlassian org can authorize it. Fill the required details (privacy policy URL etc.).

Skip step 3 and remove the Jira Software scopes from `JIRA_SCOPES` if you do not want sprint/board tools.

## 2. Install

```bash
git clone <this repo> jira-mcp
cd jira-mcp
pnpm install
pnpm build
```

Provide the credentials either as environment variables (set them in the Claude config below) or in `~/.config/jira-mcp/config.json`:

```json
{ "clientId": "…", "clientSecret": "…" }
```

See `.env.example` for all options (`JIRA_OAUTH_REDIRECT_URI`, `JIRA_SCOPES`, `JIRA_DEFAULT_SITE`, `JIRA_MCP_CONFIG_DIR`).

## 3. Authorize

Either from the terminal:

```bash
ATLASSIAN_CLIENT_ID=… ATLASSIAN_CLIENT_SECRET=… node dist/index.js login
```

or later from Claude by asking it to *"connect Jira"* (it calls `jira_connect`, which opens the browser and returns the authorization URL). Approve the consent screen; the browser tab says "Jira is connected". If you take longer than the tool's wait, the login keeps waiting in the background for up to 5 minutes and Claude can confirm with `jira_auth_status`.

If your account can access several Jira sites, pick one:

```bash
node dist/index.js sites
node dist/index.js select acme
```

Other CLI commands: `status`, `logout`, `config`.

## 4. Connect to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and add the server (see `claude_desktop_config.example.json`):

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["/absolute/path/to/jira-mcp/dist/index.js"],
      "env": {
        "ATLASSIAN_CLIENT_ID": "…",
        "ATLASSIAN_CLIENT_SECRET": "…"
      }
    }
  }
}
```

Restart Claude Desktop. Use the full path to `node` (`which node`) if Claude cannot find it, since GUI apps do not load your shell profile.

## 5. Connect to Claude Code

```bash
claude mcp add jira -s user -e ATLASSIAN_CLIENT_ID=… -e ATLASSIAN_CLIENT_SECRET=… -- node /absolute/path/to/jira-mcp/dist/index.js
```

Both clients share the same token file, so you only authorize once per machine.

## Example prompts

- "Create a Jira ticket in THEOS for the Vite 9 migration, assign it to me, add the acceptance criteria we discussed."
- "Is there already a ticket about PostgreSQL schema permissions in THEOS?"
- "Create an epic 'Billing v2' with features 'Invoices' and 'Refunds', each with sub-tasks for API and UI."
- "Move THEOS-42 to In Progress and comment that the PR is up."
- "What's in the active sprint for THEOS that's assigned to me?"
- "Link THEOS-51 as blocked by THEOS-49."

## How it works

- **OAuth**: authorization-code flow with `offline_access`. A throwaway HTTP server listens on the callback port only while a login is in progress. Atlassian rotates refresh tokens; the new one is persisted after every refresh. Concurrent tool calls share a single refresh.
- **Multi-site**: after login the server stores every accessible site from `accessible-resources`. Every tool accepts an optional `site` argument; otherwise the selected site (or `JIRA_DEFAULT_SITE`) is used.
- **Name resolution**: issue types, users (name/email/"me"), priorities, link-type phrases ("is blocked by"), custom fields (by name) and sprints ("active", "next", a name) are resolved to ids server-side so Claude does not have to.
- **Errors** come back as readable tool errors (`NOT_CONNECTED: …`, `Jira 403 … missing a scope`) so Claude can recover, for example by calling `jira_connect`.
- Nothing is written to stdout except MCP protocol messages; logs go to stderr.

## Development

```bash
pnpm dev            # run from source via tsx
pnpm typecheck
pnpm test:adf       # markdown -> ADF conversion checks
```

## Security notes

- Tokens are stored in `~/.config/jira-mcp/tokens.json` with mode 0600. Delete it (or run `jira-mcp logout`) to disconnect this machine; revoke the app at https://id.atlassian.com/manage-profile/apps to revoke entirely.
- Atlassian 3LO does not support PKCE, so the client secret is required for token exchange. Treat it like any other shared app secret.
- `jira_delete_issue` is the only destructive tool; it is annotated as such so clients can require confirmation.
