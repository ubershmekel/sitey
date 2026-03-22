const BASE = "https://api.hetzner.cloud/v1";

export interface HetznerServer {
  id: number;
  ip: string;
}

async function apiFetch(
  token: string,
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  if (!res.ok) {
    throw new Error(
      `Hetzner ${opts.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`,
    );
  }
  return res;
}

/**
 * Provision a new Ubuntu 24.04 server on Hetzner Cloud.
 *
 * @param opts.token     - Hetzner Cloud API token (Read & Write).
 * @param opts.name      - Display name for the server (must be unique in the project).
 * @param opts.serverType - Server type slug, e.g. "cx22", "cpx21".
 * @param opts.location  - Datacenter location slug, e.g. "nbg1", "hel1", "ash".
 * @param opts.sshKey    - Name or numeric ID of an SSH key already registered in Hetzner Cloud.
 * @returns The new server's numeric ID and its public IPv4 address.
 */
export async function createServer(opts: {
  token: string;
  name: string;
  serverType: string;
  location: string;
  sshKey: string;
}): Promise<HetznerServer> {
  const res = await apiFetch(opts.token, "/servers", {
    method: "POST",
    body: JSON.stringify({
      name: opts.name,
      server_type: opts.serverType,
      image: "ubuntu-24.04",
      location: opts.location,
      ssh_keys: [opts.sshKey],
    }),
  });
  const data = (await res.json()) as {
    server: { id: number; public_net: { ipv4: { ip: string } } };
  };
  return { id: data.server.id, ip: data.server.public_net.ipv4.ip };
}

/**
 * Permanently delete a Hetzner Cloud server by its numeric ID.
 * Throws if the API call fails (e.g. server not found or auth error).
 *
 * @param token - Hetzner Cloud API token (Read & Write).
 * @param id    - Numeric server ID returned by {@link createServer}.
 */
export async function deleteServer(token: string, id: number): Promise<void> {
  await apiFetch(token, `/servers/${id}`, { method: "DELETE" });
}
