/** SSRF guard for model- and user-chosen URLs: public http(s) only. */

/** Names that only resolve inside a network (mDNS, cloud metadata, home routers). */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet"];
/** Wildcard DNS: these resolve a name to whatever address it spells, e.g. 127.0.0.1.nip.io. */
const WILDCARD_DNS = /(^|\.)(nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me|lvh\.me)$/;

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function privateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** IPv6 literals (as URL normalizes them, brackets removed) that aren't plain global addresses. */
function privateIpv6(host: string): boolean {
  return (
    host.startsWith("::") || // unspecified, loopback, IPv4-compatible and IPv4-mapped (::ffff:…)
    /^f[cd]/.test(host) || // unique local
    /^fe[89ab]/.test(host) || // link-local
    host.startsWith("ff") || // multicast
    host.startsWith("64:ff9b:") || // NAT64, which embeds an IPv4 address
    host.startsWith("2002:") // 6to4, likewise
  );
}

/** True for hosts that name a private, local or reserved address. DNS isn't resolved here. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) return privateIpv6(host.slice(1, -1));
  const v4 = ipv4(host);
  if (v4) return privateIpv4(v4);
  if (host === "localhost" || !host.includes(".")) return true;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || WILDCARD_DNS.test(host)) return true;
  // A name that spells a private address up front (10.0.0.1.example.com), as wildcard DNS does.
  const lead = ipv4(host.split(".").slice(0, 4).join("."));
  return lead !== null && privateIpv4(lead);
}

export function publicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("Only http(s) URLs can be read.");
  if (isPrivateHost(u.hostname)) throw new Error("Private and local addresses can't be read.");
  if (u.username || u.password) throw new Error("URLs with credentials can't be read.");
  return u;
}

/**
 * fetch for a URL the model or user chose: every redirect is checked like the first address
 * instead of being followed wherever it points.
 */
export async function fetchPublic(
  raw: string,
  init: RequestInit = {},
  maxRedirects = 5
): Promise<Response> {
  let url = publicUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.type === "opaqueredirect")
      throw new Error("This page redirects somewhere that can't be checked.");
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    void res.body?.cancel().catch(() => undefined);
    if (hop >= maxRedirects) throw new Error("Too many redirects.");
    url = publicUrl(new URL(location, url).toString());
  }
}

/** Provider base URLs may be private (LM Studio at home) but never cloud metadata endpoints. */
export function providerUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Base URL must be a full URL, e.g. https://api.openai.com/v1");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new Error("Base URL must be http(s).");
  if (/^169\.254\./.test(u.hostname) || u.hostname === "metadata.google.internal") {
    throw new Error("That address isn't allowed.");
  }
  return u;
}
