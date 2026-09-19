/**
 * Static output directory, relative to the service's repo checkout.
 *
 * The value is written into the Caddyfile as a quoted token
 * (`root * "/srv/services/<id>/repo/<outputDir>"`), so spaces are fine, but
 * quotes, backslashes and control characters would end or corrupt the token.
 * Braces are rejected too: Caddy expands `{...}` placeholders in `root` even
 * inside quotes. The path also must not leave the repo with `..` or an absolute
 * path. A bad value that reaches the database would break every later Caddy
 * reload, not just this service.
 */

import { z } from "zod";

export const OUTPUT_DIR_MAX_LENGTH = 200;

export function isValidOutputDir(dir: string): boolean {
  if (dir === "") return true;
  if (/["\\{}\x00-\x1f\x7f]/.test(dir)) return false;
  if (dir.startsWith("/")) return false;
  return !dir.split("/").includes("..");
}

export const outputDirSchema = z
  .string()
  .max(OUTPUT_DIR_MAX_LENGTH)
  .refine(
    isValidOutputDir,
    "Output directory must be a relative path inside the repo, without '..', quotes, backslashes, braces or control characters",
  );
