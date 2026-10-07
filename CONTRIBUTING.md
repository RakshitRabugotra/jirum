# Contributing to Jirum

Thanks for taking the time to contribute. This document explains how to set up the project, what a good change looks like, and how to report problems.

Jirum is a small, local-first tool: it runs on the user's own machine, talks only to Atlassian, and holds that user's OAuth tokens. Changes are reviewed with that in mind, so please read [Security expectations](#security-expectations) before sending code that touches authentication, storage, or request building.

## Ways to contribute

- **Report a bug** – open an issue with the tool name, the arguments (redact anything private), the error text, and your Node version.
- **Suggest a tool or improvement** – open an issue first for anything larger than a small fix, so the approach can be agreed before you write code.
- **Improve the docs** – fixes to `README.md` and `GUIDE.md` are always welcome, especially when the Atlassian console changes.
- **Send a pull request** – see the workflow below.

Please do **not** open a public issue for a security vulnerability. See [Reporting a vulnerability](#reporting-a-vulnerability).

## Development setup

Requirements: Node.js 20 or newer and [pnpm](https://pnpm.io/).

```bash
git clone https://github.com/RakshitRabugotra/jirum.git
cd jirum
pnpm install
pnpm build
```

You need your own Atlassian OAuth 2.0 (3LO) app to run the server end to end. [GUIDE.md](GUIDE.md) walks through creating one. Use a free Atlassian developer site rather than your employer's Jira while developing: several tools create, edit, and delete work items.

Copy `.env.example` to `.env` and fill in the client ID and secret. The server does not load `.env` by itself, so pass it explicitly (Node 20.6+):

```bash
node --env-file=.env dist/index.js login
node --env-file=.env dist/index.js status
```

`.env` is git-ignored. Never commit it, and never paste its contents into an issue or pull request.

### Useful commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the MCP server from source with `tsx` (speaks MCP on stdio) |
| `pnpm build` | Compile `src/` to `dist/` with `tsc` |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm test:adf` | Run the Markdown → ADF conversion checks |
| `node dist/index.js help` | List the CLI subcommands (`login`, `status`, `sites`, `select`, `logout`, `config`) |

To try a build inside an MCP client, point the client at your checkout as described in the README (`node /absolute/path/to/dist/index.js`).

## Project layout

```
src/
  index.ts          Entry point: CLI subcommands, then the stdio MCP server
  config.ts         Environment / config-file resolution
  store.ts          Token and site persistence on disk
  oauth/            Authorization URL, loopback callback listener, token exchange and refresh
  jira/             Thin Jira REST and Agile API client, one file per area
  tools/            MCP tool definitions (auth, meta, issues, hierarchy, agile, smart)
  util/             Markdown <-> ADF conversion, error mapping, output formatting
scripts/
  adf-check.ts      Assertions for the ADF converter
```

## Making a change

1. Fork the repository and create a branch from `develop`.
2. Keep the change focused. One fix or feature per pull request is much easier to review than a bundle.
3. Run `pnpm typecheck` and `pnpm test:adf` before pushing. If you change the ADF converter, add an assertion to `scripts/adf-check.ts` that fails without your change.
4. Update `README.md` when you add, rename, or remove a tool, an environment variable, or a CLI command.
5. Open the pull request against `develop` and describe what changed, why, and how you tested it (which tools you called, against what kind of site).

### Code style

- TypeScript in strict mode, ES modules, `NodeNext` resolution (relative imports end in `.js`).
- Match the surrounding code: small functions, few comments, comments explain *why* rather than *what*.
- No new runtime dependencies without discussion. The dependency list is intentionally short because this process holds credentials.
- **Never write to stdout** outside the MCP transport. stdout carries protocol messages; use `console.error` for logs.

### Adding or changing a tool

Tools are registered through the helpers in `src/tools/helpers.ts`:

- `jiraTool(...)` for tools that call Jira. The handler receives a ready client for the chosen site and every tool automatically gets the optional `site` argument.
- `plainTool(...)` for tools that do not need a Jira client (auth and configuration).

When you add a tool:

- Describe every argument with zod and `.describe()`; the description is what the model reads.
- Set the annotations honestly. `readOnly: true` only when the tool cannot change anything in Jira; `destructive: true` when it removes or irreversibly overwrites data. MCP clients use these hints to decide when to ask the user for confirmation.
- Throw an `Error` with a message the model can act on. The helpers turn thrown errors into `isError` tool results.
- Resolve human-friendly names (issue types, users, priorities, sprints) on the server, as the existing tools do, instead of asking the model for internal ids.
- Register the tool's group in `src/tools/index.ts` if you add a new file.

## Security expectations

This server acts with the connected user's Jira permissions, and the text it reads from Jira (summaries, descriptions, comments, display names) is written by other people. Treat both the model's tool arguments and anything returned by Jira as untrusted input.

- **Secrets never leave the process.** Do not log, return in a tool result, or include in an error message any access token, refresh token, authorization code, or client secret.
- **Encode what you interpolate.** Anything placed in a URL path or query string must be encoded. Anything placed in a JQL string must be quoted and escaped; never build JQL by concatenating raw argument text.
- **Only talk to Atlassian.** Outbound requests go to Atlassian hosts. Do not add code that fetches a URL taken from a tool argument or from Jira content.
- **Keep the token file private.** Files under the config directory are created with owner-only permissions; keep it that way when you touch `src/store.ts`.
- **Keep the OAuth callback strict.** The loopback listener exists only while a login is in progress and must keep verifying `state` before it accepts a code.
- **No shell.** Do not introduce `exec`-style calls that pass a string through a shell.
- **No telemetry.** The project sends nothing anywhere except the Jira API calls the user asked for.

If your change relaxes any of these, call it out in the pull request so it gets the right review.

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include the affected version or commit, what an attacker needs, and the smallest reproduction you can share. Do not include real tokens or client secrets; if a credential was exposed while you were testing, revoke it at <https://id.atlassian.com/manage-profile/apps> and rotate the client secret in the Atlassian Developer Console.

You should get an acknowledgement within a few days. Please give the maintainer reasonable time to ship a fix before disclosing publicly.

## Conduct

Be respectful and assume good intent. Critique code, not people. Harassment or abuse of any kind is not tolerated in issues, pull requests, or reviews.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) that covers this project.
