import type { JiraClient } from "./client.js";
import type { JiraUser } from "./types.js";

export function myself(c: JiraClient): Promise<JiraUser> {
  return c.api<JiraUser>("/myself");
}

export async function searchUsers(c: JiraClient, query: string, maxResults = 20): Promise<JiraUser[]> {
  const users = await c.api<JiraUser[]>("/user/search", { query: { query, maxResults } });
  return users.filter((u) => u.accountType !== "app");
}

export async function searchAssignable(c: JiraClient, projectKey: string, query: string, maxResults = 20): Promise<JiraUser[]> {
  return c.api<JiraUser[]>("/user/assignable/search", { query: { project: projectKey, query, maxResults } });
}

/**
 * Turns "me", an accountId, an email, or a (partial) display name into an accountId.
 * Returns null for "unassigned"/"none". Throws with candidates when ambiguous.
 */
export async function resolveAccountId(c: JiraClient, who: string | null | undefined, projectKey?: string): Promise<string | null | undefined> {
  if (who === undefined) return undefined;
  if (who === null) return null;
  const w = who.trim();
  if (!w) return undefined;
  const lower = w.toLowerCase();
  if (["unassigned", "none", "nobody", "null"].includes(lower)) return null;
  if (["me", "self", "myself", "currentuser"].includes(lower)) return (await myself(c)).accountId;
  // accountIds look like "5b10ac8d82e05b22cc7d4ef5" or "712020:uuid"
  if (/^[0-9a-f]{24}$/i.test(w) || /^\d+:[0-9a-f-]{36}$/i.test(w)) return w;

  const candidates = projectKey ? await searchAssignable(c, projectKey, w) : await searchUsers(c, w);
  const active = candidates.filter((u) => u.active !== false);
  const pool = active.length ? active : candidates;
  if (pool.length === 1) return pool[0]!.accountId;
  const exact = pool.filter((u) => u.displayName.toLowerCase() === lower || u.emailAddress?.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!.accountId;
  if (pool.length === 0) {
    throw new Error(`No Jira user matches "${who}"${projectKey ? ` who can be assigned issues in ${projectKey}` : ""}.`);
  }
  throw new Error(
    `"${who}" matches several users: ${pool
      .slice(0, 8)
      .map((u) => `${u.displayName}${u.emailAddress ? ` <${u.emailAddress}>` : ""} [${u.accountId}]`)
      .join(", ")}. Pass the accountId.`,
  );
}
