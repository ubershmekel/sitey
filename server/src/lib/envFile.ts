/**
 * Edits to a service's `.env`-format envVars string, one variable at a time.
 *
 * The reader is parseEnvString (services/deployment.ts): one `KEY=value` per
 * line, optional `export `, `#` comments, and one layer of matching quotes
 * stripped from the value. Lines without "=" are left alone (they may be
 * continuation lines of a multi-line secret).
 */

export const ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvFileError extends Error {}

/** The variable a line assigns, or null for blanks, comments and non-assignments. */
export function envLineKey(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) return null;
  const key = trimmed
    .slice(0, eqIdx)
    .replace(/^export\s+/, "")
    .trim();
  return key || null;
}

/**
 * Variable names only, in file order, without repeats. Values are omitted from routine CLI output and exports.
 * Administrators can explicitly read them through the env value procedures.
 */
export function envVarNames(raw: string): string[] {
  const names = raw
    .split("\n")
    .map(envLineKey)
    .filter((k) => k !== null);
  return [...new Set(names)];
}

/** Strips one layer of matching quotes, as the reader does. */
export function unquoteEnvValue(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

function assertName(name: string) {
  if (!ENV_NAME_REGEX.test(name)) {
    throw new EnvFileError(
      `"${name}" is not a valid variable name. Use letters, digits and '_', not starting with a digit.`,
    );
  }
}

/** Serializes a value so parseEnvString reads back exactly `value`. */
function encodeValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new EnvFileError("Values can't contain line breaks.");
  }
  // The reader trims and strips one layer of matching quotes. Wrapping in
  // single quotes always survives both: exactly that layer is removed again.
  const needsQuotes =
    value !== value.trim() || unquoteEnvValue(value) !== value;
  return needsQuotes ? `'${value}'` : value;
}

function lines(raw: string): string[] {
  return raw === "" ? [] : raw.split("\n");
}

/** Sets `name`, replacing its first assignment in place and dropping repeats. */
export function setEnvVar(raw: string, name: string, value: string): string {
  assertName(name);
  const assignment = `${name}=${encodeValue(value)}`;
  const out: string[] = [];
  let replaced = false;
  for (const line of lines(raw)) {
    if (envLineKey(line) !== name) {
      out.push(line);
    } else if (!replaced) {
      out.push(assignment);
      replaced = true;
    }
  }
  if (!replaced) {
    // Append after any trailing blank lines are trimmed.
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    out.push(assignment);
  }
  return out.join("\n");
}

export function unsetEnvVar(
  raw: string,
  name: string,
): { envVars: string; removed: boolean } {
  assertName(name);
  const all = lines(raw);
  const kept = all.filter((line) => envLineKey(line) !== name);
  return { envVars: kept.join("\n"), removed: kept.length !== all.length };
}
