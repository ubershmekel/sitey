/**
 * Server profiles: name → { url, token }, stored with owner-only permissions in
 * $SITEYCTL_CONFIG, %APPDATA%\sitey\servers.json (Windows), or
 * $XDG_CONFIG_HOME/sitey/servers.json (default ~/.config).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Profile = { url: string; token: string };
export type ProfileFile = { servers: Record<string, Profile> };

export class ProfileError extends Error {}

const PROFILE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function configPath(
  env = process.env,
  platform = process.platform,
): string {
  if (env.SITEYCTL_CONFIG) return env.SITEYCTL_CONFIG;
  if (platform === "win32" && env.APPDATA) {
    return path.join(env.APPDATA, "sitey", "servers.json");
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "sitey", "servers.json");
}

export function loadProfiles(file = configPath()): ProfileFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { servers: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProfileFile>;
    return { servers: parsed.servers ?? {} };
  } catch {
    throw new ProfileError(`${file} is not valid JSON. Fix or delete it.`);
  }
}

export function saveProfiles(data: ProfileFile, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  // writeFileSync's mode only applies to new files; tighten existing ones too.
  fs.chmodSync(file, 0o600);
}

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_REGEX.test(name)) {
    throw new ProfileError(
      `Server names are letters, digits, '.', '_' or '-' (got "${name}").`,
    );
  }
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Normalizes a panel URL to its origin; HTTPS required except on loopback. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ProfileError(`"${input}" is not a valid URL.`);
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new ProfileError(
      `siteyctl requires HTTPS (tokens are root-equivalent). Use https://${url.host}, or tunnel to http://localhost.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProfileError(`"${input}" must be an https:// URL.`);
  }
  return url.origin;
}

export function selectProfile(
  data: ProfileFile,
  flag: string | undefined,
  envServer: string | undefined,
): { name: string; profile: Profile } {
  const names = Object.keys(data.servers);
  const chosen = flag || envServer;
  if (chosen) {
    const profile = data.servers[chosen];
    if (!profile) {
      throw new ProfileError(
        `No server profile named "${chosen}"${flag ? "" : " (from $SITEY_SERVER)"}. ` +
          (names.length
            ? `Known: ${names.join(", ")}.`
            : "Add one with siteyctl login <server-name> <url>."),
      );
    }
    return { name: chosen, profile };
  }
  if (names.length === 1)
    return { name: names[0], profile: data.servers[names[0]] };
  if (!names.length) {
    throw new ProfileError(
      "No servers configured. Run siteyctl login <server-name> <url> (needs a token from ssh <vps> sitey token create <name>).",
    );
  }
  throw new ProfileError(
    `Several servers configured (${names.join(", ")}). Pick one with --server <name> or $SITEY_SERVER.`,
  );
}
