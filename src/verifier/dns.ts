import dns from "node:dns/promises";
import { isIP } from "node:net";
import { promises as dnsLookup } from "node:dns";

const ipv4ByNumeric: Array<{ start: number; end: number }> = [
  { start: 0x00000000, end: 0x00ffffff }, // 0.0.0.0/8 current network
  { start: 0x0a000000, end: 0x0affffff }, // 10.0.0.0/8 private
  { start: 0x7f000000, end: 0x7fffffff }, // 127.0.0.0/8 loopback
  { start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16 link-local
  { start: 0xac100000, end: 0xac1fffff }, // 172.168.0.0/12 private
  { start: 0xc0a80000, end: 0xc0a8ffff }, // 192.168.0.0/16 private
  { start: 0xc0000200, end: 0xc00002ff }, // 192.0.2.0/24 TEST-NET
  { start: 0xc6336400, end: 0xc63364ff }, // 198.51.100.0/24 TEST-NET-2
  { start: 0xcb007100, end: 0xcb0071ff }, // 203.0.113.0/24 TEST-NET-3
  { start: 0x64400000, end: 0x647fffff }, // 100.64.0.0/10 Shared (CGNAT)
];

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const numeric =
    ((parts[0] << 24) >>> 0) +
    (parts[1] << 16) +
    (parts[2] << 8) +
    parts[3];
  for (const range of ipv4ByNumeric) {
    if (numeric >= range.start && numeric <= range.end) return true;
  }
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const loopback = lower === "::1" || lower === "::";
  const privateBlock =
    lower.startsWith("fc") || lower.startsWith("fd"); // fc00::/7 unique-local
  return loopback || privateBlock;
}

export function isPrivateOrReserved(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateIpv4(address);
  if (kind === 6) return isPrivateIpv6(address);
  return false;
}

export class DnsResolver {
  private mxCache: Map<string, string[]> = new Map();
  private timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DNS timeout")), this.timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  async resolveMx(domain: string): Promise<string[]> {
    const cached = this.mxCache.get(domain);
    if (cached) return cached;

    const records = await this.withTimeout(dns.resolveMx(domain));
    records.sort((a, b) => a.priority - b.priority);
    const hosts = records.map((r) => r.exchange);

    // SSRF guard: drop any MX resolving to a private/reserved IP.
    const publicHosts: string[] = [];
    for (const host of hosts) {
      let blocked = false;
      try {
        if (isIP(host) && isPrivateOrReserved(host)) {
          blocked = true;
        } else if (!isIP(host)) {
          const addresses = await dnsLookup.lookup(host, { all: true, verbatim: true });
          if (addresses.some((a) => isPrivateOrReserved(a.address))) blocked = true;
        }
      } catch {
        // resolution failure — still block-eligible to stay safe
        blocked = true;
      }
      if (!blocked) publicHosts.push(host);
    }

    this.mxCache.set(domain, publicHosts);
    return publicHosts;
  }
}
