# Ports and management access

## Policy

Only Caddy publishes public application traffic on the VPS: TCP ports 80
and 443. Sitey-managed application containers never publish host ports. Caddy
reaches server applications by container name and internal port on the
`sitey-public` Docker bridge network. Static sites are served directly by Caddy.

| Listener                          | Reachable from                                               | Purpose                                            |
| --------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| Host TCP 80/443                   | Internet, subject to the VPS network firewall                | Caddy: HTTP routing, certificate challenges, HTTPS |
| App container port, such as 3000  | Docker host and containers on the shared application network | Caddy's upstream connection                        |
| Sitey API container port 3001     | Docker network; authenticated public API through Caddy       | Panel and CLI operations                           |
| `/run/caddy-admin/admin.sock`     | Caddy and the Sitey API, through a dedicated named volume    | Caddy configuration updates                        |
| Development host `127.0.0.1:2019` | Local machine                                                | Optional development-only Caddy admin access       |

SSH remains an installation/recovery concern; this policy does not change the
host's SSH configuration. UDP 443 is not published by the current Compose file.

## Listening inside a container versus publishing on the host

An app should normally listen on `0.0.0.0` **inside its container** so Caddy can
reach it over the Docker network. Listening on the container's `127.0.0.1` would
only accept connections originating inside that same container.

Docker's `HostIp: "0.0.0.0"` port binding is different: it publishes the app on
all IPv4 interfaces of the VPS. That permits direct requests to
`http://<vps-ip>:<port>`, bypassing Caddy's TLS termination, routing, and access
logging. A Dockerfile `EXPOSE` declaration does not by itself publish a host
port. See
[Docker port publishing](https://docs.docker.com/engine/network/port-publishing/).

Sitey therefore creates runtime containers with empty `PortBindings` and
`PublishAllPorts: false`. The CLI's `--port` selects the app's internal
listening port; it never opens a host port. We do not change Docker's
daemon-wide defaults: other workloads may intentionally publish ports, and
defaults would not override an explicit host binding anyway.

## An app without a route stays private

There is no automatic fallback URL or allocated public port. A deployment can
succeed without a route, but that means the build/container is ready, not that a
landing page has launched. Add a hostname route to expose it through Caddy.
`siteyctl status` reports a service without probeable routes as not live.

`services.create` accepts initial route strings and saves the service, routes,
and initial deployment together in one database transaction. Only after commit
does it enqueue the deployment. The CLI sends all `--route` arguments in this
request. Route conflicts roll back creation instead of leaving a partial launch.
Independently of that ordering, Docker never publishes an application's ports.

Direct public ports and loopback-only debug ports are not currently supported
Sitey features. If needed later, they should be explicit operations with their
own access policy; absence of a domain must not enable them implicitly.

## Caddy's admin API is a separate trust boundary

The Caddy admin API can replace routing configuration and must not be available
to applications being hosted. Leaving TCP 2019 unpublished on the host is not
sufficient: containers sharing Caddy's network could still connect to it.

Production Caddy listens for administration on a Unix socket, following
[Caddy's documented socket configuration](https://caddyserver.com/docs/caddyfile/options#admin).
The `caddy_admin` volume is mounted only into Caddy and `sitey-api`, at
`/run/caddy-admin`. Application and build containers receive no socket mount.
The API uses `CADDY_ADMIN_SOCKET=/run/caddy-admin/admin.sock` for `/load`
requests; its generated configuration retains the socket listener. Production
startup and configuration generation reject a missing socket setting instead of
falling back to TCP administration. The existing `CADDY_ADMIN_URL` is used for
local mock/TCP administration and as the default hostname for TLS probes, not
production reloads.

The development Compose override explicitly enables TCP administration and binds
host port 2019 to `127.0.0.1`. Its shared container network is trusted
development infrastructure, not a boundary for untrusted hosted applications.
Use the production configuration when running such applications.

The application bridge itself is still shared: apps can contact other apps and
the authenticated Sitey API. This is not tenant isolation. API tokens and access
to the Docker socket remain root-equivalent administrative capabilities.

## Applying the policy to existing installations

Updating creation defaults cannot remove port bindings from an existing
container. Before the production API accepts requests, it inspects existing
Sitey runtime containers and recreates those with published ports, using their
existing image, environment, command, and host configuration with port
publishing removed.

- This briefly interrupts each affected server app. Static sites are unaffected.
- Named `/data` volumes and images are retained. As with normal redeployment,
  applications must store persistent data in `/data`, not their disposable
  container filesystem.
- Previously running active services are started again. Stopped services remain
  stopped. Legacy `hostPort` database values are cleared.
- Before stopping an old container, its restart policy is disabled so it cannot
  reopen public ports after a restart. If replacement fails, the app remains
  stopped with a failed status; logs identify it for redeployment. The old image
  and named data volume remain available.
- Failure to inspect or close old bindings aborts startup rather than silently
  declaring an unsafe upgrade successful. Resolve Docker access and restart the
  API. A later API restart retries inspection.

Deploy the updated Compose configuration along with the API and Caddy config:
both services need the shared admin-socket volume. A normal
`docker compose up -d --build` recreates services whose Compose configuration
changed. Rebuilding only the API image against the old Compose configuration is
insufficient.

## Firewalls and verification

Keep the VPS/network firewall restricted to intended inbound traffic as
additional protection. Ordinary UFW rules are not a substitute for avoiding
publication: Docker installs forwarding rules that can bypass UFW's normal input
filtering. See
[Docker firewall documentation](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

After an upgrade, inspect Docker's published ports: only Caddy should publish
80/443 among Sitey's containers. Runtime containers should have no host
bindings, and production Caddy should have no TCP admin listener. From outside
the VPS, former fallback ports should refuse connections or be filtered.

Launch verification checks deployment success, TLS, the HTTP response, the
absence of `X-Sitey-Pending`, and `X-Sitey-Service` matching the expected
numeric service ID. Caddy sets the service header within the matching route and
overrides upstream values. This catches accidentally probing the panel or
another service; it is an operational routing marker, not a cryptographic
attestation of page content.
