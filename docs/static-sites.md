# Static Sites: Routing, Subpages and 404s

A service with deploy mode `static` builds your repo, then Caddy serves the
files in its output directory. **Static routing** decides what a URL serves.
There are three modes:

| Mode            | Pick it for                                          | Unmatched paths                   |
| --------------- | ---------------------------------------------------- | --------------------------------- |
| `spa` (default) | React Router, Vue Router, other client-side routers  | `index.html`, status 200          |
| `multi-page`    | Landing pages, docs, blogs: anything with real pages | `404.html` if present, status 404 |
| `caddy`         | Redirects, headers, anything else                    | Whatever your directives say      |

Changing the mode, or the custom Caddy directives, takes effect immediately
through a Caddy reload. You don't need to redeploy.

## Setting it

From the web UI: open the service, then **Service Settings** → **Static
routing**.

With `siteyctl`:

```bash
siteyctl service create examplesite --repo me/site --mode static \
  --output-dir dist --static-routing multi-page

siteyctl service set examplesite --static-routing spa
siteyctl service set examplesite --static-caddy-file routing.caddy   # implies caddy mode
siteyctl service get examplesite                                     # shows the mode and directives
```

## `spa`: single-page app

```caddy
try_files {path} /index.html
file_server
```

A request for an existing file serves it. Everything else serves your root
`index.html` with status 200, so your client-side router can render the page.

This mode is a poor fit for a site with separate HTML pages. `/privacy/` returns
the home page rather than `privacy/index.html`, and a typo never returns a 404.
After a deploy in SPA mode, Sitey warns in the deploy log when the output looks
like a multi-page site (nested `index.html` files, a `404.html`, or several
top-level `.html` pages). It never changes the mode for you.

Every service created before static routing existed uses this mode, so upgrading
Sitey changes nothing.

## `multi-page`: ordinary static site

For a request to `/about`, Sitey tries, in order:

1. `/about` (an exact file)
2. `/about/index.html`
3. `/about.html`

So `/privacy`, `/privacy/` and `/privacy.html` all work, whether your build
emits `privacy.html` or `privacy/index.html`.

When nothing matches, the response is a **404**. If the output directory has a
`404.html` at its root, that page is the body, still with status 404. Otherwise
the body is empty. No setting is needed: `404.html` is simply this mode's
convention.

Under a path prefix (e.g. `example.com/docs`), everything is relative to that
service's own output. A missing `/docs/x` uses the docs service's `404.html`,
never another service's page on the same domain.

## `caddy`: custom directives

For anything the presets don't cover, write Caddy directives yourself. Sitey
still generates the site around them:

```caddy
example.com {
    import requests_log              # Sitey: analytics
    handle {
        log_append service_id 42     # Sitey: analytics
        header >X-Sitey-Service 42   # Sitey: service identification
        root * /srv/services/42/repo/dist   # Sitey: your output directory

        # ── your directives ──
    }
}
```

Your directives replace the built-in serving directives, so include a
`file_server` (usually with `try_files`). For example:

```caddy
@legacy path /old/*
redir @legacy /new{uri} 308

header /assets/* Cache-Control "public, max-age=31536000, immutable"

try_files {path} {path}/index.html {path}.html =404
file_server
```

Write only what goes inside the block: no hostname and no outer braces.

### What's allowed

Your directives can break your own service, but they can't affect another
service or Sitey itself. So only service-scoped directives are accepted:

- `abort`, `basic_auth`, `encode`, `error`, `file_server`, `handle`,
  `handle_path`, `header`, `method`, `redir`, `request_body`, `request_header`,
  `respond`, `rewrite`, `route`, `try_files`, `uri`
- Named matchers (`@name ...`)

These are rejected:

- Site blocks and unbalanced braces
- `root`, and `root`/`fs` inside `file_server` or a `file` matcher. Sitey owns
  the filesystem root.
- `reverse_proxy`, `import`, `vars`, `map`, `templates`, `log_append` and every
  other directive not listed above
- `file_server browse <template>` (`browse` alone is fine)
- `{$ENV}`, `{env.*}` and `{file.*}` placeholders
- Heredocs, and backslashes outside quotes

### Validation

Saving checks the directives twice before anything is stored:

1. Sitey's scope check, using the rules above.
2. Caddy's own parser (its `/adapt` endpoint) on a throwaway site shaped like
   the real one. Errors point at your line numbers.

If either check fails, the save is rejected and the live config is untouched. If
Caddy is unreachable, the save is rejected too: Sitey won't store directives it
couldn't check. Caddy loads configs atomically, so even a failed reload leaves
the previous working config in place.

Switching away from `caddy` mode keeps the saved directives, so switching back
restores them. Server services keep these settings in the database too, but they
have no effect there.

## Not supported

Sitey doesn't read `_redirects`, `netlify.toml`, `vercel.json` or any other
per-repo routing file. It has no redirect language of its own either. Use the
presets, or custom Caddy for anything beyond them.
