import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBoard, listBoards, listSprints, moveToSprint, resolveSprint, sprintIssues } from "../jira/agile.js";
import { SUMMARY_FIELDS } from "../jira/issues.js";
import { issueTable, summarize } from "../util/format.js";
import { jiraTool, json, text } from "./helpers.js";

export function registerAgileTools(server: McpServer): void {
  jiraTool(
    server,
    "jira_get_boards",
    { title: "List boards", description: "Scrum/Kanban boards, optionally filtered by project key or name. Board ids are needed for sprint lookups.", readOnly: true },
    { projectKey: z.string().optional(), name: z.string().optional(), type: z.enum(["scrum", "kanban", "simple"]).optional() },
    async (c, { projectKey, name, type }) => {
      const boards = await listBoards(c, { projectKey, name, type });
      return json(boards.map((b) => ({ id: b.id, name: b.name, type: b.type, project: b.location?.projectKey ?? b.location?.name })));
    },
  );

  jiraTool(
    server,
    "jira_get_sprints",
    {
      title: "List sprints",
      description: "Sprints for a board (by boardId) or for a project's scrum boards (by projectKey). Default state filter: active and future.",
      readOnly: true,
    },
    {
      boardId: z.number().int().optional(),
      projectKey: z.string().optional(),
      state: z.enum(["active", "future", "closed", "active,future", "all"]).optional(),
    },
    async (c, { boardId, projectKey, state }) => {
      const ids = boardId ? [boardId] : (await listBoards(c, { projectKey, type: "scrum" })).map((b) => b.id);
      if (!ids.length) throw new Error(projectKey ? `No scrum boards found for project ${projectKey}.` : "Pass boardId or projectKey.");
      const out: unknown[] = [];
      for (const id of ids) {
        const b = await getBoard(c, id);
        const sprints = await listSprints(c, id, state === "all" ? undefined : (state ?? "active,future"));
        out.push({
          board: { id: b.id, name: b.name },
          sprints: sprints.map((s) => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate, goal: s.goal })),
        });
      }
      return json(out);
    },
  );

  jiraTool(
    server,
    "jira_get_sprint_issues",
    { title: "Get sprint issues", description: "Issues in a sprint. `sprint` is an id, a name, 'active' or 'next' (the latter two need boardId or projectKey).", readOnly: true },
    { sprint: z.string().min(1), boardId: z.number().int().optional(), projectKey: z.string().optional(), jql: z.string().optional().describe("Extra JQL filter, e.g. 'assignee = currentUser()'."), maxResults: z.number().int().min(1).max(100).optional() },
    async (c, { sprint, boardId, projectKey, jql, maxResults }) => {
      const s = await resolveSprint(c, sprint, { boardId, projectKey });
      const issues = await sprintIssues(c, s.id, SUMMARY_FIELDS, jql, maxResults ?? 50);
      const rows = issues.map((i) => summarize(c, i));
      return text(`Sprint ${s.name} [${s.id}, ${s.state}]${s.goal ? ` — goal: ${s.goal}` : ""}\n\n${issueTable(rows)}`);
    },
  );

  jiraTool(
    server,
    "jira_add_to_sprint",
    {
      title: "Add issues to sprint",
      description: "Moves up to 50 issues into a sprint. `sprint` is an id, a name, 'active' or 'next' (name/active/next need boardId or projectKey; projectKey defaults to the first issue's project).",
    },
    { issueKeys: z.array(z.string().min(1)).min(1).max(50), sprint: z.string().min(1), boardId: z.number().int().optional(), projectKey: z.string().optional() },
    async (c, { issueKeys, sprint, boardId, projectKey }) => {
      const s = await resolveSprint(c, sprint, { boardId, projectKey: projectKey ?? issueKeys[0]!.split("-")[0] });
      await moveToSprint(c, s.id, issueKeys);
      return text(`Moved ${issueKeys.join(", ")} to sprint ${s.name} [${s.id}].`);
    },
  );
}
