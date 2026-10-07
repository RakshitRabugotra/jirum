import type { JiraClient } from "../jira/client.js";
import type { Comment, Issue, JiraUser } from "../jira/types.js";
import { adfToMarkdown } from "./adf.js";

export function user(u: JiraUser | null | undefined): string {
  if (!u) return "Unassigned";
  return u.emailAddress ? `${u.displayName} <${u.emailAddress}>` : u.displayName;
}

export interface IssueSummary {
  key: string;
  summary: string;
  type: string;
  status: string;
  statusCategory?: string;
  priority?: string;
  assignee: string;
  reporter?: string;
  labels?: string[];
  parent?: string;
  project?: string;
  dueDate?: string | null;
  updated?: string;
  created?: string;
  resolution?: string;
  url: string;
}

export function summarize(c: JiraClient, i: Issue): IssueSummary {
  const f = i.fields;
  return {
    key: i.key,
    summary: f.summary ?? "",
    type: f.issuetype?.name ?? "",
    status: f.status?.name ?? "",
    statusCategory: f.status?.statusCategory?.key,
    priority: f.priority?.name,
    assignee: user(f.assignee),
    reporter: f.reporter ? user(f.reporter) : undefined,
    labels: f.labels?.length ? f.labels : undefined,
    parent: f.parent ? `${f.parent.key} ${(f.parent.fields?.summary as string | undefined) ?? ""}`.trim() : undefined,
    project: f.project?.key,
    dueDate: f.duedate ?? undefined,
    updated: f.updated,
    created: f.created,
    resolution: f.resolution?.name,
    url: c.issueUrl(i.key),
  };
}

export function issueDetail(c: JiraClient, i: Issue, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const f = i.fields;
  const base = summarize(c, i);
  const links = (f.issuelinks ?? []).map((l) => {
    if (l.outwardIssue) return { relation: l.type.outward, key: l.outwardIssue.key, summary: l.outwardIssue.fields?.summary, status: (l.outwardIssue.fields?.status as { name?: string } | undefined)?.name };
    if (l.inwardIssue) return { relation: l.type.inward, key: l.inwardIssue.key, summary: l.inwardIssue.fields?.summary, status: (l.inwardIssue.fields?.status as { name?: string } | undefined)?.name };
    return { relation: l.type.name };
  });
  return {
    ...base,
    components: f.components?.map((x) => x.name),
    fixVersions: f.fixVersions?.map((x) => x.name),
    subtasks: f.subtasks?.map((s) => ({ key: s.key, summary: s.fields?.summary, status: (s.fields?.status as { name?: string } | undefined)?.name })),
    links: links.length ? links : undefined,
    description: adfToMarkdown(f.description as never) || undefined,
    ...extra,
  };
}

export function comment(cm: Comment): Record<string, unknown> {
  return { id: cm.id, author: user(cm.author), created: cm.created, body: adfToMarkdown(cm.body as never) };
}

/** Compact one-line-per-issue table for lists; cheaper for Claude to read than JSON. */
export function issueTable(rows: IssueSummary[]): string {
  if (!rows.length) return "(no issues)";
  return rows
    .map((r) => {
      const bits = [r.key, `[${r.type}]`, `(${r.status})`, r.summary, `— ${r.assignee}`];
      if (r.priority) bits.push(`· ${r.priority}`);
      if (r.parent) bits.push(`· parent ${r.parent.split(" ")[0]}`);
      if (r.labels?.length) bits.push(`· #${r.labels.join(" #")}`);
      return bits.join(" ");
    })
    .join("\n");
}
