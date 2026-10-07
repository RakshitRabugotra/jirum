import type { JiraClient } from "./client.js";
import type { Comment, Issue, LinkType, Transition } from "./types.js";
import { markdownToAdf } from "../util/adf.js";
import { getLinkTypes, resolveFieldId, resolveIssueType, specialFields } from "./projects.js";
import { resolveAccountId } from "./users.js";

export const SUMMARY_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "reporter", "labels", "updated", "created", "duedate", "parent", "project", "resolution"];
export const DETAIL_FIELDS = [...SUMMARY_FIELDS, "description", "subtasks", "issuelinks", "components", "fixVersions"];

export interface SearchResult {
  issues: Issue[];
  nextPageToken?: string;
  isLast: boolean;
}

export async function searchIssues(c: JiraClient, jql: string, opts: { fields?: string[]; maxResults?: number; nextPageToken?: string } = {}): Promise<SearchResult> {
  const r = await c.api<{ issues: Issue[]; nextPageToken?: string; isLast?: boolean }>("/search/jql", {
    method: "POST",
    body: {
      jql,
      fields: opts.fields ?? SUMMARY_FIELDS,
      maxResults: Math.min(opts.maxResults ?? 25, 100),
      nextPageToken: opts.nextPageToken,
    },
  });
  return { issues: r.issues ?? [], nextPageToken: r.nextPageToken, isLast: r.isLast ?? !r.nextPageToken };
}

export async function countIssues(c: JiraClient, jql: string): Promise<number> {
  const r = await c.api<{ count: number }>("/search/approximate-count", { method: "POST", body: { jql } });
  return r.count;
}

export async function getIssue(c: JiraClient, key: string, fields: string[] = DETAIL_FIELDS, extra: string[] = []): Promise<Issue> {
  return c.api<Issue>(`/issue/${encodeURIComponent(key)}`, { query: { fields: [...fields, ...extra].join(",") } });
}

export interface IssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description?: string;
  assignee?: string | null;
  reporter?: string;
  priority?: string;
  labels?: string[];
  components?: string[];
  fixVersions?: string[];
  dueDate?: string;
  parentKey?: string;
  storyPoints?: number;
  customFields?: Record<string, unknown>;
}

/** Builds the `fields` object for create. Resolves names (issue type, users, custom fields) to ids. */
export async function buildCreateFields(c: JiraClient, input: IssueInput): Promise<Record<string, unknown>> {
  const type = await resolveIssueType(c, input.projectKey, input.issueType);
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    issuetype: { id: type.id },
    summary: input.summary,
  };
  if (input.description !== undefined) fields.description = markdownToAdf(input.description);
  if (input.parentKey) fields.parent = { key: input.parentKey };
  await applyCommonFields(c, fields, input, input.projectKey);
  return fields;
}

export interface UpdateInput {
  summary?: string;
  description?: string;
  assignee?: string | null;
  reporter?: string;
  priority?: string;
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  components?: string[];
  fixVersions?: string[];
  dueDate?: string | null;
  parentKey?: string | null;
  issueType?: string;
  storyPoints?: number | null;
  customFields?: Record<string, unknown>;
}

export async function buildUpdateBody(c: JiraClient, projectKey: string, input: UpdateInput): Promise<{ fields: Record<string, unknown>; update: Record<string, unknown> }> {
  const fields: Record<string, unknown> = {};
  const update: Record<string, unknown> = {};
  if (input.summary !== undefined) fields.summary = input.summary;
  if (input.description !== undefined) fields.description = markdownToAdf(input.description);
  if (input.parentKey !== undefined) fields.parent = input.parentKey === null ? null : { key: input.parentKey };
  if (input.issueType !== undefined) fields.issuetype = { id: (await resolveIssueType(c, projectKey, input.issueType)).id };
  if (input.addLabels?.length || input.removeLabels?.length) {
    update.labels = [...(input.addLabels ?? []).map((l) => ({ add: l })), ...(input.removeLabels ?? []).map((l) => ({ remove: l }))];
  }
  await applyCommonFields(c, fields, input, projectKey);
  return { fields, update };
}

interface CommonFieldInput {
  assignee?: string | null;
  reporter?: string;
  priority?: string;
  labels?: string[];
  components?: string[];
  fixVersions?: string[];
  dueDate?: string | null;
  storyPoints?: number | null;
  customFields?: Record<string, unknown>;
}

async function applyCommonFields(c: JiraClient, fields: Record<string, unknown>, input: CommonFieldInput, projectKey: string): Promise<void> {
  if (input.assignee !== undefined) {
    const id = await resolveAccountId(c, input.assignee, projectKey);
    if (id !== undefined) fields.assignee = id === null ? null : { accountId: id };
  }
  if (input.reporter !== undefined) {
    const id = await resolveAccountId(c, input.reporter);
    if (id) fields.reporter = { accountId: id };
  }
  if (input.priority !== undefined) fields.priority = { name: input.priority };
  if (input.labels !== undefined) fields.labels = input.labels.map((l) => l.replace(/\s+/g, "-"));
  if (input.components !== undefined) fields.components = input.components.map((n) => ({ name: n }));
  if (input.fixVersions !== undefined) fields.fixVersions = input.fixVersions.map((n) => ({ name: n }));
  if (input.dueDate !== undefined) fields.duedate = input.dueDate;
  if (input.storyPoints !== undefined) {
    const sp = (await specialFields(c)).storyPoints;
    if (!sp) throw new Error("This site has no Story Points field. Use customFields with the field id instead.");
    fields[sp] = input.storyPoints;
  }
  for (const [k, v] of Object.entries(input.customFields ?? {})) {
    fields[await resolveFieldId(c, k)] = v;
  }
}

export async function createIssue(c: JiraClient, fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
  return c.api<{ id: string; key: string }>("/issue", { method: "POST", body: { fields } });
}

export async function updateIssue(c: JiraClient, key: string, body: { fields?: Record<string, unknown>; update?: Record<string, unknown> }): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (body.fields && Object.keys(body.fields).length) payload.fields = body.fields;
  if (body.update && Object.keys(body.update).length) payload.update = body.update;
  if (!Object.keys(payload).length) throw new Error("Nothing to update: provide at least one field.");
  await c.api(`/issue/${encodeURIComponent(key)}`, { method: "PUT", body: payload, expectEmpty: true });
}

export async function deleteIssue(c: JiraClient, key: string, deleteSubtasks = false): Promise<void> {
  await c.api(`/issue/${encodeURIComponent(key)}`, { method: "DELETE", query: { deleteSubtasks }, expectEmpty: true });
}

export async function assignIssue(c: JiraClient, key: string, accountId: string | null): Promise<void> {
  await c.api(`/issue/${encodeURIComponent(key)}/assignee`, { method: "PUT", body: { accountId }, expectEmpty: true });
}

export async function getTransitions(c: JiraClient, key: string): Promise<Transition[]> {
  const r = await c.api<{ transitions: Transition[] }>(`/issue/${encodeURIComponent(key)}/transitions`, { query: { expand: "transitions.fields" } });
  return r.transitions;
}

export async function transitionIssue(
  c: JiraClient,
  key: string,
  transitionHint: string,
  opts: { comment?: string; resolution?: string; fields?: Record<string, unknown> } = {},
): Promise<Transition> {
  const transitions = await getTransitions(c, key);
  const h = transitionHint.trim().toLowerCase();
  const t =
    transitions.find((x) => x.id === transitionHint) ??
    transitions.find((x) => x.name.toLowerCase() === h) ??
    transitions.find((x) => x.to?.name.toLowerCase() === h) ??
    transitions.find((x) => x.name.toLowerCase().includes(h) || x.to?.name.toLowerCase().includes(h));
  if (!t) {
    throw new Error(`No transition "${transitionHint}" for ${key}. Available: ${transitions.map((x) => `${x.name} -> ${x.to?.name ?? "?"} [${x.id}]`).join(", ")}`);
  }
  const body: Record<string, unknown> = { transition: { id: t.id } };
  const fields: Record<string, unknown> = { ...(opts.fields ?? {}) };
  if (opts.resolution) fields.resolution = { name: opts.resolution };
  if (Object.keys(fields).length) body.fields = fields;
  if (opts.comment) body.update = { comment: [{ add: { body: markdownToAdf(opts.comment) } }] };
  await c.api(`/issue/${encodeURIComponent(key)}/transitions`, { method: "POST", body, expectEmpty: true });
  return t;
}

export async function addComment(c: JiraClient, key: string, markdown: string): Promise<Comment> {
  return c.api<Comment>(`/issue/${encodeURIComponent(key)}/comment`, { method: "POST", body: { body: markdownToAdf(markdown) } });
}

export async function getComments(c: JiraClient, key: string, maxResults = 20): Promise<Comment[]> {
  const r = await c.api<{ comments: Comment[] }>(`/issue/${encodeURIComponent(key)}/comment`, { query: { orderBy: "-created", maxResults } });
  return r.comments;
}

/**
 * Links two issues. `linkType` may be the type name ("Blocks"), or a direction
 * phrase ("blocks", "is blocked by", "relates to", "duplicates"). The phrase
 * decides which issue is inward/outward so "A blocks B" reads correctly in Jira.
 */
export async function linkIssues(c: JiraClient, fromKey: string, linkType: string, toKey: string, comment?: string): Promise<{ type: LinkType; inward: string; outward: string }> {
  const types = await getLinkTypes(c);
  const h = linkType.trim().toLowerCase();
  let type: LinkType | undefined;
  let fromIsOutward = true;
  for (const t of types) {
    if (t.name.toLowerCase() === h || t.outward.toLowerCase() === h) {
      type = t;
      fromIsOutward = true;
      break;
    }
    if (t.inward.toLowerCase() === h) {
      type = t;
      fromIsOutward = false;
      break;
    }
  }
  if (!type) {
    const partial = types.find((t) => t.name.toLowerCase().includes(h) || t.outward.toLowerCase().includes(h) || t.inward.toLowerCase().includes(h));
    if (partial) {
      type = partial;
      // Prefer the outward reading unless only the inward phrase matched.
      fromIsOutward = partial.outward.toLowerCase().includes(h) || partial.name.toLowerCase().includes(h) || !partial.inward.toLowerCase().includes(h);
    }
  }
  if (!type) {
    throw new Error(`Unknown link type "${linkType}". Available: ${types.map((t) => `${t.name} ("${t.outward}" / "${t.inward}")`).join(", ")}`);
  }
  const outward = fromIsOutward ? fromKey : toKey;
  const inward = fromIsOutward ? toKey : fromKey;
  const body: Record<string, unknown> = { type: { name: type.name }, outwardIssue: { key: outward }, inwardIssue: { key: inward } };
  if (comment) body.comment = { body: markdownToAdf(comment) };
  await c.api("/issueLink", { method: "POST", body, expectEmpty: true });
  return { type, inward, outward };
}

/** Escapes a string for use inside a double-quoted JQL literal. */
export function jqlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
