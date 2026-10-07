import { loadConfig } from "../config.js";
import { readTokens, type JiraSite } from "../store.js";
import { getValidTokens, matchSite } from "../oauth/token.js";
import { JiraError, NotConnectedError, describeJiraErrorBody } from "../util/errors.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Set when the response has no JSON body (204). */
  expectEmpty?: boolean;
}

/**
 * Resolves which Jira site a tool call should target.
 * Precedence: explicit `site` argument > selected site in the token file > JIRA_DEFAULT_SITE > the only site.
 */
export function resolveSite(siteHint?: string): JiraSite {
  const t = readTokens();
  if (!t) throw new NotConnectedError();
  if (t.sites.length === 0) throw new NotConnectedError("No Jira sites are accessible. Re-run jira_connect.");
  if (siteHint) {
    const s = matchSite(t.sites, siteHint);
    if (!s) throw new Error(`Unknown site "${siteHint}". Available: ${t.sites.map((x) => `${x.name} (${x.url})`).join(", ")}`);
    return s;
  }
  if (t.selectedCloudId) {
    const s = t.sites.find((x) => x.id === t.selectedCloudId);
    if (s) return s;
  }
  const cfgHint = loadConfig().defaultSite;
  if (cfgHint) {
    const s = matchSite(t.sites, cfgHint);
    if (s) return s;
  }
  if (t.sites.length === 1) return t.sites[0]!;
  throw new Error(
    `Your account has access to several Jira sites and none is selected. Call jira_select_site with one of: ${t.sites
      .map((x) => `${x.name} (${x.url})`)
      .join(", ")}, or pass the \`site\` argument.`,
  );
}

export class JiraClient {
  constructor(public readonly site: JiraSite) {}

  get baseUrl(): string {
    return `https://api.atlassian.com/ex/jira/${this.site.id}`;
  }

  /** Browser URL for an issue key, e.g. https://acme.atlassian.net/browse/ABC-1 */
  issueUrl(key: string): string {
    return `${this.site.url.replace(/\/+$/, "")}/browse/${key}`;
  }

  /** Jira platform REST API v3. `path` starts with "/", e.g. "/issue/ABC-1". */
  api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>(`/rest/api/3${path}`, opts);
  }

  /** Jira Software agile API 1.0. `path` starts with "/", e.g. "/board". */
  agile<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>(`/rest/agile/1.0${path}`, opts);
  }

  private async request<T>(fullPath: string, opts: RequestOptions, retried = false): Promise<T> {
    const tokens = await getValidTokens(retried);
    const url = new URL(this.baseUrl + fullPath);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        accept: "application/json",
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (res.status === 401 && !retried) {
      // Access token may have been revoked or expired early; refresh once and retry.
      return this.request<T>(fullPath, opts, true);
    }
    if (res.status === 204 || opts.expectEmpty) {
      if (!res.ok) await this.throwFor(res, fullPath);
      return undefined as T;
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (!res.ok) await this.throwFor(res, fullPath, json);
    return json as T;
  }

  private async throwFor(res: Response, path: string, parsed?: unknown): Promise<never> {
    const body = parsed ?? (await res.json().catch(() => undefined));
    const detail = describeJiraErrorBody(body);
    const hint =
      res.status === 403
        ? " (403: your Jira user lacks permission, or the OAuth app is missing a scope for this endpoint)"
        : res.status === 404
          ? " (404: not found, or you do not have permission to see it)"
          : "";
    throw new JiraError(`Jira ${res.status} on ${path}${hint}${detail ? `: ${detail}` : ""}`, res.status, body);
  }
}

export function clientFor(siteHint?: string): JiraClient {
  return new JiraClient(resolveSite(siteHint));
}
