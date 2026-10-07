import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllFields, getCreateFields, getIssueTypes, getLinkTypes, getPriorities, getProject, resolveIssueType, searchProjects, specialFields } from "../jira/projects.js";
import { myself, searchAssignable, searchUsers } from "../jira/users.js";
import { user } from "../util/format.js";
import { jiraTool, json, projectKeyArg } from "./helpers.js";

export function registerMetaTools(server: McpServer): void {
  jiraTool(
    server,
    "jira_myself",
    { title: "Who am I in Jira", description: "Returns the Atlassian account the integration acts as (accountId, name, email).", readOnly: true },
    {},
    async (c) => {
      const me = await myself(c);
      return json({ accountId: me.accountId, displayName: me.displayName, email: me.emailAddress, site: c.site.url });
    },
  );

  jiraTool(
    server,
    "jira_list_projects",
    { title: "List projects", description: "Lists Jira projects on the site, optionally filtered by a name/key substring.", readOnly: true },
    { query: z.string().optional().describe("Filter by key or name substring."), maxResults: z.number().int().min(1).max(100).optional() },
    async (c, { query, maxResults }) => {
      const ps = await searchProjects(c, query, maxResults ?? 50);
      return json(ps.map((p) => ({ key: p.key, name: p.name, type: p.projectTypeKey, style: p.style, lead: p.lead ? user(p.lead) : undefined })));
    },
  );

  jiraTool(
    server,
    "jira_get_project",
    { title: "Get project", description: "Project details including its issue types (with hierarchy level and whether each is a sub-task type). Call before creating issues in an unfamiliar project.", readOnly: true },
    { projectKey: projectKeyArg },
    async (c, { projectKey }) => {
      const p = await getProject(c, projectKey);
      return json({
        key: p.key,
        name: p.name,
        id: p.id,
        type: p.projectTypeKey,
        style: p.style === "next-gen" ? "team-managed" : "company-managed",
        lead: p.lead ? user(p.lead) : undefined,
        issueTypes: (p.issueTypes ?? []).map((t) => ({ id: t.id, name: t.name, subtask: t.subtask, hierarchyLevel: t.hierarchyLevel })),
        url: `${c.site.url}/browse/${p.key}`,
      });
    },
  );

  jiraTool(
    server,
    "jira_get_issue_types",
    { title: "Get issue types", description: "Issue types available in a project (Epic, Feature, Story, Task, Bug, Sub-task...). hierarchyLevel: 1 = epic level, 0 = standard, -1 = sub-task.", readOnly: true },
    { projectKey: projectKeyArg },
    async (c, { projectKey }) => json(await getIssueTypes(c, projectKey)),
  );

  jiraTool(
    server,
    "jira_get_create_fields",
    {
      title: "Get fields for creating an issue",
      description: "Lists the fields (required and optional, with allowed values) for creating an issue of a given type in a project. Use when a create fails because of a missing required field, or to find custom field ids.",
      readOnly: true,
    },
    { projectKey: projectKeyArg, issueType: z.string().describe("Issue type name or id."), requiredOnly: z.boolean().optional() },
    async (c, { projectKey, issueType, requiredOnly }) => {
      const t = await resolveIssueType(c, projectKey, issueType);
      const fields = await getCreateFields(c, projectKey, t.id);
      return json(
        fields
          .filter((f) => !requiredOnly || f.required)
          .map((f) => ({
            id: f.fieldId,
            name: f.name,
            required: f.required,
            type: f.schema?.type,
            items: f.schema?.items,
            allowedValues: f.allowedValues?.slice(0, 30).map((v) => v.name ?? v.value ?? v.key ?? v.id),
          })),
      );
    },
  );

  jiraTool(
    server,
    "jira_get_fields",
    { title: "List fields", description: "All fields on the site (system and custom) with ids, plus the detected Sprint / Story Points field ids. Filter with `query`.", readOnly: true },
    { query: z.string().optional().describe("Case-insensitive substring of the field name.") },
    async (c, { query }) => {
      const all = await getAllFields(c);
      const q = query?.toLowerCase();
      const special = await specialFields(c);
      return json({
        special,
        fields: all
          .filter((f) => !q || f.name.toLowerCase().includes(q) || f.id.includes(q))
          .map((f) => ({ id: f.id, name: f.name, custom: f.custom, type: f.schema?.type, items: f.schema?.items })),
      });
    },
  );

  jiraTool(
    server,
    "jira_get_link_types",
    { title: "List issue link types", description: "Issue link types (e.g. Blocks: 'blocks' / 'is blocked by'). Use the phrases with jira_link_issues.", readOnly: true },
    {},
    async (c) => json(await getLinkTypes(c)),
  );

  jiraTool(
    server,
    "jira_get_priorities",
    { title: "List priorities", description: "Priority names available on the site.", readOnly: true },
    {},
    async (c) => json((await getPriorities(c)).map((p) => p.name)),
  );

  jiraTool(
    server,
    "jira_search_users",
    { title: "Search users", description: "Finds Jira users by name or email. Pass projectKey to restrict to users assignable in that project. Returns accountIds for use as assignee.", readOnly: true },
    { query: z.string().min(1), projectKey: z.string().optional(), maxResults: z.number().int().min(1).max(50).optional() },
    async (c, { query, projectKey, maxResults }) => {
      const users = projectKey ? await searchAssignable(c, projectKey, query, maxResults ?? 20) : await searchUsers(c, query, maxResults ?? 20);
      return json(users.map((u) => ({ accountId: u.accountId, displayName: u.displayName, email: u.emailAddress, active: u.active })));
    },
  );
}
