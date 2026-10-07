import type { JiraClient } from "./client.js";
import type { Board, Issue, Page, Sprint } from "./types.js";

export async function listBoards(c: JiraClient, opts: { projectKey?: string; name?: string; type?: string; maxResults?: number } = {}): Promise<Board[]> {
  const page = await c.agile<Page<Board>>("/board", {
    query: { projectKeyOrId: opts.projectKey, name: opts.name, type: opts.type, maxResults: opts.maxResults ?? 50 },
  });
  return page.values;
}

export async function getBoard(c: JiraClient, boardId: number): Promise<Board> {
  return c.agile<Board>(`/board/${boardId}`);
}

export async function listSprints(c: JiraClient, boardId: number, state?: string, maxResults = 50): Promise<Sprint[]> {
  const out: Sprint[] = [];
  let startAt = 0;
  for (;;) {
    const page = await c.agile<Page<Sprint>>(`/board/${boardId}/sprint`, { query: { state, startAt, maxResults } });
    out.push(...page.values);
    if (page.isLast !== false || page.values.length === 0) break;
    startAt += page.values.length;
    if (out.length >= 200) break;
  }
  return out;
}

export async function getSprint(c: JiraClient, sprintId: number): Promise<Sprint> {
  return c.agile<Sprint>(`/sprint/${sprintId}`);
}

export async function sprintIssues(c: JiraClient, sprintId: number, fields: string[], jql?: string, maxResults = 50): Promise<Issue[]> {
  const r = await c.agile<{ issues: Issue[] }>(`/sprint/${sprintId}/issue`, {
    query: { fields: fields.join(","), jql, maxResults },
  });
  return r.issues;
}

export async function moveToSprint(c: JiraClient, sprintId: number, issueKeys: string[]): Promise<void> {
  await c.agile(`/sprint/${sprintId}/issue`, { method: "POST", body: { issues: issueKeys }, expectEmpty: true });
}

/**
 * Finds a sprint by id, exact name, or "active"/"next" on a board resolved
 * from the project when boardId is not given.
 */
export async function resolveSprint(
  c: JiraClient,
  hint: string | number,
  opts: { boardId?: number; projectKey?: string },
): Promise<Sprint> {
  if (typeof hint === "number" || /^\d+$/.test(String(hint))) return getSprint(c, Number(hint));
  const h = String(hint).trim().toLowerCase();
  let boardIds: number[] = [];
  if (opts.boardId) boardIds = [opts.boardId];
  else if (opts.projectKey) boardIds = (await listBoards(c, { projectKey: opts.projectKey, type: "scrum" })).map((b) => b.id);
  if (!boardIds.length) throw new Error("Pass boardId or projectKey so the sprint can be looked up.");

  const all: Sprint[] = [];
  for (const id of boardIds) all.push(...(await listSprints(c, id, "active,future")));
  if (h === "active" || h === "current") {
    const s = all.find((x) => x.state === "active");
    if (!s) throw new Error("No active sprint found.");
    return s;
  }
  if (h === "next" || h === "future") {
    const s = all.filter((x) => x.state === "future").sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""))[0];
    if (!s) throw new Error("No future sprint found.");
    return s;
  }
  const byName = all.filter((x) => x.name.toLowerCase() === h);
  if (byName.length === 1) return byName[0]!;
  const partial = all.filter((x) => x.name.toLowerCase().includes(h));
  if (partial.length === 1) return partial[0]!;
  throw new Error(
    `Sprint "${hint}" not found or ambiguous. Open/future sprints: ${all.map((s) => `${s.name} [${s.id}, ${s.state}]`).join(", ") || "none"}`,
  );
}
