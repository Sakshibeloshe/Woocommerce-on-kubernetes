// SSRF guard for upstream URLs that admins register.
//
// The problem: the gateway makes HTTP requests to URLs typed in by an admin. A malicious
// (or compromised) admin account could point it at things it must never talk to:
// the cloud metadata service (169.254.169.254: cloud credentials!), the gateway's own
// pod (127.0.0.1), the Kubernetes API, or the gateway's database.
//
// The policy (allowlist for internal, denylist for the rest):
//   - ALWAYS blocked: loopback, link-local (incl. metadata), unspecified, multicast.
//   - Private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) are blocked,
//     EXCEPT for in-cluster Services in explicitly allowed namespaces, written as
//     "<service>.<namespace>.svc[.cluster.local]". Our own upstreams live there
//     (store, mcp-servers), so they keep working; postgres.gateway.svc or
//     kubernetes.default.svc are refused.
//   - Public addresses are allowed (remote MCP servers on the internet).
//
// It is enforced twice:
//   1. When a URL is saved (clear 400 error for the admin).
//   2. At CONNECT time, on the IP actually being connected to. That defeats DNS
//      rebinding (a name that resolved to a public IP at save time and to 127.0.0.1
//      later) and redirects to internal addresses.
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { config } from "./config.js";

const blocked = new BlockList();
blocked.addSubnet("127.0.0.0", 8);          // loopback
blocked.addSubnet("0.0.0.0", 8);            // "this host"
blocked.addSubnet("169.254.0.0", 16);       // link-local, incl. cloud metadata 169.254.169.254
blocked.addSubnet("224.0.0.0", 4);          // multicast
blocked.addAddress("255.255.255.255");
blocked.addAddress("::1", "ipv6");
blocked.addAddress("::", "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");    // link-local
blocked.addSubnet("ff00::", 8, "ipv6");     // multicast

const privateNets = new BlockList();
privateNets.addSubnet("10.0.0.0", 8);       // includes k3s pod (10.42/16) and service (10.43/16) ranges
privateNets.addSubnet("172.16.0.0", 12);
privateNets.addSubnet("192.168.0.0", 16);
privateNets.addSubnet("100.64.0.0", 10);    // carrier-grade NAT
privateNets.addSubnet("fc00::", 7, "ipv6"); // unique local

function classify(ip: string): "blocked" | "private" | "public" {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];   // IPv4-mapped IPv6
  const addr = mapped ?? ip;
  const family = isIP(addr) === 6 ? "ipv6" : "ipv4";
  if (blocked.check(addr, family)) return "blocked";
  if (privateNets.check(addr, family)) return "private";
  return "public";
}

/** Is this hostname an in-cluster Service in an allowed namespace? */
function isAllowedInternalHost(hostname: string): boolean {
  const m = hostname.toLowerCase().match(/^[a-z0-9-]+\.([a-z0-9-]+)\.svc(\.cluster\.local)?\.?$/);
  return !!m && (config.ssrf.allowedNamespaces.includes(m[1]) || /^store-[a-z][a-z0-9-]*-[a-f0-9]{8}$/.test(m[1]));
}

/** null = allowed, otherwise the reason it isn't. */
export function checkAddresses(hostname: string, ips: string[]): string | null {
  for (const ip of ips) {
    const kind = classify(ip);
    if (kind === "blocked") return `${hostname} resolves to ${ip}, a loopback/link-local/metadata address`;
    if (kind === "private" && !isAllowedInternalHost(hostname) && !config.ssrf.allowPrivateNetworks) {
      return `${hostname} resolves to private address ${ip}. Internal upstreams must be Services in an allowed namespace (${config.ssrf.allowedNamespaces.join(", ") || "none"}), written as <service>.<namespace>.svc`;
    }
  }
  return null;
}

const resolveAll = (hostname: string) =>
  new Promise<string[]>((resolve, reject) =>
    dnsLookup(hostname, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address)))));

/** Check 1: when an admin saves a URL. Returns a reason string if refused. */
export async function validateUpstreamUrl(raw: string): Promise<string | null> {
  let url: URL;
  try { url = new URL(raw); } catch { return "Not a valid URL"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https URLs are allowed";
  if (url.username || url.password) return "Put credentials in the credential field, not in the URL";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return checkAddresses(host, [host]);
  try {
    return checkAddresses(host, await resolveAll(host));
  } catch {
    return `Cannot resolve host ${host}`;
  }
}

// Check 2: at connect time. undici calls this lookup for every new connection,
// and connects to exactly the address we approve (no second DNS query to race).
type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
function guardedLookup(hostname: string, options: { all?: boolean }, callback: LookupCb) {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return callback(err, []);
    const reason = checkAddresses(hostname, addrs.map((a) => a.address));
    if (reason) return callback(Object.assign(new Error(`Blocked by SSRF policy: ${reason}`), { code: "ESSRF" }), []);
    if (options.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
}

const agent = new Agent({ connect: { lookup: guardedLookup as never } });
const MAX_REDIRECTS = 3;

/** fetch() for upstream MCP traffic: SSRF-checked on every connection and every redirect. */
export async function guardedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  let url = new URL(String(input));
  for (let hop = 0; ; hop++) {
    // IP-literal URLs skip DNS, so the lookup hook never sees them: check them here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) {
      const reason = checkAddresses(host, [host]);
      if (reason) throw Object.assign(new Error(`Blocked by SSRF policy: ${reason}`), { code: "ESSRF" });
    }
    const res = (await undiciFetch(url, { ...(init as object), dispatcher: agent, redirect: "manual" })) as unknown as Response;
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
      url = new URL(location, url);   // follow ourselves, so every hop is checked
      continue;
    }
    return res;
  }
}
