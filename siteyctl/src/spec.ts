/**
 * Every siteyctl command: arguments, options, and help text. The parser
 * (args.ts) and the help (help.ts) both read this table, so help can't drift
 * from what's accepted. The help is the agent guide: an agent learns the tool
 * from `siteyctl --help` and `siteyctl <command> --help`, so each command has
 * at least one concrete example (tests/help.test.ts parses them all).
 */

export type OptionSpec = {
  /** "optional-string": `--flag` alone uses `defaultValue`; `--flag value` sets it. */
  type: "string" | "boolean" | "optional-string";
  multiple?: boolean;
  short?: string;
  placeholder?: string;
  defaultValue?: string;
  description: string;
};

export type CommandSpec = {
  /** One or two words, e.g. "services" or "service create". */
  name: string;
  /** Positional argument names; a trailing "?" marks one optional. */
  args: string[];
  summary: string;
  description?: string;
  options: Record<string, OptionSpec>;
  examples: string[];
};

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  server: {
    type: "string",
    placeholder: "name",
    description:
      "Server profile to use. Default: $SITEY_SERVER, then the only profile.",
  },
  json: {
    type: "boolean",
    description:
      "Print the result as JSON on stdout (diagnostics stay on stderr).",
  },
  help: { type: "boolean", short: "h", description: "Show help." },
};

const WAIT_OPTIONS: Record<string, OptionSpec> = {
  wait: {
    type: "boolean",
    description: "Keep checking until the service is live or a check fails.",
  },
  timeout: {
    type: "string",
    placeholder: "seconds",
    description: "Give up after this long with exit code 4 (default 300).",
  },
};

const BUILD_OPTIONS: Record<string, OptionSpec> = {
  branch: {
    type: "string",
    placeholder: "branch",
    description: "Git branch to deploy (default main).",
  },
  "build-image": {
    type: "string",
    placeholder: "image",
    description: "Docker image to build in, e.g. node:24-bookworm-slim.",
  },
  "build-command": {
    type: "string",
    placeholder: "cmd",
    description:
      'Build command, run from the repo root, e.g. "cd landings/x && npm ci && npm run build".',
  },
  "output-dir": {
    type: "string",
    placeholder: "dir",
    description:
      "Static: directory to serve, relative to the repo root (default dist).",
  },
  "run-command": {
    type: "string",
    placeholder: "cmd",
    description: "Server: command that starts the app.",
  },
  port: {
    type: "string",
    placeholder: "port",
    description:
      "Server: port the app listens on (default 3000; $PORT is set).",
  },
  dockerfile: {
    type: "optional-string",
    placeholder: "path",
    defaultValue: "Dockerfile",
    description:
      "Server: build with a Dockerfile instead (default path Dockerfile). Put it after the positional arguments.",
  },
};

export const COMMANDS: CommandSpec[] = [
  // ── Profiles ──────────────────────────────────────────────────────────────
  {
    name: "login",
    args: ["server-name", "url"],
    summary: "Save a server profile; prompts for an API token",
    description:
      "Reads the token from the terminal (hidden) or from stdin when piped, checks it against the server, and saves it.\n" +
      "Create the token on the VPS first: ssh <vps> sitey token create <name>. The URL must be HTTPS, except localhost (an SSH tunnel).",
    options: {},
    examples: [
      "siteyctl login andluck https://sitey.andluck.com",
      "ssh andluck-vps sitey token create home-pc | siteyctl login andluck https://sitey.andluck.com",
    ],
  },
  {
    name: "servers",
    args: [],
    summary: "List saved server profiles",
    options: {},
    examples: ["siteyctl servers"],
  },

  // ── Services ──────────────────────────────────────────────────────────────
  {
    name: "services",
    args: [],
    summary: "List services: id, name, mode, status, routes",
    options: {},
    examples: ["siteyctl services", "siteyctl services --json"],
  },
  {
    name: "service get",
    args: ["service"],
    summary: "Show a service's settings, routes, env var names, deployments",
    options: {},
    examples: [
      "siteyctl service get idea-a",
      "siteyctl service get service-42 --json",
    ],
  },
  {
    name: "service create",
    args: ["name"],
    summary: "Create a service, queue its first deploy, add routes",
    description:
      "Names are unique: lowercase letters, digits and '-', at most 40 characters, not purely numeric and not starting with service-<digits>.\n" +
      "Sitey clones from GitHub, so push the code first. With the default --github-mode app, create fails early if the GitHub App can't see the repo.\n" +
      "--route values are checked before anything is created. The command prints the new id; hold on to it if a script must survive renames.",
    options: {
      repo: {
        type: "string",
        placeholder: "owner/name",
        description: "GitHub repository (required).",
      },
      mode: {
        type: "string",
        placeholder: "static|server",
        description:
          "static: build, then serve files. server: run a container behind the proxy. Required.",
      },
      ...BUILD_OPTIONS,
      route: {
        type: "string",
        multiple: true,
        placeholder: "route",
        description: "Route to add once created. Repeatable.",
      },
      "github-mode": {
        type: "string",
        placeholder: "app|webhook",
        description:
          "app (default): deploy on push through the GitHub App. webhook: for repos without the App; a human adds the webhook from the web UI.",
      },
    },
    examples: [
      'siteyctl service create idea-c --repo ubershmekel/myswe --mode static --build-image node:24-bookworm-slim --build-command "cd landings/idea-c && npm ci && npm run build" --output-dir landings/idea-c/dist --route idea-c.andluck.com',
      'siteyctl service create idea-b-api --repo ubershmekel/myswe --mode server --build-command "cd services/idea-b-api && npm ci" --run-command "cd services/idea-b-api && npm start" --port 8080 --route idea-b.andluck.com/api',
    ],
  },
  {
    name: "service set",
    args: ["service"],
    summary: "Change build or run settings (doesn't redeploy)",
    description:
      "Only the flags you pass change. Run siteyctl deploy afterwards to apply them.",
    options: {
      mode: {
        type: "string",
        placeholder: "static|server",
        description: "Switch the deploy mode.",
      },
      ...BUILD_OPTIONS,
      "no-dockerfile": {
        type: "boolean",
        description: "Server: stop using a Dockerfile; build automatically.",
      },
    },
    examples: [
      'siteyctl service set idea-a --build-command "cd landings/idea-a && npm ci && npm run build:prod"',
      "siteyctl service set idea-b-api --dockerfile services/idea-b-api/Dockerfile",
    ],
  },
  {
    name: "service rename",
    args: ["service", "new-name"],
    summary: "Rename a service (id, data, history and routes stay attached)",
    options: {},
    examples: ["siteyctl service rename idea-a launch-a"],
  },
  {
    name: "service deactivate",
    args: ["service"],
    summary: "Stop serving a service; keeps its data",
    description:
      "Stops the container and removes the service's routes from the proxy. Prefer this over delete.",
    options: {},
    examples: ["siteyctl service deactivate idea-c"],
  },
  {
    name: "service activate",
    args: ["service"],
    summary: "Serve a deactivated service again",
    description:
      "Static sites come back as they were. Server apps need a deploy to start their container again.",
    options: {},
    examples: [
      "siteyctl service activate idea-c && siteyctl deploy idea-c --wait",
    ],
  },
  {
    name: "service delete",
    args: ["service"],
    summary: "Delete a service, its files and history (irreversible)",
    description:
      "Removes the container, the service's data directory, its routes and its deployment history. Prefer service deactivate.\n" +
      "--confirm must repeat the service's current name.",
    options: {
      confirm: {
        type: "string",
        placeholder: "name",
        description: "The service's current name (required).",
      },
    },
    examples: ["siteyctl service delete idea-c --confirm idea-c"],
  },

  // ── Routes ────────────────────────────────────────────────────────────────
  {
    name: "route add",
    args: ["service", "route"],
    summary: "Route a hostname (and optional path) to a service",
    description:
      "The host must be covered by a domain already added to Sitey: either exactly (andluck.com) or by a wildcard one level up (*.andluck.com covers idea-a.andluck.com, not a.b.andluck.com).\n" +
      "Adding a route the service already has succeeds without changes. A route another service has is a conflict (exit 3).",
    options: {},
    examples: [
      "siteyctl route add idea-a idea-a.andluck.com",
      "siteyctl route add idea-b-api idea-b.andluck.com/api",
      "siteyctl route add red http://localhost/red",
    ],
  },
  {
    name: "route remove",
    args: ["service", "route"],
    summary: "Remove one of a service's routes",
    options: {},
    examples: ["siteyctl route remove idea-a idea-a.andluck.com"],
  },

  // ── Env vars ──────────────────────────────────────────────────────────────
  {
    name: "env list",
    args: ["service"],
    summary: "List env var names (values are never shown)",
    options: {},
    examples: ["siteyctl env list idea-b-api"],
  },
  {
    name: "env set",
    args: ["service", "VAR"],
    summary: "Set an env var; the value is read from stdin",
    description:
      "Values come from stdin (hidden prompt in a terminal), never from arguments, so they stay out of shell history. One trailing newline is dropped; values can't contain line breaks.\n" +
      "Doesn't redeploy: run siteyctl deploy to apply.",
    options: {},
    examples: [
      'printf %s "$STRIPE_KEY" | siteyctl env set idea-b-api STRIPE_KEY',
      "siteyctl env set idea-b-api DATABASE_URL < db-url.txt",
    ],
  },
  {
    name: "env unset",
    args: ["service", "VAR"],
    summary: "Remove an env var (doesn't redeploy)",
    options: {},
    examples: ["siteyctl env unset idea-b-api STRIPE_KEY"],
  },

  // ── Deploy and verify ─────────────────────────────────────────────────────
  {
    name: "deploy",
    args: ["service"],
    summary: "Queue a deploy of the branch's latest commit",
    description:
      "With --wait, follows that deployment and then runs the same live checks as status --wait.",
    options: WAIT_OPTIONS,
    examples: ["siteyctl deploy idea-a --wait --timeout 300"],
  },
  {
    name: "status",
    args: ["service?"],
    summary: "Check whether a service is live",
    description:
      "Checks, for each route: the latest deployment succeeded; the HTTPS certificate is valid for the host; a GET returns 2xx and isn't Sitey's placeholder page (following up to 5 same-host redirects).\n" +
      "Without a service, checks every active service once. Exit 0 when everything passes, 1 when something failed or isn't ready (without --wait), 4 on timeout.\n" +
      "A server app answering 401/404 at the route is reported with its HTTP status, not as live.",
    options: WAIT_OPTIONS,
    examples: [
      "siteyctl status idea-c --wait --timeout 300 --json",
      "siteyctl status",
    ],
  },
  {
    name: "logs",
    args: ["service"],
    summary: "Print deployment (build) logs, or the app's runtime logs",
    options: {
      deployment: {
        type: "string",
        placeholder: "id",
        description: "Deployment id (default: the latest).",
      },
      tail: {
        type: "string",
        placeholder: "lines",
        description: "Number of lines (default 200).",
      },
      runtime: {
        type: "boolean",
        description: "Server apps: the running container's logs instead.",
      },
    },
    examples: [
      "siteyctl logs idea-a",
      "siteyctl logs idea-b-api --runtime --tail 50",
    ],
  },

  // ── Domains ───────────────────────────────────────────────────────────────
  {
    name: "domains",
    args: [],
    summary: "List domains",
    options: {},
    examples: ["siteyctl domains"],
  },
  {
    name: "domain add",
    args: ["hostname"],
    summary: "Add a domain (or *.wildcard) that routes can use",
    description:
      "DNS is set by a human: A records for @ and * pointing at the VPS. Add both the apex and the wildcard once; after that any <label>.<domain> route works.",
    options: {
      email: {
        type: "string",
        placeholder: "email",
        description: "Let's Encrypt contact email.",
      },
    },
    examples: [
      "siteyctl domain add andluck.com",
      "siteyctl domain add '*.andluck.com'",
    ],
  },

  // ── Export ────────────────────────────────────────────────────────────────
  {
    name: "export",
    args: [],
    summary: "Print the server's configuration as YAML",
    description:
      "Deterministic (exporting twice gives identical bytes), so it can be committed and diffed. Excludes runtime state, deployments, users, tokens and secret values.",
    options: {
      output: {
        type: "string",
        short: "o",
        placeholder: "file",
        description: "Write to a file instead of stdout.",
      },
    },
    examples: [
      "siteyctl export -o sitey/andluck.yaml",
      'siteyctl export -o sitey/andluck.yaml && git add sitey/andluck.yaml && git commit -m "Route idea-c.andluck.com"',
    ],
  },
];

export const WORKFLOW_EXAMPLES: { title: string; commands: string[] }[] = [
  {
    title:
      "Launch a landing page (commit and push its code first: Sitey clones from GitHub)",
    commands: [
      'siteyctl service create idea-c --repo ubershmekel/myswe --mode static --build-image node:24-bookworm-slim --build-command "cd landings/idea-c && npm ci && npm run build" --output-dir landings/idea-c/dist --route idea-c.andluck.com',
      "siteyctl status idea-c --wait --timeout 300",
      'siteyctl export -o sitey/andluck.yaml && git add sitey/andluck.yaml && git commit -m "Launch idea-c"',
    ],
  },
  {
    title: "Add a route",
    commands: [
      "siteyctl route add idea-c www.andluck.com",
      "siteyctl status idea-c --wait",
    ],
  },
  {
    title: "Set an env var and apply it",
    commands: [
      'printf %s "$STRIPE_KEY" | siteyctl env set idea-b-api STRIPE_KEY',
      "siteyctl deploy idea-b-api --wait",
    ],
  },
  {
    title: "Debug a failed launch",
    commands: [
      "siteyctl status idea-c",
      "siteyctl logs idea-c",
      "siteyctl service set idea-c --output-dir landings/idea-c/build",
      "siteyctl deploy idea-c --wait",
    ],
  },
  {
    title: "Retire a page (keeps its data; delete is irreversible)",
    commands: [
      "siteyctl service deactivate idea-c",
      "siteyctl export -o sitey/andluck.yaml",
    ],
  },
];

export const NEEDS_A_HUMAN = [
  "DNS records. Per domain, A records for @ and * pointing at the VPS (for a nested namespace like *.s.andluck.com, *.s instead). siteyctl domain add only tells Sitey about the domain.",
  "The GitHub App. Connecting it to Sitey, and installing it on each account or repo to deploy, happens in the web UI and on github.com.",
  "API tokens. A human creates them on the VPS (ssh <vps> sitey token create <name>) and runs siteyctl login. Tokens are root-equivalent on the VPS.",
  "Pushing code. Sitey deploys what's on GitHub, so commit and push before creating or deploying a service.",
];
