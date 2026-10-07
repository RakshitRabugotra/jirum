import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCreateFields, createIssue, getIssue, searchIssues, SUMMARY_FIELDS } from "../jira/issues.js";
import { epicType, getIssueTypes, resolveIssueType, subtaskType } from "../jira/projects.js";
import { issueTable, summarize } from "../util/format.js";
import { assigneeArg, issueKeyArg, jiraTool, json, markdownArg, projectKeyArg, text } from "./helpers.js";
import { customFieldsArg } from "./issues.js";

const commonShape = {
  description: markdownArg("Description"),
  assignee: assigneeArg,
  priority: z.string().optional(),
  labels: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  dueDate: z.string().optional().describe("YYYY-MM-DD"),
  storyPoints: z.number().optional(),
  customFields: customFieldsArg,
};

export function registerHierarchyTools(server: McpServer): void {
  jiraTool(
    server,
    "jira_create_epic",
    { title: "Create epic", description: "Creates an Epic (the project's epic-level issue type is detected automatically). Then use jira_create_child_issue to add features/stories under it." },
    { projectKey: projectKeyArg, summary: z.string().min(1), ...commonShape },
    async (c, { projectKey, summary, ...rest }) => {
      const t = await epicType(c, projectKey);
      const fields = await buildCreateFields(c, { projectKey, issueType: t.id, summary, ...rest });
      const r = await createIssue(c, fields);
      return json({ key: r.key, type: t.name, url: c.issueUrl(r.key) });
    },
  );

  jiraTool(
    server,
    "jira_create_child_issue",
    {
      title: "Create issue under an epic",
      description:
        "Creates a Feature, Story, Task or Bug under a parent Epic (parentKey). The project is taken from the parent. Use issueType='Feature' where the project has that type; call jira_get_issue_types if unsure.",
    },
    {
      parentKey: z.string().min(1).describe("Epic key, e.g. 'THEOS-100'."),
      issueType: z.string().describe("'Story', 'Feature', 'Task', 'Bug', or any standard-level type in the project."),
      summary: z.string().min(1),
      ...commonShape,
    },
    async (c, { parentKey, issueType, summary, ...rest }) => {
      const projectKey = parentKey.split("-")[0]!;
      const t = await resolveIssueType(c, projectKey, issueType);
      if (t.subtask) throw new Error(`${t.name} is a sub-task type; use jira_create_subtask instead.`);
      const fields = await buildCreateFields(c, { projectKey, issueType: t.id, summary, parentKey, ...rest });
      const r = await createIssue(c, fields);
      return json({ key: r.key, type: t.name, parent: parentKey, url: c.issueUrl(r.key) });
    },
  );

  jiraTool(
    server,
    "jira_create_subtask",
    { title: "Create sub-task", description: "Creates a sub-task under a standard issue (Feature, Story, Task, Bug). The sub-task issue type is detected automatically." },
    { parentKey: z.string().min(1).describe("Parent issue key (a standard-level issue, not an Epic)."), summary: z.string().min(1), ...commonShape },
    async (c, { parentKey, summary, ...rest }) => {
      const projectKey = parentKey.split("-")[0]!;
      const t = await subtaskType(c, projectKey);
      const fields = await buildCreateFields(c, { projectKey, issueType: t.id, summary, parentKey, ...rest });
      const r = await createIssue(c, fields);
      return json({ key: r.key, type: t.name, parent: parentKey, url: c.issueUrl(r.key) });
    },
  );

  jiraTool(
    server,
    "jira_create_epic_with_children",
    {
      title: "Create epic with child issues",
      description:
        "Creates an Epic and a batch of child issues (features/stories/tasks) under it, optionally with sub-tasks under each child, in one call. Fails fast on the first error and reports what was created.",
    },
    {
      projectKey: projectKeyArg,
      epic: z.object({ summary: z.string().min(1), description: z.string().optional(), labels: z.array(z.string()).optional(), priority: z.string().optional(), assignee: z.string().optional() }),
      children: z
        .array(
          z.object({
            issueType: z.string().describe("'Feature', 'Story', 'Task', 'Bug'..."),
            summary: z.string().min(1),
            description: z.string().optional(),
            assignee: z.string().optional(),
            priority: z.string().optional(),
            labels: z.array(z.string()).optional(),
            storyPoints: z.number().optional(),
            subtasks: z.array(z.object({ summary: z.string().min(1), description: z.string().optional(), assignee: z.string().optional() })).optional(),
          }),
        )
        .min(1),
    },
    async (c, { projectKey, epic, children }) => {
      const created: { key: string; type: string; parent?: string }[] = [];
      try {
        const et = await epicType(c, projectKey);
        const epicRes = await createIssue(c, await buildCreateFields(c, { projectKey, issueType: et.id, ...epic }));
        created.push({ key: epicRes.key, type: et.name });
        const st = children.some((ch) => ch.subtasks?.length) ? await subtaskType(c, projectKey) : undefined;
        for (const ch of children) {
          const { subtasks, ...childInput } = ch;
          const childRes = await createIssue(c, await buildCreateFields(c, { projectKey, parentKey: epicRes.key, ...childInput }));
          created.push({ key: childRes.key, type: ch.issueType, parent: epicRes.key });
          for (const s of subtasks ?? []) {
            const sRes = await createIssue(c, await buildCreateFields(c, { projectKey, issueType: st!.id, parentKey: childRes.key, ...s }));
            created.push({ key: sRes.key, type: st!.name, parent: childRes.key });
          }
        }
        return json({ epic: { key: epicRes.key, url: c.issueUrl(epicRes.key) }, created });
      } catch (err) {
        return {
          content: [{ type: "text", text: `Stopped after creating ${created.length} issue(s): ${created.map((x) => x.key).join(", ") || "none"}.\nError: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  jiraTool(
    server,
    "jira_get_children",
    { title: "Get child issues", description: "Lists the direct children of an Epic (its features/stories/tasks) or the sub-tasks of a standard issue, with status and assignee.", readOnly: true },
    { issueKey: issueKeyArg, includeDone: z.boolean().optional().describe("Include resolved/done children (default true).") },
    async (c, { issueKey, includeDone }) => {
      const parent = await getIssue(c, issueKey, SUMMARY_FIELDS);
      const jql = `parent = ${issueKey}${includeDone === false ? " AND statusCategory != Done" : ""} ORDER BY created ASC`;
      const r = await searchIssues(c, jql, { maxResults: 100 });
      const rows = r.issues.map((i) => summarize(c, i));
      const types = await getIssueTypes(c, issueKey.split("-")[0]!);
      const pt = types.find((t) => t.name === parent.fields.issuetype?.name);
      const header = `${issueKey} [${parent.fields.issuetype?.name}${pt?.hierarchyLevel === 1 ? ", epic level" : ""}] ${parent.fields.summary} — ${rows.length} child issue(s)`;
      return text(`${header}\n\n${issueTable(rows)}`);
    },
  );
}
