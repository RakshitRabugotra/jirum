import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildCreateFields, createIssue, jqlString, searchIssues } from "../jira/issues.js";
import { issueTable, summarize } from "../util/format.js";
import { assigneeArg, jiraTool, json, projectKeyArg, text } from "./helpers.js";
import { customFieldsArg } from "./issues.js";

export function registerSmartTools(server: McpServer): void {
  jiraTool(
    server,
    "jira_search_my_tickets",
    {
      title: "My tickets",
      description: "Issues assigned to the connected user, newest activity first. Defaults to open issues only. Filter by project, status category, or recent updates.",
      readOnly: true,
    },
    {
      projectKey: z.string().optional(),
      status: z.enum(["open", "in-progress", "todo", "done", "all"]).optional().describe("'open' (default) = not done; 'in-progress' / 'todo' / 'done' map to status categories."),
      updatedWithin: z.string().optional().describe("JQL duration such as '7d', '2w', '24h'. Only issues updated in this window."),
      reportedByMe: z.boolean().optional().describe("Use reporter = currentUser() instead of assignee."),
      maxResults: z.number().int().min(1).max(100).optional(),
    },
    async (c, { projectKey, status, updatedWithin, reportedByMe, maxResults }) => {
      const clauses = [reportedByMe ? "reporter = currentUser()" : "assignee = currentUser()"];
      if (projectKey) clauses.push(`project = ${jqlString(projectKey)}`);
      const s = status ?? "open";
      if (s === "open") clauses.push("statusCategory != Done");
      else if (s === "in-progress") clauses.push('statusCategory = "In Progress"');
      else if (s === "todo") clauses.push('statusCategory = "To Do"');
      else if (s === "done") clauses.push("statusCategory = Done");
      if (updatedWithin) clauses.push(`updated >= -${updatedWithin.replace(/^-/, "")}`);
      const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;
      const r = await searchIssues(c, jql, { maxResults: maxResults ?? 30 });
      const rows = r.issues.map((i) => summarize(c, i));
      return text(`${rows.length} issue(s) — ${jql}\n\n${issueTable(rows)}${r.isLast ? "" : "\n\n(more available; use jira_search_issues with this JQL and nextPageToken)"}`);
    },
  );

  jiraTool(
    server,
    "jira_find_duplicate_ticket",
    {
      title: "Find possible duplicate tickets",
      description:
        "Before creating a ticket, searches a project for existing issues matching a summary/keywords (text search on summary, description and comments). Returns likely duplicates so the user can decide whether to create a new one.",
      readOnly: true,
    },
    {
      projectKey: projectKeyArg,
      query: z.string().min(2).describe("Proposed summary or a few keywords."),
      includeDone: z.boolean().optional().describe("Also search resolved issues (default false)."),
      issueType: z.string().optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
    },
    async (c, { projectKey, query, includeDone, issueType, maxResults }) => {
      const words = query
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const clauses = [`project = ${jqlString(projectKey)}`];
      if (!includeDone) clauses.push("statusCategory != Done");
      if (issueType) clauses.push(`issuetype = ${jqlString(issueType)}`);
      // Phrase match first, then an OR of significant words as a fallback in one query.
      const textClause = words.length ? `(text ~ ${jqlString(query)} OR summary ~ ${jqlString(words.join(" "))})` : `text ~ ${jqlString(query)}`;
      clauses.push(textClause);
      const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;
      const r = await searchIssues(c, jql, { maxResults: maxResults ?? 10 });
      const rows = r.issues.map((i) => summarize(c, i));
      if (!rows.length) return text(`No likely duplicates in ${projectKey} for: "${query}"`);
      return text(`${rows.length} possible duplicate(s) in ${projectKey} for "${query}":\n\n${issueTable(rows)}\n\nAsk the user before creating a new ticket if one of these matches.`);
    },
  );

  jiraTool(
    server,
    "jira_create_ticket_from_context",
    {
      title: "Create ticket from structured context",
      description:
        "Creates a well-structured ticket from what was discussed: problem statement, context, reproduction steps, expected/actual behaviour, acceptance criteria, technical notes and links. Builds a consistently formatted description. Use jira_find_duplicate_ticket first when appropriate.",
    },
    {
      projectKey: projectKeyArg,
      issueType: z.string().describe("'Bug', 'Story', 'Task', 'Feature'..."),
      summary: z.string().min(1).describe("Concise, specific title (what and where)."),
      problem: z.string().min(1).describe("What is wrong or what is needed, 1-3 sentences (Markdown ok)."),
      context: z.string().optional().describe("Background: where it was found, who is affected, why it matters."),
      stepsToReproduce: z.array(z.string()).optional(),
      expectedBehavior: z.string().optional(),
      actualBehavior: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).optional().describe("Each item becomes a checklist line."),
      technicalNotes: z.string().optional().describe("Implementation hints, suspected cause, affected files/services (Markdown ok)."),
      links: z.array(z.object({ title: z.string(), url: z.string() })).optional().describe("PRs, docs, logs, Slack threads."),
      relatedIssues: z.array(z.string()).optional().describe("Issue keys to mention in the description."),
      parentKey: z.string().optional().describe("Epic (for stories/features) or parent issue."),
      assignee: assigneeArg,
      priority: z.string().optional(),
      labels: z.array(z.string()).optional(),
      components: z.array(z.string()).optional(),
      dueDate: z.string().optional(),
      storyPoints: z.number().optional(),
      customFields: customFieldsArg,
    },
    async (c, args) => {
      const md: string[] = [];
      md.push(`## Problem\n\n${args.problem.trim()}`);
      if (args.context) md.push(`## Context\n\n${args.context.trim()}`);
      if (args.stepsToReproduce?.length) md.push(`## Steps to reproduce\n\n${args.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
      if (args.expectedBehavior || args.actualBehavior) {
        const parts: string[] = [];
        if (args.expectedBehavior) parts.push(`**Expected:** ${args.expectedBehavior.trim()}`);
        if (args.actualBehavior) parts.push(`**Actual:** ${args.actualBehavior.trim()}`);
        md.push(`## Expected vs actual\n\n${parts.join("\n\n")}`);
      }
      if (args.acceptanceCriteria?.length) md.push(`## Acceptance criteria\n\n${args.acceptanceCriteria.map((a) => `- [ ] ${a}`).join("\n")}`);
      if (args.technicalNotes) md.push(`## Technical notes\n\n${args.technicalNotes.trim()}`);
      if (args.relatedIssues?.length) md.push(`## Related issues\n\n${args.relatedIssues.map((k) => `- ${k}`).join("\n")}`);
      if (args.links?.length) md.push(`## Links\n\n${args.links.map((l) => `- [${l.title}](${l.url})`).join("\n")}`);

      const fields = await buildCreateFields(c, {
        projectKey: args.projectKey,
        issueType: args.issueType,
        summary: args.summary,
        description: md.join("\n\n"),
        parentKey: args.parentKey,
        assignee: args.assignee,
        priority: args.priority,
        labels: args.labels,
        components: args.components,
        dueDate: args.dueDate,
        storyPoints: args.storyPoints,
        customFields: args.customFields,
      });
      const r = await createIssue(c, fields);
      return json({ key: r.key, url: c.issueUrl(r.key), descriptionPreview: md.join("\n\n").slice(0, 600) });
    },
  );
}
