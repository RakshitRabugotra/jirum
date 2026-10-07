import type { JiraClient } from "./client.js";
import type { FieldDef, IssueType, LinkType, Project } from "./types.js";

export async function getProject(c: JiraClient, keyOrId: string): Promise<Project> {
  return c.api<Project>(`/project/${encodeURIComponent(keyOrId)}`, { query: { expand: "issueTypes,lead" } });
}

export async function searchProjects(c: JiraClient, query?: string, maxResults = 50): Promise<Project[]> {
  const page = await c.api<{ values: Project[] }>("/project/search", {
    query: { query, maxResults, orderBy: "name", expand: "lead" },
  });
  return page.values;
}

export async function getIssueTypes(c: JiraClient, projectKey: string): Promise<IssueType[]> {
  const p = await getProject(c, projectKey);
  return (p.issueTypes ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    subtask: t.subtask,
    hierarchyLevel: t.hierarchyLevel,
    description: t.description,
  }));
}

/** Case-insensitive issue type lookup with helpful aliases ("subtask" ~ "Sub-task"). */
export async function resolveIssueType(c: JiraClient, projectKey: string, name: string): Promise<IssueType> {
  const types = await getIssueTypes(c, projectKey);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(name);
  const found =
    types.find((t) => t.id === name) ??
    types.find((t) => norm(t.name) === want) ??
    (want === "subtask" ? types.find((t) => t.subtask) : undefined) ??
    (want === "epic" ? types.find((t) => t.hierarchyLevel === 1) : undefined);
  if (!found) {
    throw new Error(`Issue type "${name}" does not exist in project ${projectKey}. Available: ${types.map((t) => t.name).join(", ")}`);
  }
  return found;
}

export async function subtaskType(c: JiraClient, projectKey: string): Promise<IssueType> {
  const types = await getIssueTypes(c, projectKey);
  const t = types.find((x) => x.subtask);
  if (!t) throw new Error(`Project ${projectKey} has no sub-task issue type.`);
  return t;
}

export async function epicType(c: JiraClient, projectKey: string): Promise<IssueType> {
  const types = await getIssueTypes(c, projectKey);
  const t = types.find((x) => x.hierarchyLevel === 1) ?? types.find((x) => x.name.toLowerCase() === "epic");
  if (!t) throw new Error(`Project ${projectKey} has no Epic-level issue type. Available: ${types.map((x) => x.name).join(", ")}`);
  return t;
}

export interface CreateFieldMeta {
  fieldId: string;
  name: string;
  required: boolean;
  schema?: FieldDef["schema"];
  allowedValues?: { id?: string; name?: string; value?: string; key?: string }[];
  hasDefaultValue?: boolean;
}

export async function getCreateFields(c: JiraClient, projectKey: string, issueTypeId: string): Promise<CreateFieldMeta[]> {
  const page = await c.api<{ fields: CreateFieldMeta[] }>(
    `/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`,
    { query: { maxResults: 200 } },
  );
  return page.fields ?? [];
}

const fieldCache = new Map<string, Promise<FieldDef[]>>();

export function getAllFields(c: JiraClient): Promise<FieldDef[]> {
  let p = fieldCache.get(c.site.id);
  if (!p) {
    p = c.api<FieldDef[]>("/field");
    fieldCache.set(c.site.id, p);
    p.catch(() => fieldCache.delete(c.site.id));
  }
  return p;
}

/** Finds a field id by id, exact name, or case-insensitive name. */
export async function resolveFieldId(c: JiraClient, nameOrId: string): Promise<string> {
  if (/^customfield_\d+$/.test(nameOrId)) return nameOrId;
  const fields = await getAllFields(c);
  const exact = fields.find((f) => f.id === nameOrId) ?? fields.find((f) => f.name === nameOrId);
  if (exact) return exact.id;
  const lower = nameOrId.toLowerCase();
  const ci = fields.filter((f) => f.name.toLowerCase() === lower);
  if (ci.length === 1) return ci[0]!.id;
  if (ci.length > 1) throw new Error(`Field name "${nameOrId}" is ambiguous: ${ci.map((f) => `${f.name} (${f.id})`).join(", ")}. Use the id.`);
  throw new Error(`Unknown field "${nameOrId}". Use jira_get_fields to list field names and ids.`);
}

/** Well-known Jira Software custom fields, resolved by schema so names in other languages still work. */
export async function specialFields(c: JiraClient): Promise<{ sprint?: string; storyPoints?: string; epicLink?: string; epicName?: string }> {
  const fields = await getAllFields(c);
  const byCustom = (custom: string) => fields.find((f) => f.schema?.custom === custom)?.id;
  const storyPoints =
    fields.find((f) => f.name.toLowerCase() === "story points")?.id ??
    fields.find((f) => f.name.toLowerCase() === "story point estimate")?.id ??
    fields.find((f) => /story ?points?/i.test(f.name))?.id;
  return {
    sprint: byCustom("com.pyxis.greenhopper.jira:gh-sprint"),
    storyPoints,
    epicLink: byCustom("com.pyxis.greenhopper.jira:gh-epic-link"),
    epicName: byCustom("com.pyxis.greenhopper.jira:gh-epic-label"),
  };
}

export async function getLinkTypes(c: JiraClient): Promise<LinkType[]> {
  const r = await c.api<{ issueLinkTypes: LinkType[] }>("/issueLinkType");
  return r.issueLinkTypes;
}

export async function getPriorities(c: JiraClient): Promise<{ id: string; name: string }[]> {
  return c.api<{ id: string; name: string }[]>("/priority");
}
