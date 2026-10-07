import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_SCOPES = [
  // Jira platform (classic scopes)
  "read:jira-user",
  "read:jira-work",
  "write:jira-work",
  // Jira platform (granular, needed by the agile board endpoints)
  "read:project:jira",
  // Jira Software agile API (granular only; classic scopes do not cover it)
  "read:board-scope:jira-software",
  "read:sprint:jira-software",
  "write:sprint:jira-software",
  "read:issue:jira-software",
];

export interface AppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  defaultSite?: string;
  configDir: string;
}

interface FileConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: string[];
  defaultSite?: string;
}

export function configDir(): string {
  return process.env.JIRUM_CONFIG_DIR || join(homedir(), ".config", "jirum");
}

function readFileConfig(dir: string): FileConfig {
  const p = join(dir, "config.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FileConfig;
  } catch {
    return {};
  }
}

let cached: AppConfig | undefined;

/**
 * Resolves configuration. Environment variables win over
 * ~/.config/jirum/config.json, which wins over defaults.
 * Client ID/secret are only required when an OAuth flow or token refresh runs,
 * so this never throws; callers check `clientId`/`clientSecret` when they need them.
 */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const dir = configDir();
  const file = readFileConfig(dir);
  const scopesEnv = process.env.JIRA_SCOPES?.trim();
  const scopes = scopesEnv
    ? scopesEnv.split(/\s+/)
    : file.scopes && file.scopes.length > 0
      ? file.scopes
      : DEFAULT_SCOPES;
  cached = {
    clientId: process.env.ATLASSIAN_CLIENT_ID || file.clientId || "",
    clientSecret: process.env.ATLASSIAN_CLIENT_SECRET || file.clientSecret || "",
    redirectUri:
      process.env.JIRA_OAUTH_REDIRECT_URI || file.redirectUri || "http://localhost:8787/oauth/callback",
    scopes: Array.from(new Set([...scopes, "offline_access"])),
    defaultSite: process.env.JIRA_DEFAULT_SITE || file.defaultSite,
    configDir: dir,
  };
  return cached;
}

export function requireClientCredentials(cfg: AppConfig): void {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(
      "Atlassian OAuth client credentials are missing. Set ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET " +
        `(environment variables or ${join(cfg.configDir, "config.json")}). ` +
        "Create an OAuth 2.0 integration at https://developer.atlassian.com/console/myapps/.",
    );
  }
}
