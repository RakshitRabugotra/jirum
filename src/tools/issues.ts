import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addComment,
  assignIssue,
  buildCreateFields,
  buildUpdateBody,
  countIssues,
  createIssue,
  deleteIssue,
  getComments,
  getIssue,
  getTransitions,
  linkIssues,
  searchIssues,
  SUMMARY_FIELDS,
  transitionIssue,
  updateIssue,
} from "../jira/issues.js";
import { resolveAccountId } from "../jira/users.js";
import { specialFields } from "../jira/projects.js";
import { comment, issueDetail, issueTable, summarize } from "../util/format.js";
import { assigneeArg, issueKeyArg, jiraTool, json, markdownArg, projectKeyArg, text } from "./helpers.js";

export const customFieldsArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Extra fields keyed by field name or id (e.g. {\"Story Points\": 5, \"customfield_10020\": 42}). Values are sent as-is, so use Jira's shape for the field type.");

export const createIssueShape = {
  projectKey: projectKeyArg,
  issueType: z.string().describe("Issue type name as it exists in the project, e.g. 'Task', 'Story', 'Bug', 'Feature', 'Epic'."),
  summary: z.string().min(1).describe("One-line title."),
  description: markdownArg("Description"),
  assignee: assigneeArg,
  priority: z.string().optional().describe("Priority name, e.g. 'High'."),
  labels: z.array(z.string()).optional(),
  components: z.array(z.string()).optional().describe("Component names."),
  fixVersions: z.array(z.string()).optional().describe("Fix version names."),
  dueDate: z.string().optional().describe("YYYY-MM-DD"),
  parentKey: z.string().optional().describe("Parent issue key: an Epic for stories/features/tasks, or a standard issue for sub-tasks."),
  storyPoints: z.number().optional(),
  customFields: customFieldsArg,
};

export function registerIssueTools(server: McpServer): void {
  jiraTool(
    server,
    "jira_search_issues",
    {
      title: "Search issues (JQL)",
      description:
        "Runs a JQL query and returns a compact list. Examples: 'project = THEOS AND statusCategory != Done ORDER BY updated DESC', 'assignee = currentUser() AND sprint in openSprints()', 'text ~ \"vite migration\"'. Use nextPageToken to continue.",
      readOnly: true,
    },
    {
      jql: z.string().min(1),
      maxResults: z.number().int().min(1).max(100).optional().describe("Default 25."),
      nextPageToken: z.string().optional(),
      fields: z.array(z.string()).optional().describe("Extra field ids to fetch beyond the standard summary set (returned under `extra`)."),
      format: z.enum(["table", "json"]).optional().describe("'table' (default) is compact text; 'json' gives structured rows."),
    },
    async (c, { jql, maxResults, nextPageToken, fields, format }) => {
      const r = await searchIssues(c, jql, { maxResults, nextPageToken, fields: [...SUMMARY_FIELDS, ...(fields ?? [])] });
      const rows = r.issues.map((i) => {
        const s = summarize(c, i);
        if (!fields?.length) return s;
        const extra: Record<string, unknown> = {};
        for (const f of fields) extra[f] = i.fields[f];
        return { ...s, extra };
      });
      const footer = r.isLast ? "" : `\n\n(more results: pass nextPageToken="${r.nextPageToken}")`;
      if (format === "json") return json({ issues: rows, nextPageToken: r.isLast ? undefined : r.nextPageToken, isLast: r.isLast });
      return text(`${rows.length} issue(s) for: ${jql}\n\n${issueTable(rows)}${footer}`);
    },
  );

  jiraTool(
    server,
    "jira_count_issues",
    { title: "Count issues (JQL)", description: "Approximate count of issues matching a JQL query, without fetching them.", readOnly: true },
    { jql: z.string().min(1) },
    async (c, { jql }) => text(String(await countIssues(c, jql))),
  );

  jiraTool(
    server,
    "jira_get_issue",
    { title: "Get issue", description: "Full details of one issue: fields, description (as Markdown), parent, sub-tasks, links, and optionally recent comments.", readOnly: true },
    {
      issueKey: issueKeyArg,
      includeComments: z.boolean().optional().describe("Include the latest comments (default false)."),
      fields: z.array(z.string()).optional().describe("Extra field ids to include (returned under `extra`)."),
    },
    async (c, { issueKey, includeComments, fields }) => {
      const special = await specialFields(c);
      const extraIds = [...(fields ?? []), ...(special.sprint ? [special.sprint] : []), ...(special.storyPoints ? [special.storyPoints] : [])];
      const i = await getIssue(c, issueKey, undefined, extraIds);
      const extra: Record<string, unknown> = {};
      for (const f of fields ?? []) extra[f] = i.fields[f];
      const sprintRaw = special.sprint ? (i.fields[special.sprint] as { name?: string; state?: string; id?: number }[] | null) : null;
      const sprint = Array.isArray(sprintRaw) ? sprintRaw.map((s) => `${s.name} (${s.state}, id ${s.id})`) : undefined;
      const storyPoints = special.storyPoints ? i.fields[special.storyPoints] : undefined;
      const detail = issueDetail(c, i, {
        sprint,
        storyPoints: storyPoints ?? undefined,
        extra: Object.keys(extra).length ? extra : undefined,
        comments: includeComments ? (await getComments(c, issueKey, 20)).map(comment) : undefined,
      });
      return json(detail);
    },
  );

  jiraTool(
    server,
    "jira_create_issue",
    {
      title: "Create issue",
      description:
        "Creates an issue of any type. For hierarchy use parentKey: stories/features/tasks under an Epic, or sub-tasks under a standard issue (jira_create_subtask picks the sub-task type for you). Description is Markdown. Returns the new key and URL.",
    },
    createIssueShape,
    async (c, args) => {
      const fields = await buildCreateFields(c, args);
      const r = await createIssue(c, fields);
      return json({ key: r.key, id: r.id, url: c.issueUrl(r.key) });
    },
  );

  jiraTool(
    server,
    "jira_update_issue",
    {
      title: "Update issue",
      description: "Updates fields on an issue. Only provided fields change. `labels` replaces the whole set; use addLabels/removeLabels for incremental changes. Set parentKey to move an issue under a different Epic, or null to detach.",
      idempotent: true,
    },
    {
      issueKey: issueKeyArg,
      summary: z.string().optional(),
      description: markdownArg("New description (replaces the existing one)"),
      assignee: assigneeArg,
      priority: z.string().optional(),
      labels: z.array(z.string()).optional().describe("Replaces all labels."),
      addLabels: z.array(z.string()).optional(),
      removeLabels: z.array(z.string()).optional(),
      components: z.array(z.string()).optional(),
      fixVersions: z.array(z.string()).optional(),
      dueDate: z.string().nullable().optional().describe("YYYY-MM-DD or null to clear."),
      parentKey: z.string().nullable().optional(),
      issueType: z.string().optional().describe("Change the issue type (same hierarchy level only)."),
      storyPoints: z.number().nullable().optional(),
      customFields: customFieldsArg,
    },
    async (c, { issueKey, ...rest }) => {
      const projectKey = issueKey.split("-")[0]!;
      const body = await buildUpdateBody(c, projectKey, rest);
      await updateIssue(c, issueKey, body);
      return text(`Updated ${issueKey} (${c.issueUrl(issueKey)}). Changed: ${[...Object.keys(body.fields), ...Object.keys(body.update)].join(", ")}`);
    },
  );

  jiraTool(
    server,
    "jira_assign_issue",
    { title: "Assign issue", description: "Assigns an issue to a user ('me', accountId, email or display name). Omit assignee or pass null/'unassigned' to unassign.", idempotent: true },
    { issueKey: issueKeyArg, assignee: assigneeArg },
    async (c, { issueKey, assignee }) => {
      const id = await resolveAccountId(c, assignee ?? null, issueKey.split("-")[0]);
      await assignIssue(c, issueKey, id ?? null);
      return text(id ? `Assigned ${issueKey} to ${assignee}.` : `Unassigned ${issueKey}.`);
    },
  );

  jiraTool(
    server,
    "jira_get_transitions",
    { title: "Get available transitions", description: "Workflow transitions currently available for an issue (name, target status, required fields). Use before jira_transition_issue if unsure of the names.", readOnly: true },
    { issueKey: issueKeyArg },
    async (c, { issueKey }) => {
      const ts = await getTransitions(c, issueKey);
      return json(
        ts.map((t) => ({
          id: t.id,
          name: t.name,
          to: t.to?.name,
          requiredFields: Object.entries(t.fields ?? {})
            .filter(([, f]) => f.required)
            .map(([id, f]) => `${f.name} (${id})`),
        })),
      );
    },
  );

  jiraTool(
    server,
    "jira_transition_issue",
    {
      title: "Transition issue (change status)",
      description: "Moves an issue through its workflow. `transition` can be the transition name, the target status name (e.g. 'In Progress', 'Done'), or the transition id. Optionally adds a comment or sets a resolution.",
    },
    {
      issueKey: issueKeyArg,
      transition: z.string().min(1),
      comment: markdownArg("Comment to add with the transition"),
      resolution: z.string().optional().describe("Resolution name when closing, e.g. 'Done', \"Won't Do\"."),
      fields: z.record(z.string(), z.unknown()).optional().describe("Fields required by the transition screen, keyed by field id."),
    },
    async (c, { issueKey, transition, comment: cm, resolution, fields }) => {
      const t = await transitionIssue(c, issueKey, transition, { comment: cm, resolution, fields });
      return text(`${issueKey}: ${t.name} -> ${t.to?.name ?? "?"}`);
    },
  );

  jiraTool(
    server,
    "jira_add_comment",
    { title: "Add comment", description: "Adds a comment (Markdown) to an issue as the connected user." },
    { issueKey: issueKeyArg, body: z.string().min(1).describe("Comment text in Markdown.") },
    async (c, { issueKey, body }) => {
      const cm = await addComment(c, issueKey, body);
      return text(`Comment ${cm.id} added to ${issueKey} (${c.issueUrl(issueKey)}).`);
    },
  );

  jiraTool(
    server,
    "jira_get_comments",
    { title: "Get comments", description: "Latest comments on an issue, newest first, as Markdown.", readOnly: true },
    { issueKey: issueKeyArg, maxResults: z.number().int().min(1).max(100).optional() },
    async (c, { issueKey, maxResults }) => json((await getComments(c, issueKey, maxResults ?? 20)).map(comment)),
  );

  jiraTool(
    server,
    "jira_link_issues",
    {
      title: "Link issues",
      description:
        "Creates a link between two issues. Read it as '<fromKey> <linkType> <toKey>', e.g. fromKey=THEOS-10, linkType='blocks', toKey=THEOS-12, or linkType='is blocked by', 'relates to', 'duplicates', 'is caused by'. Use jira_get_link_types for the site's phrases.",
    },
    { fromKey: issueKeyArg, linkType: z.string().min(1), toKey: issueKeyArg, comment: markdownArg("Optional comment added with the link") },
    async (c, { fromKey, linkType, toKey, comment: cm }) => {
      const r = await linkIssues(c, fromKey, linkType, toKey, cm);
      return text(`Linked: ${r.outward} ${r.type.outward} ${r.inward} (type "${r.type.name}").`);
    },
  );

  jiraTool(
    server,
    "jira_delete_issue",
    { title: "Delete issue", description: "Permanently deletes an issue. Irreversible; confirm with the user first.", destructive: true },
    { issueKey: issueKeyArg, deleteSubtasks: z.boolean().optional().describe("Also delete its sub-tasks (required if it has any).") },
    async (c, { issueKey, deleteSubtasks }) => {
      await deleteIssue(c, issueKey, deleteSubtasks ?? false);
      return text(`Deleted ${issueKey}.`);
    },
  );
}
