# Future Features

Features still in consideration or design phase.

## Security: Static Output Can Serve Files Outside Its Directory via Symlinks

Caddy's `file_server` follows symlinks. A static service's output directory is
part of a cloned repo, so a repo can commit a symlink (or a build step can
create one) that points outside the output directory, e.g.
`dist/leak -> /srv/services/<other-id>/repo`. Caddy only mounts
`$DATA_ROOT/services`, so the reach is limited to that tree, but that still
includes every other service's full repo checkout: private source, `.git`, and
any files that were never meant to be served.

Path traversal in URLs (`/../`) is already blocked by Caddy, and custom Caddy
config can't change `root`. The symlink is the remaining way out.

Options:

- After each static build, scan the output directory and fail the deploy (or
  delete the link) if any symlink resolves outside it. This is the simplest
  change. It needs to run on the resolved path, and again for anything the build
  writes after the check.
- Copy the build output into a separate serve directory
  (`/data/services/<id>/public`) and dereference or drop symlinks while copying.
  Caddy would then mount only the `public` directories, never the repos. This
  also stops serving the repo itself when `outputDir` is empty.
- Mount each service's served directory into Caddy separately. This is harder
  with one shared Caddy container.

## Security: Static Services on the Panel's Domain Share Its Origin

A service can be routed under a path on the Sitey panel's own hostname, e.g.
`sitey.example.com/docs`. Those routes are served from the same origin as the
panel. JavaScript in that service's files, or a `respond` body in its custom
Caddy config, can then call the panel API with the logged-in administrator's
`sitey_session` cookie, and can set cookies for the panel's hostname.

Anyone who can push to that service's repo (or its build dependencies) can take
over the panel once an administrator visits the page.

Options:

- Reject routes on the management hostname, as the bare management root already
  is. Serve services on their own hostname or subdomain instead. This is the
  cleanest fix; check who relies on path-prefix routes on the panel domain today
  and migrate them.
- If those routes must stay, set the session cookie with a `Path=/api` scope and
  add a `Content-Security-Policy: sandbox` response header on service routes
  under the panel hostname. This is weaker: same-origin requests, cookie
  tossing, and `fetch` with credentials need careful review.
- At minimum, warn in the UI and in `siteyctl route add` when a route lands on
  the panel's hostname.
