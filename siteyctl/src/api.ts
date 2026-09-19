import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { AppRouter } from "../../server/src/routers/index.ts";
import { UsageError } from "./args.ts";
import { LOCAL_SERVER_NAME, ProfileError } from "./profiles.ts";

export type { AppRouter };

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  CONFLICT_OR_NOT_FOUND: 3,
  TIMEOUT: 4,
} as const;

export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT.ERROR) {
    super(message);
    this.exitCode = exitCode;
  }
}

const REQUEST_TIMEOUT_MS = 120_000;

export function createApi(url: string, token: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${url}/api/trpc`,
        headers: { authorization: `Bearer ${token}` },
        fetch: (input, init) =>
          fetch(input as string, {
            ...(init as RequestInit),
            signal:
              (init?.signal as AbortSignal | undefined) ??
              AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
      }),
    ],
  });
}

export type Api = ReturnType<typeof createApi>;

const USAGE_CODES = new Set([
  "BAD_REQUEST",
  "PARSE_ERROR",
  "UNPROCESSABLE_CONTENT",
  "PAYLOAD_TOO_LARGE",
]);
const CONFLICT_CODES = new Set(["CONFLICT", "NOT_FOUND"]);

type ZodIssue = { path?: (string | number)[]; message?: string };

function zodMessage(message: string): string | null {
  try {
    const issues = JSON.parse(message) as ZodIssue[];
    if (!Array.isArray(issues) || !issues.length) return null;
    return issues
      .map((i) =>
        i.path?.length ? `${i.path.join(".")}: ${i.message}` : `${i.message}`,
      )
      .join("\n");
  } catch {
    return null;
  }
}

export type ErrorReport = { message: string; exitCode: number; code: string };

export function describeError(
  err: unknown,
  server?: { name: string; url: string },
): ErrorReport {
  if (err instanceof UsageError) {
    return { message: err.message, exitCode: EXIT.USAGE, code: "USAGE" };
  }
  if (err instanceof ProfileError) {
    return { message: err.message, exitCode: EXIT.USAGE, code: "PROFILE" };
  }
  if (err instanceof CliError) {
    return { message: err.message, exitCode: err.exitCode, code: "CLI" };
  }
  if (err instanceof TRPCClientError) {
    const data = err.data as { code?: string } | undefined;
    const code = data?.code;
    if (!code) {
      const where = server ? `${server.name} (${server.url})` : "the server";
      const cause = (err.cause as Error | undefined)?.message ?? err.message;
      const looksLikeWrongUrl =
        /JSON|Unexpected token|Unable to transform/i.test(err.message);
      return {
        message: looksLikeWrongUrl
          ? `${where} didn't answer like a Sitey API. Is the URL right? (${err.message})`
          : `Couldn't reach ${where}: ${cause}`,
        exitCode: EXIT.ERROR,
        code: "NETWORK",
      };
    }
    if (code === "UNAUTHORIZED" && server?.name === LOCAL_SERVER_NAME) {
      return {
        message:
          "The local-cli token was rejected. Reset it with: sitey token revoke local-cli (the next siteyctl run makes a new one).",
        exitCode: EXIT.ERROR,
        code,
      };
    }
    if (code === "UNAUTHORIZED") {
      return {
        message:
          `The token for ${server?.name ?? "this server"} was rejected (unknown, revoked or expired). ` +
          `Needs a human: ssh <vps> sitey token create <name>, then siteyctl login ${server?.name ?? "<server-name>"} ${server?.url ?? "<url>"}.`,
        exitCode: EXIT.ERROR,
        code,
      };
    }
    const message = zodMessage(err.message) ?? err.message;
    if (USAGE_CODES.has(code)) return { message, exitCode: EXIT.USAGE, code };
    if (CONFLICT_CODES.has(code)) {
      return { message, exitCode: EXIT.CONFLICT_OR_NOT_FOUND, code };
    }
    return { message, exitCode: EXIT.ERROR, code };
  }
  return {
    message: err instanceof Error ? err.message : String(err),
    exitCode: EXIT.ERROR,
    code: "ERROR",
  };
}
