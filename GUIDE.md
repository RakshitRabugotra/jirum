# Getting Atlassian OAuth credentials for Jirum

Jirum signs in to Jira with Atlassian OAuth 2.0 (3LO). That needs an **OAuth 2.0 integration** registered in the Atlassian Developer Console. The integration gives you a **Client ID** and a **Secret**; Jirum uses them to turn a one-time browser approval into tokens that act as the signed-in user.

Create the integration **once per team**, not once per person. Every teammate uses the same Client ID and Secret, approves the app with their own Atlassian account, and gets their own tokens on their own machine. Atlassian's guidance is explicit that asking each user to create their own app is not the supported pattern.

Time needed: about 10 minutes. You need an Atlassian account; you do not need to be a Jira admin.

---

## 1. Open the Developer Console

1. Go to https://developer.atlassian.com/ and sign in with the Atlassian account you use for Jira.
2. Click your profile icon (top right) and choose **Developer console**.
   Direct link: https://developer.atlassian.com/console/myapps/

## 2. Create the OAuth 2.0 integration

1. Click **Create** (top right) and choose **OAuth 2.0 integration**.
2. **Name**: something your teammates will recognise on the consent screen, for example `Jirum`.
3. Tick the terms checkbox and click **Create**.

You land on the app's **Overview** page. The left menu has Overview, Distribution, Permissions, Authorization and Settings. The next sections use each of them.

## 3. Add the Jira API scopes

Scopes define the maximum the app may do. A user's own Jira permissions still apply on top.

1. Click **Permissions** in the left menu.
2. On the **Jira API** row click **Add**, then **Configure**. (If scopes were already added, the button reads **Configure**.)
3. On the **Classic scopes** tab, add:
   - `read:jira-user`  View user information
   - `read:jira-work`  Read project and issue data, search issues
   - `write:jira-work`  Create and edit issues, post comments
4. Switch to the **Granular scopes** tab on the same page and add:
   - `read:project:jira`  needed by the board endpoints
5. Stay on the **Granular scopes** tab. The Jira Software (boards and sprints) scopes are listed here as well; there is no separate Jira Software API card in the Permissions list. Type `jira-software` in the tab's search box and add these four:
   - `read:board-scope:jira-software`
   - `read:sprint:jira-software`
   - `write:sprint:jira-software`
   - `read:issue:jira-software`
6. Click **Save**. Back on the Permissions page the Jira API row should show **Scopes used: 8**.

If the search shows nothing for `jira-software`, that app type does not expose the Jira Software scopes and the sprint tools will not work. In that case set this in your env or Claude config so the login only requests scopes the app actually has, otherwise Atlassian rejects the authorization:

```
JIRA_SCOPES=read:jira-user read:jira-work write:jira-work read:project:jira
```

The server adds `offline_access` on its own. Everything except the four sprint and board tools works with that reduced set.

Do **not** add admin scopes such as `manage:jira-configuration` or `manage:jira-project`; nothing in Jirum needs them.

Scopes can be changed later, but every user must re-run the login (`jira_connect` with `force=true`, or `jirum login`) before the new scopes take effect for them.

## 4. Set the callback URL

After a user approves the app, Atlassian redirects their browser to this URL with a one-time code. Jirum listens on it locally during login.

1. Click **Authorization** in the left menu.
2. Next to **OAuth 2.0 (3LO)**, click **Add** (or **Configure** if it already exists).
3. In **Callback URL** enter exactly:
   ```
   http://localhost:8787/oauth/callback
   ```
4. Click **Save changes**.

The URL must match character for character, including `http` (not `https`), the port and the path. If port 8787 is taken on someone's machine, they can set `JIRA_OAUTH_REDIRECT_URI` to another localhost URL, but that URL must also be added here. The console accepts only one callback URL per app, so pick one for the whole team.

## 5. Copy the Client ID and Secret

1. Click **Settings** in the left menu.
2. Under **Authentication details** you will see **Client ID** and **Secret**. Click **Copy** on each.

Keep the Secret private: anyone holding both values can run the consent flow as your app. It is not a password for anyone's account, and it cannot read Jira on its own, but treat it like any shared application secret. Share it through your team's password manager or secrets channel, never in a ticket, chat message or git commit.

If the Secret leaks, come back to this page and use **Rotate secret**, then redistribute it. Existing user logins keep working until their refresh token is next used; after that they will be asked to log in again.

## 6. Let people outside your Atlassian organisation approve it (optional)

By default only users in the developer's own Atlassian organisation can consent to the app. If your teammates sign in with accounts from another organisation, or you are unsure:

1. Click **Distribution** in the left menu.
2. In **Enable sharing**, flip the toggle on.
3. Fill in the form: vendor name, privacy policy URL, and a short description. An internal wiki page is fine for the privacy policy if the app is only used in-house.
4. Save.

Users will see a notice that the app "has not yet been reviewed by Atlassian" on the consent screen. That is expected for an internal integration; Marketplace review is not required.

## 7. Give the credentials to Jirum

Each user needs the two values on their own machine. Pick one of these:

**Option A: environment variables in the Claude config** (simplest)

Claude Desktop, `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jirum": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/jirum/dist/index.js"],
      "env": {
        "ATLASSIAN_CLIENT_ID": "paste-client-id",
        "ATLASSIAN_CLIENT_SECRET": "paste-secret"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add jirum -s user -e ATLASSIAN_CLIENT_ID=paste-client-id -e ATLASSIAN_CLIENT_SECRET=paste-secret -- node /absolute/path/to/jirum/dist/index.js
```

**Option B: a config file**, so the secret is not inside the Claude config:

```bash
mkdir -p ~/.config/jirum
cat > ~/.config/jirum/config.json <<'JSON'
{ "clientId": "paste-client-id", "clientSecret": "paste-secret" }
JSON
chmod 600 ~/.config/jirum/config.json
```

Then register the server without the `env` block / `-e` flags. Environment variables win over the file if both are present.

## 8. Log in and verify

From the project folder:

```bash
node dist/index.js login
```

A browser tab opens on Atlassian. Choose the site, review the permissions, and click **Accept**. The tab should then say **Jira is connected**, and the terminal prints the account and the sites it can reach.

Check at any time with:

```bash
node dist/index.js status
```

Or, from Claude: "check the Jira connection" (it calls `jira_auth_status`).

Tokens are stored in `~/.config/jirum/tokens.json` with permissions `0600`. To disconnect a machine, run `node dist/index.js logout`. To revoke the app entirely for your account, go to https://id.atlassian.com/manage-profile/apps and remove it.

---

## Troubleshooting

| What you see | Cause | Fix |
| --- | --- | --- |
| Atlassian page: **"We couldn't identify the app requesting access"**, `failed to retrieve client` | The Client ID in your config is wrong or empty. | Re-copy the Client ID from **Settings → Authentication details**. Check for stray spaces or quotes. |
| Atlassian page: `redirect_uri` mismatch / **"invalid redirect"** | The callback URL in **Authorization** does not match `JIRA_OAUTH_REDIRECT_URI` (default `http://localhost:8787/oauth/callback`). | Make them identical. Note `http`, port `8787`, path `/oauth/callback`. |
| Consent screen says the app is **not available to your organisation** | Sharing is off and the user is from another Atlassian org. | Follow section 6. |
| `Atlassian token endpoint returned 401: invalid_client` | The Secret is wrong, or it was rotated. | Re-copy the Secret from **Settings**. |
| `Port 8787 is already in use` | Another process is listening on 8787, or a previous login is still waiting. | Wait a few minutes or stop the other process. Alternatively change the callback port in both the console and `JIRA_OAUTH_REDIRECT_URI`. |
| Login succeeds but a tool returns `Jira 403 … missing a scope` | A scope was not added in **Permissions**, or the user logged in before you added it. | Add the scope, then have the user re-run login with `force=true`. |
| `accessible-resources` returns no sites | The user's account is not a member of any Jira site, or the site is on a different Atlassian account than the one they logged in with. | Log in with the account that opens `https://<site>.atlassian.net`. |
| Several sites listed, tools say none is selected | The account can reach more than one Jira site. | Run `node dist/index.js select <site-name>` or set `JIRA_DEFAULT_SITE`. |
| Browser did not open | Headless or SSH session, or `JIRUM_NO_BROWSER` is set. | Copy the URL printed in the terminal (or returned by `jira_connect`) into any browser on the same machine. |

## Reference

- Atlassian: OAuth 2.0 (3LO) apps  https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
- Jira platform scopes  https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/
- Jira Software scopes  https://developer.atlassian.com/cloud/jira/software/scopes-for-oauth-2-3LO-and-forge-apps/
- Manage apps connected to your Atlassian account  https://id.atlassian.com/manage-profile/apps
