const API_URL = "https://api.namecheap.com/xml.response";

interface HostRecord {
  Name: string;
  Type: string;
  Address: string;
  MXPref: string;
  TTL: string;
}

/** Parse <host .../> elements from Namecheap XML response. */
function parseHosts(xml: string): HostRecord[] {
  const records: HostRecord[] = [];
  const hostRe = /<host\s+([^>]+?)\s*\/>/gi;
  const attrRe = /(\w+)="([^"]*)"/g;
  let hostMatch: RegExpExecArray | null;
  while ((hostMatch = hostRe.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    attrRe.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRe.exec(hostMatch[1])) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    if (attrs.Name) {
      records.push({
        Name: attrs.Name,
        Type: attrs.Type ?? "A",
        Address: attrs.Address ?? "",
        MXPref: attrs.MXPref ?? "10",
        TTL: attrs.TTL ?? "1800",
      });
    }
  }
  return records;
}

async function apiRequest(params: Record<string, string>): Promise<string> {
  const url = new URL(API_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const text = await res.text();
  if (text.includes('Status="ERROR"')) {
    throw new Error(`Namecheap API error:\n${text}`);
  }
  return text;
}

/**
 * Upsert wildcard A records for a subdomain on a Namecheap-managed domain.
 *
 * Creates (or replaces) two A records pointing to `ip`:
 *   - `*.subdomain.sld.tld`  – wildcard for all sub-subdomains
 *   - `subdomain.sld.tld`    – bare subdomain
 *
 * All other host records on the domain are fetched first and preserved
 * so unrelated records are not overwritten.
 *
 * @param opts.apiUser   - Namecheap account username.
 * @param opts.apiKey    - Namecheap API key.
 * @param opts.clientIp  - Caller's public IP, must be whitelisted in Namecheap API settings.
 * @param opts.sld       - Second-level domain (e.g. "example" for example.com).
 * @param opts.tld       - Top-level domain (e.g. "com").
 * @param opts.subdomain - Subdomain label (e.g. "test" to configure *.test.example.com).
 * @param opts.ip        - IPv4 address the records should point to.
 */
export async function setWildcardRecord(opts: {
  apiUser: string;
  apiKey: string;
  clientIp: string;
  sld: string;
  tld: string;
  subdomain: string;
  ip: string;
}): Promise<void> {
  const { apiUser, apiKey, clientIp, sld, tld, subdomain, ip } = opts;
  const base = {
    ApiUser: apiUser,
    ApiKey: apiKey,
    UserName: apiUser,
    ClientIp: clientIp,
    SLD: sld,
    TLD: tld,
  };

  // Get existing records so we don't nuke unrelated ones.
  const getXml = await apiRequest({
    ...base,
    Command: "namecheap.domains.dns.getHosts",
  });
  const existing = parseHosts(getXml);

  // Remove old records for our subdomain; we'll add fresh ones.
  const keep = existing.filter(
    (r) => r.Name !== `*.${subdomain}` && r.Name !== subdomain,
  );

  const newRecords: HostRecord[] = [
    ...keep,
    {
      Name: `*.${subdomain}`,
      Type: "A",
      Address: ip,
      MXPref: "10",
      TTL: "300",
    },
    { Name: subdomain, Type: "A", Address: ip, MXPref: "10", TTL: "300" },
  ];

  const setParams: Record<string, string> = {
    ...base,
    Command: "namecheap.domains.dns.setHosts",
  };
  newRecords.forEach((r, i) => {
    const n = i + 1;
    setParams[`HostName${n}`] = r.Name;
    setParams[`RecordType${n}`] = r.Type;
    setParams[`Address${n}`] = r.Address;
    setParams[`MXPref${n}`] = r.MXPref;
    setParams[`TTL${n}`] = r.TTL;
  });

  await apiRequest(setParams);
}

/**
 * Remove the wildcard A records previously created by {@link setWildcardRecord}.
 *
 * Deletes `*.subdomain.sld.tld` and `subdomain.sld.tld` from the domain's
 * DNS, leaving all other host records intact. If neither record exists this
 * is a no-op (no API write is made).
 *
 * @param opts.apiUser   - Namecheap account username.
 * @param opts.apiKey    - Namecheap API key.
 * @param opts.clientIp  - Caller's public IP, must be whitelisted in Namecheap API settings.
 * @param opts.sld       - Second-level domain (e.g. "example" for example.com).
 * @param opts.tld       - Top-level domain (e.g. "com").
 * @param opts.subdomain - Subdomain label used when the records were created.
 */
export async function deleteWildcardRecord(opts: {
  apiUser: string;
  apiKey: string;
  clientIp: string;
  sld: string;
  tld: string;
  subdomain: string;
}): Promise<void> {
  const { apiUser, apiKey, clientIp, sld, tld, subdomain } = opts;
  const base = {
    ApiUser: apiUser,
    ApiKey: apiKey,
    UserName: apiUser,
    ClientIp: clientIp,
    SLD: sld,
    TLD: tld,
  };

  const getXml = await apiRequest({
    ...base,
    Command: "namecheap.domains.dns.getHosts",
  });
  const existing = parseHosts(getXml);
  const keep = existing.filter(
    (r) => r.Name !== `*.${subdomain}` && r.Name !== subdomain,
  );

  // If nothing changed, skip the write.
  if (keep.length === existing.length) return;

  const setParams: Record<string, string> = {
    ...base,
    Command: "namecheap.domains.dns.setHosts",
  };
  keep.forEach((r, i) => {
    const n = i + 1;
    setParams[`HostName${n}`] = r.Name;
    setParams[`RecordType${n}`] = r.Type;
    setParams[`Address${n}`] = r.Address;
    setParams[`MXPref${n}`] = r.MXPref;
    setParams[`TTL${n}`] = r.TTL;
  });

  await apiRequest(setParams);
}
