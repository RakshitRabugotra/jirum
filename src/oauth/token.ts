import { loadConfig, requireClientCredentials } from "../config.js";
import { readTokens, writeTokens, type JiraSite, type TokenState } from "../store.js";
import { JiraError, NotConnectedError, describeJiraErrorBody } from "../util/errors.js";
import { buildAuthorizeUrl, newState, openBrowser } from "./authorize.js";
import { waitForCallback } from "./callback.js";

const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";
/** Refresh this many ms before the access token actually expires. */
const REFRESH_SKEW_MS = 60_000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new JiraError(`Atlassian token endpoint returned ${res.status}: ${describeJiraErrorBody(json) || "unknown error"}`, res.status, json);
  }
  return json as TokenResponse;
}

export async function fetchAccessibleResources(accessToken: string): Promise<JiraSite[]> {
  const res = await fetch(RESOURCES_URL, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  const json: unknown = await res.json().catch(() => []);
  if (!res.ok) throw new JiraError(`accessible-resources returned ${res.status}: ${describeJiraErrorBody(json)}`, res.status, json);
  return (json as JiraSite[]).map((s) => ({ id: s.id, name: s.name, url: s.url, scopes: s.scopes ?? [], avatarUrl: s.avatarUrl }));
}

async function fetchMyself(accessToken: string, cloudId: string): Promise<TokenState["account"]> {
  try {
    const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const me = (await res.json()) as { accountId: string; displayName: string; emailAddress?: string };
    return { accountId: me.accountId, displayName: me.displayName, email: me.emailAddress };
  } catch {
    return undefined;
  }
}

export interface PendingLogin {
  url: string;
  startedAt: number;
  done: Promise<TokenState>;
}

let pending: PendingLogin | undefined;
let lastLoginError: { message: string; at: string } | undefined;

/** The login currently waiting for a browser callback, if any. */
export function pendingLogin(): PendingLogin | undefined {
  return pending;
}

/** The most recent failed login in this process, cleared when a login starts or succeeds. */
export function lastLoginFailure(): { message: string; at: string } | undefined {
  return lastLoginError;
}

/**
 * Starts the browser-based authorization code flow. The callback server is
 * listening and the browser has been asked to open before this returns, so the
 * caller can hand the URL to the user while `done` settles in the background.
 * Only one login runs at a time; a second call returns the pending one.
 */
export function startLogin(): PendingLogin {
  if (pending) return pending;
  const cfg = loadConfig();
  requireClientCredentials(cfg);
  const state = newState();
  const url = buildAuthorizeUrl(cfg, state);

  // Start listening before opening the browser so a fast redirect is not lost.
  const callback = waitForCallback(cfg.redirectUri, state);
  openBrowser(url);
  lastLoginError = undefined;
  const done = callback
    .then(({ code }) => completeLogin(cfg, code))
    .then((s) => {
      lastLoginError = undefined;
      return s;
    })
    .finally(() => {
      pending = undefined;
    });
  pending = { url, startedAt: Date.now(), done };
  // Record failures for the next status call; also avoids an unhandled rejection if nobody awaits `done`.
  done.catch((err: Error) => {
    lastLoginError = { message: err.message, at: new Date().toISOString() };
    console.error(`[jira-mcp] login failed: ${err.message}`);
  });
  return pending;
}

/** Convenience for the CLI: runs the whole flow and waits for it. */
export async function login(onUrl?: (url: string) => void): Promise<TokenState> {
  const p = startLogin();
  onUrl?.(p.url);
  return p.done;
}

async function completeLogin(cfg: ReturnType<typeof loadConfig>, code: string): Promise<TokenState> {
  const tok = await postToken({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
  });
  if (!tok.refresh_token) {
    throw new Error("Atlassian did not return a refresh token. Make sure the offline_access scope is requested and granted.");
  }
  const sites = await fetchAccessibleResources(tok.access_token);
  if (sites.length === 0) {
    throw new Error("Authorization succeeded but your account has no accessible Jira sites for this app's scopes.");
  }
  const selected = pickDefaultSite(sites, cfg.defaultSite);
  const state2: TokenState = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + tok.expires_in * 1000,
    scopes: tok.scope ? tok.scope.split(" ") : cfg.scopes,
    sites,
    selectedCloudId: selected?.id,
    account: selected ? await fetchMyself(tok.access_token, selected.id) : undefined,
    updatedAt: new Date().toISOString(),
  };
  writeTokens(state2);
  return state2;
}

export function pickDefaultSite(sites: JiraSite[], hint?: string): JiraSite | undefined {
  if (hint) {
    const found = matchSite(sites, hint);
    if (found) return found;
  }
  return sites.length === 1 ? sites[0] : undefined;
}

/** Matches by cloudId, exact name (case-insensitive), URL, or hostname prefix like "leadrat". */
export function matchSite(sites: JiraSite[], hint: string): JiraSite | undefined {
  const h = hint.trim().toLowerCase().replace(/\/+$/, "");
  return (
    sites.find((s) => s.id.toLowerCase() === h) ??
    sites.find((s) => s.name.toLowerCase() === h) ??
    sites.find((s) => s.url.toLowerCase().replace(/\/+$/, "") === h || s.url.toLowerCase() === `https://${h}`) ??
    sites.find((s) => new URL(s.url).hostname.toLowerCase() === h || new URL(s.url).hostname.toLowerCase().split(".")[0] === h)
  );
}

let refreshing: Promise<TokenState> | undefined;

/**
 * Returns a valid access token, refreshing (and persisting the rotated refresh
 * token) when needed. Concurrent callers share one refresh.
 */
export async function getValidTokens(force = false): Promise<TokenState> {
  const current = readTokens();
  if (!current) throw new NotConnectedError();
  if (!force && current.expiresAt - REFRESH_SKEW_MS > Date.now()) return current;
  if (!refreshing) {
    refreshing = refreshTokens(current).finally(() => {
      refreshing = undefined;
    });
  }
  return refreshing;
}

async function refreshTokens(current: TokenState): Promise<TokenState> {
  const cfg = loadConfig();
  requireClientCredentials(cfg);
  let tok: TokenResponse;
  try {
    tok = await postToken({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: current.refreshToken,
    });
  } catch (err) {
    const e = err as JiraError;
    if (e.status === 400 || e.status === 401 || e.status === 403) {
      throw new NotConnectedError(
        `Jira session expired or was revoked (${e.message}). Run the jira_connect tool (or \`jira-mcp login\`) to re-authorize.`,
      );
    }
    throw err;
  }
  const next: TokenState = {
    ...current,
    accessToken: tok.access_token,
    // Atlassian rotates refresh tokens: the old one is now invalid, keep the new one.
    refreshToken: tok.refresh_token ?? current.refreshToken,
    expiresAt: Date.now() + tok.expires_in * 1000,
    scopes: tok.scope ? tok.scope.split(" ") : current.scopes,
    updatedAt: new Date().toISOString(),
  };
  writeTokens(next);
  return next;
}

/** Re-fetches accessible sites (e.g. after being added to a new Jira site). */
export async function refreshSites(): Promise<TokenState> {
  const t = await getValidTokens();
  const sites = await fetchAccessibleResources(t.accessToken);
  const stillValid = sites.some((s) => s.id === t.selectedCloudId);
  const next: TokenState = {
    ...t,
    sites,
    selectedCloudId: stillValid ? t.selectedCloudId : pickDefaultSite(sites, loadConfig().defaultSite)?.id,
  };
  writeTokens(next);
  return next;
}

export function selectSite(hint: string): JiraSite {
  const t = readTokens();
  if (!t) throw new NotConnectedError();
  const site = matchSite(t.sites, hint);
  if (!site) {
    throw new Error(`No accessible site matches "${hint}". Available: ${t.sites.map((s) => `${s.name} (${s.url})`).join(", ")}`);
  }
  writeTokens({ ...t, selectedCloudId: site.id });
  return site;
}
