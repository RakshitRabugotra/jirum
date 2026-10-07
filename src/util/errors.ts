export class JiraError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

export class NotConnectedError extends Error {
  constructor(message = "Jira is not connected. Run the `jira_connect` tool (or `jira-mcp login` in a terminal) to authorize.") {
    super(message);
    this.name = "NotConnectedError";
  }
}

/** Turns Jira's assorted error payloads into one readable line. */
export function describeJiraErrorBody(body: unknown): string {
  if (!body || typeof body !== "object") return typeof body === "string" ? body : "";
  const b = body as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(b.errorMessages)) parts.push(...(b.errorMessages as unknown[]).map(String));
  if (b.errors && typeof b.errors === "object") {
    for (const [k, v] of Object.entries(b.errors as Record<string, unknown>)) parts.push(`${k}: ${String(v)}`);
  }
  if (typeof b.message === "string") parts.push(b.message);
  if (typeof b.error === "string") parts.push(b.error);
  if (typeof b.error_description === "string") parts.push(b.error_description);
  return parts.join("; ");
}
