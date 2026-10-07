import { createServer, type Server } from "node:http";

export interface CallbackResult {
  code: string;
  state: string;
}

const PAGE_OK = `<!doctype html><html><head><meta charset="utf-8"><title>Jira connected</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f5f7;color:#172b4d}
.card{background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.08);text-align:center;max-width:420px}</style></head>
<body><div class="card"><h2>Jira is connected</h2><p>You can close this tab and go back to Claude.</p></div></body></html>`;

function pageError(msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Jira connection failed</title></head>
<body style="font-family:system-ui;padding:40px"><h2>Connection failed</h2><pre>${escapeHtml(msg)}</pre></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Starts a throwaway HTTP server on the redirect URI's host/port, waits for a
 * single callback matching `expectedState`, then shuts down.
 */
export function waitForCallback(redirectUri: string, expectedState: string, timeoutMs = 5 * 60_000): Promise<CallbackResult> {
  const target = new URL(redirectUri);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const host = target.hostname;

  return new Promise<CallbackResult>((resolve, reject) => {
    let server: Server;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      // Drop keep-alive sockets too, otherwise a browser may reuse one against this dead instance later.
      server.closeAllConnections();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the Atlassian callback.`)));
    }, timeoutMs);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
      if (url.pathname !== target.pathname) {
        res.writeHead(404).end("not found");
        return;
      }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (err) {
        const desc = url.searchParams.get("error_description") ?? "";
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(pageError(`${err}: ${desc}`));
        finish(() => reject(new Error(`Atlassian returned an error: ${err} ${desc}`.trim())));
        return;
      }
      if (!code || !state || state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(pageError("Invalid or mismatched state/code."));
        finish(() => reject(new Error("OAuth callback had a missing code or mismatched state.")));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE_OK);
      finish(() => resolve({ code, state }));
    });

    server.on("error", (e: NodeJS.ErrnoException) => {
      const hint =
        e.code === "EADDRINUSE"
          ? ` Port ${port} is already in use. Stop whatever is listening there, or change JIRA_OAUTH_REDIRECT_URI (and update the Atlassian app callback to match).`
          : "";
      finish(() => reject(new Error(`Could not start OAuth callback server on ${host}:${port}: ${e.message}.${hint}`)));
    });

    // "localhost" may resolve to ::1 or 127.0.0.1 depending on the browser; bind dual-stack for it.
    if (host === "localhost") server.listen(port);
    else server.listen(port, host);
  });
}
