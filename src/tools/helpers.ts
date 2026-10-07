import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { clientFor, type JiraClient } from "../jira/client.js";
import { NotConnectedError } from "../util/errors.js";

export type ToolResult = CallToolResult;

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

export function json(v: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(v, null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  const prefix = err instanceof NotConnectedError ? "NOT_CONNECTED: " : "";
  return { content: [{ type: "text", text: `${prefix}${msg}` }], isError: true };
}

/** Shared optional argument so every tool can target a specific Jira site. */
export const siteArg = z
  .string()
  .optional()
  .describe("Jira site to use when your account has several: cloud id, site name, or URL (e.g. 'acme' or 'acme.atlassian.net'). Omit to use the selected/default site.");

export const projectKeyArg = z.string().min(1).describe("Project key, e.g. 'THEOS'.");
export const issueKeyArg = z.string().min(1).describe("Issue key, e.g. 'THEOS-123'.");
export const assigneeArg = z
  .string()
  .nullable()
  .optional()
  .describe("Assignee: 'me', an accountId, an email, or a display name (must match exactly one user). null or 'unassigned' clears it.");
export const markdownArg = (what: string) => z.string().optional().describe(`${what} in Markdown. Headings, lists, code blocks, links, bold/italic and tables are converted to Jira's rich text format.`);

type Shape = z.ZodRawShape;
type ArgsOf<S extends Shape> = z.infer<z.ZodObject<S>> & { site?: string };

/**
 * Registers a tool whose handler receives a ready JiraClient for the chosen
 * site. Errors are converted to isError results instead of protocol errors so
 * Claude can read them and recover (e.g. by calling jira_connect).
 */
export function jiraTool<S extends Shape>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string; readOnly?: boolean; destructive?: boolean; idempotent?: boolean },
  shape: S,
  handler: (c: JiraClient, args: ArgsOf<S>) => Promise<ToolResult>,
): void {
  const fullShape = { ...shape, site: siteArg };
  server.registerTool(
    name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: fullShape,
      annotations: {
        readOnlyHint: meta.readOnly ?? false,
        destructiveHint: meta.destructive ?? false,
        idempotentHint: meta.idempotent ?? false,
        openWorldHint: true,
      },
    },
    (async (args: ArgsOf<S>) => {
      try {
        const c = clientFor(args.site);
        return await handler(c, args);
      } catch (err) {
        return fail(err);
      }
    }) as never,
  );
}

/** Same as jiraTool but without a Jira client (auth/config tools). */
export function plainTool<S extends Shape>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string; readOnly?: boolean; destructive?: boolean },
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
): void {
  server.registerTool(
    name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: shape,
      annotations: { readOnlyHint: meta.readOnly ?? false, destructiveHint: meta.destructive ?? false, openWorldHint: true },
    },
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return await handler(args);
      } catch (err) {
        return fail(err);
      }
    }) as never,
  );
}
