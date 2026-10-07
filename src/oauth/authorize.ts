import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { AppConfig } from "../config.js";

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function buildAuthorizeUrl(cfg: AppConfig, state: string): string {
  const u = new URL("https://auth.atlassian.com/authorize");
  u.searchParams.set("audience", "api.atlassian.com");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("scope", cfg.scopes.join(" "));
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

/** Best-effort: opens the system browser. Returns false if we could not spawn an opener. */
export function openBrowser(url: string): boolean {
  // Set JIRUM_NO_BROWSER=1 to only print the URL (tests, headless hosts, SSH sessions).
  if (process.env.JIRUM_NO_BROWSER) return false;
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url.replace(/&/g, "^&")];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      /* swallowed; caller already printed the URL */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
