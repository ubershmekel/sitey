/**
 * How a static service's files are served. See docs/static-sites.md.
 *
 *  - `spa`: unmatched paths serve /index.html (client-side routers).
 *  - `multi-page`: /about → about/index.html or about.html; missing pages are a
 *    real 404, using 404.html from the output when it exists.
 *  - `caddy`: the service supplies its own Caddy directives. Sitey still owns
 *    the site block, TLS, analytics tagging and the filesystem root.
 *
 * Custom fragments are placed inside the service's generated handle block, so
 * they must not be able to close that block, point at another directory, or
 * reach other containers. `checkCaddyFragment` enforces that with a lexer that
 * mirrors Caddy's tokenizer and a directive allowlist; Caddy's own adapter
 * then validates the syntax (see validateStaticCaddyConfig in caddy.ts).
 */

import fs from "node:fs";
import path from "node:path";

export const STATIC_ROUTING_MODES = ["spa", "multi-page", "caddy"] as const;
export type StaticRoutingMode = (typeof STATIC_ROUTING_MODES)[number];

/** Directives a fragment may use, at its top level or inside handle/route. */
const ALLOWED_DIRECTIVES = new Set([
  "abort",
  "basic_auth",
  "basicauth",
  "encode",
  "error",
  "file_server",
  "handle",
  "handle_path",
  "header",
  "method",
  "redir",
  "request_body",
  "request_header",
  "respond",
  "rewrite",
  "route",
  "try_files",
  "uri",
]);

/** Blocks whose lines are directives again, rather than subdirectives. */
const CONTAINER_DIRECTIVES = new Set(["handle", "handle_path", "route"]);

/**
 * Subdirectives that would change where files come from (file_server and the
 * `file` matcher both accept `root` and `fs`). Rejected in any nested block.
 */
const FORBIDDEN_SUBDIRECTIVES = new Set(["root", "fs", "import"]);

/**
 * Placeholders that read the Caddy container's environment or files. `{$VAR}`
 * is expanded before Caddy even tokenizes, so it could also inject syntax.
 */
const FORBIDDEN_PLACEHOLDERS = [/\{\$/, /\{env\./, /\{file\./];

export class CaddyFragmentError extends Error {}

type Token = { text: string; quoted: boolean; line: number; endLine: number };

type Lexed = {
  tokens: Token[];
  /** 0-based lines that begin inside a quoted string; they aren't re-indented. */
  continuationLines: Set<number>;
};

function fail(line: number, message: string): never {
  throw new CaddyFragmentError(`Line ${line}: ${message}`);
}

/**
 * Tokenizes like Caddy's lexer: whitespace separates tokens, "…" and `…` quote,
 * `#` at the start of a token begins a comment. Anything whose meaning is
 * ambiguous between this lexer and Caddy's (escapes outside quotes, heredocs)
 * is rejected rather than guessed at.
 */
function lex(input: string): Lexed {
  const tokens: Token[] = [];
  const continuationLines = new Set<number>();
  let line = 1;
  let text = "";
  let inToken = false;
  let quote: '"' | "`" | null = null;
  let quoteLine = 0;
  let tokenLine = 1;

  const end = (quoted: boolean) => {
    if (inToken) tokens.push({ text, quoted, line: tokenLine, endLine: line });
    text = "";
    inToken = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === "\n") {
        line++;
        continuationLines.add(line - 1);
      }
      if (quote === '"' && ch === "\\" && input[i + 1] === '"') {
        text += '"';
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        const next = input[i + 1];
        if (next !== undefined && !/\s/.test(next))
          fail(line, "put whitespace after a closing quote.");
        end(true);
        continue;
      }
      text += ch;
      continue;
    }
    if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
      end(false);
      if (ch === "\n") line++;
      continue;
    }
    if (!inToken) {
      if (ch === "#") {
        while (i + 1 < input.length && input[i + 1] !== "\n") i++;
        continue;
      }
      if (ch === '"' || ch === "`") {
        quote = ch;
        quoteLine = line;
        inToken = true;
        tokenLine = line;
        continue;
      }
      if (ch === "<" && input[i + 1] === "<")
        fail(line, "heredocs (<<) aren't supported here.");
      tokenLine = line;
      inToken = true;
    }
    if (ch === "\\") fail(line, "backslashes outside quotes aren't allowed.");
    if (ch === '"' || ch === "`")
      fail(line, "quotes must start a token (put a space before them).");
    text += ch;
  }
  if (quote) fail(quoteLine, "unterminated quote.");
  end(false);
  return { tokens, continuationLines };
}

/**
 * Checks that a fragment only uses service-scoped directives and can't leave
 * its block. Returns the fragment unchanged when it passes.
 */
export function checkCaddyFragment(input: string): string {
  if (!input.trim())
    throw new CaddyFragmentError(
      "Custom Caddy config is empty. Add directives such as `try_files` and `file_server`.",
    );
  for (const pattern of FORBIDDEN_PLACEHOLDERS) {
    const index = input.search(pattern);
    if (index >= 0) {
      const line = input.slice(0, index).split("\n").length;
      fail(
        line,
        "environment and file placeholders ({$…}, {env.…}, {file.…}) aren't allowed.",
      );
    }
  }

  const { tokens } = lex(input);
  // Group tokens into lines (Caddy directives end at a newline). A token that
  // starts where a multi-line quoted token ended is on the same line.
  const lines: Token[][] = [];
  for (const token of tokens) {
    const last = lines[lines.length - 1];
    if (last && last[last.length - 1].endLine === token.line) last.push(token);
    else lines.push([token]);
  }

  // Each open block remembers whether its lines are directives.
  const stack: { directive: string; container: boolean; line: number }[] = [];
  for (const lineTokens of lines) {
    for (const t of lineTokens) {
      if (t.quoted && (t.text === "{" || t.text === "}"))
        fail(t.line, "a quoted brace is ambiguous; remove the quotes.");
    }
    const first = lineTokens[0];
    const isBrace = (t: Token) =>
      !t.quoted && (t.text === "{" || t.text === "}");

    if (!first.quoted && first.text === "}") {
      if (lineTokens.length > 1)
        fail(first.line, "put a closing brace on its own line.");
      if (!stack.length)
        fail(
          first.line,
          "unmatched closing brace. The config goes inside the service's block, not around it.",
        );
      stack.pop();
      continue;
    }

    const opens = lineTokens.filter((t) => isBrace(t) && t.text === "{");
    const closes = lineTokens.filter((t) => isBrace(t) && t.text === "}");
    if (closes.length) fail(first.line, "put a closing brace on its own line.");
    if (opens.length > 1 || (opens.length && lineTokens.at(-1) !== opens[0]))
      fail(first.line, "an opening brace must end its line.");
    if (opens.length && lineTokens.length === 1)
      fail(first.line, "an opening brace must follow a directive.");

    const inDirectives = !stack.length || stack[stack.length - 1].container;
    const name = first.text;
    if (inDirectives) {
      if (first.quoted) fail(first.line, "a directive name can't be quoted.");
      if (name.startsWith("@")) {
        // Named matcher definitions are scoped to the block they're in.
        if (!/^@[A-Za-z0-9_-]+$/.test(name))
          fail(first.line, `invalid matcher name "${name}".`);
      } else if (!ALLOWED_DIRECTIVES.has(name)) {
        fail(
          first.line,
          /^[a-z0-9.:[\]*-]+$/i.test(name) &&
            lineTokens.length > 1 &&
            opens.length
            ? `"${name}" looks like a site block. Write only the directives that go inside this service's block; Sitey manages the hostname.`
            : `directive "${name}" isn't allowed in custom Caddy config. Allowed: ${[...ALLOWED_DIRECTIVES].join(", ")}, and @matcher definitions.`,
        );
      }
    } else if (!first.quoted && FORBIDDEN_SUBDIRECTIVES.has(name)) {
      fail(
        first.line,
        `"${name}" isn't allowed: Sitey manages this service's filesystem root.`,
      );
    }
    // `browse <template>` reads the template from anywhere on Caddy's disk.
    const parent = stack[stack.length - 1]?.directive;
    const browseAt =
      inDirectives && name === "file_server"
        ? lineTokens.findIndex((t) => t.text === "browse")
        : parent === "file_server" && name === "browse"
          ? 0
          : -1;
    if (browseAt >= 0) {
      const rest = lineTokens.slice(browseAt + 1).filter((t) => !isBrace(t));
      if (rest.length)
        fail(
          first.line,
          "browse templates aren't allowed; use `browse` alone.",
        );
    }

    if (opens.length)
      stack.push({
        directive: name,
        container: inDirectives && CONTAINER_DIRECTIVES.has(name),
        line: first.line,
      });
  }
  if (stack.length)
    fail(
      stack[stack.length - 1].line,
      `"${stack[stack.length - 1].directive}" block is never closed.`,
    );
  return input;
}

/** Indents a checked fragment, leaving lines inside multi-line quotes alone. */
function indentFragment(input: string, indent: string): string[] {
  const { continuationLines } = lex(input);
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\s+$/, "")
    .split("\n")
    .map((line, i) =>
      continuationLines.has(i) || !line.trim()
        ? line
        : `${indent}${line.trimStart()}`,
    );
}

/**
 * The serving directives for a ready static service, after `root` has been
 * set. Lines carry `indent`; nested blocks add four spaces per level.
 */
export function staticServingLines(
  service: { staticRoutingMode?: string; staticCaddyConfig?: string },
  indent: string,
): string[] {
  const i = indent;
  const mode = service.staticRoutingMode ?? "spa";
  if (mode === "multi-page") {
    // Everything stays inside this service's handler: a site-level
    // handle_errors would be shared by every service on the host.
    return [
      `${i}@sitey_page file {path} {path}/index.html {path}.html`,
      `${i}handle @sitey_page {`,
      `${i}    rewrite * {file_match.relative}`,
      `${i}    file_server`,
      `${i}}`,
      `${i}handle {`,
      `${i}    @sitey_404 file /404.html`,
      `${i}    handle @sitey_404 {`,
      `${i}        rewrite * /404.html`,
      `${i}        file_server {`,
      `${i}            status 404`,
      `${i}        }`,
      `${i}    }`,
      `${i}    handle {`,
      `${i}        respond 404`,
      `${i}    }`,
      `${i}}`,
    ];
  }
  if (mode === "caddy") {
    const fragment = service.staticCaddyConfig ?? "";
    try {
      checkCaddyFragment(fragment);
    } catch (err) {
      // Saved configs are checked on save; this only guards against a stored
      // value that no longer passes (e.g. an allowlist change), so one service
      // can't block every other site's reload.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[caddy] Ignoring invalid custom Caddy config: ${message}`);
      return [`${i}respond "Invalid custom Caddy config for this service" 500`];
    }
    return indentFragment(fragment, i);
  }
  return [`${i}try_files {path} /index.html`, `${i}file_server`];
}

/**
 * Signs that a build output is a multi-page site. Used to warn after an SPA
 * deploy; never to change the mode.
 */
export function detectMultiPageOutput(outputPath: string): string[] {
  const found: string[] = [];
  let topLevelHtml = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= 10) return;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (
          depth < 3 &&
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules"
        )
          walk(path.join(dir, entry.name), relPath, depth + 1);
      } else if (entry.isFile()) {
        if (rel && entry.name === "index.html") found.push(relPath);
        else if (!rel && entry.name === "404.html") found.push(relPath);
        else if (
          !rel &&
          entry.name.endsWith(".html") &&
          entry.name !== "index.html"
        )
          topLevelHtml++;
      }
    }
  };
  walk(outputPath, "", 0);
  if (found.length) return found.sort();
  return topLevelHtml >= 3 ? [`${topLevelHtml} top-level .html pages`] : [];
}
