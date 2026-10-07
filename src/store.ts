import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";

export interface JiraSite {
  id: string; // cloudId
  name: string;
  url: string;
  scopes: string[];
  avatarUrl?: string;
}

export interface TokenState {
  accessToken: string;
  refreshToken: string;
  /** Unix ms when the access token expires. */
  expiresAt: number;
  scopes: string[];
  sites: JiraSite[];
  /** cloudId chosen by the user when more than one site is accessible. */
  selectedCloudId?: string;
  /** Account info captured at login for display. */
  account?: { accountId: string; displayName: string; email?: string };
  updatedAt: string;
}

function tokenPath(): string {
  return join(configDir(), "tokens.json");
}

export function readTokens(): TokenState | undefined {
  const p = tokenPath();
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as TokenState;
  } catch (err) {
    console.error(`[jirum] could not parse ${p}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Writes atomically with 0600 permissions so other local users cannot read the refresh token. */
export function writeTokens(state: TokenState): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = tokenPath();
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  renameSync(tmp, p);
}

export function clearTokens(): boolean {
  const p = tokenPath();
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function tokenFileLocation(): string {
  return tokenPath();
}
