import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function assertHttp(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs are supported.");
  return u;
}

/* ------------------------- Network safety (SSRF protection) ------------------------- */

export type IpClass = "public" | "private" | "loopback" | "link-local" | "reserved";

function classifyV4([a, b, c]: number[]): IpClass {
  if (a === 0) return "reserved";
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // carrier-grade NAT
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local"; // includes cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved";
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  if (a >= 224) return "reserved"; // multicast, reserved and broadcast
  return "public";
}

function expandV6(ip: string): number[] | null {
  let s = ip;
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v4 = m[2].split(".").map(Number);
    if (v4.length !== 4 || v4.some((n) => !(n >= 0 && n <= 255))) return null;
    s = `${m[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const parts = s.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}

function classifyV6(ip: string): IpClass {
  const g = expandV6(ip);
  if (!g) return "reserved";
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const v4 = (hi: number, lo: number) => classifyV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (zero(0, 8)) return "reserved"; // ::
  if (zero(0, 7) && g[7] === 1) return "loopback"; // ::1
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0] & 0xfe00) === 0xfc00) return "private"; // unique local
  if ((g[0] & 0xff00) === 0xff00) return "reserved"; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "reserved"; // documentation
  return "public";
}

export function classifyIp(ip: string): IpClass {
  const clean = ip.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const kind = isIP(clean);
  if (kind === 4) return classifyV4(clean.split(".").map(Number));
  if (kind === 6) return classifyV6(clean);
  return "reserved";
}

const allowPrivate = () => /^(1|true|yes)$/i.test(process.env.RED_ALLOW_PRIVATE_URLS ?? "");

/**
 * Accepts only http(s) URLs whose host resolves to public addresses. Loopback and private networks
 * need RED_ALLOW_PRIVATE_URLS=1; link-local (cloud metadata) and reserved ranges are never allowed.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const u = assertHttp(raw);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await lookup(host, { all: true, verbatim: true })).map((a: { address: string }) => a.address);
    } catch {
      throw new Error(`Could not resolve "${host}".`);
    }
  }
  if (!addrs.length) throw new Error(`Could not resolve "${host}".`);
  for (const a of addrs) {
    const c = classifyIp(a);
    const local = c === "private" || c === "loopback";
    if (c === "public" || (local && allowPrivate())) continue;
    throw new Error(
      `Blocked ${host} (${a}, ${c} address). ` +
        (local
          ? "Private and local addresses are blocked by default so that a prompt cannot make this server probe your network. Set RED_ALLOW_PRIVATE_URLS=1 to allow them, for example to capture your own dev server."
          : "This address range is never allowed.")
    );
  }
  return u;
}

export interface Hop {
  url: string;
  status: number;
  location?: string;
}

export interface ChainResult {
  res: Response;
  finalUrl: string;
  /** Every redirect that was followed, in order. */
  chain: Hop[];
}

/** fetch() that validates the URL and every redirect hop before connecting, and records the hops. */
export async function fetchWithChain(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<ChainResult> {
  let current = url;
  const chain: Hop[] = [];
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, current).href;
      chain.push({ url: current, status: res.status, location: next });
      current = next;
      continue;
    }
    return { res, finalUrl: current, chain };
  }
  throw new Error("Too many redirects.");
}

/** fetch() that validates the URL and every redirect hop before connecting. */
export async function safeFetch(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  return (await fetchWithChain(url, init, maxRedirects)).res;
}

/** Set-Cookie values as separate strings (fetch merges them in some runtimes). */
export function getSetCookies(h: Headers): string[] {
  const fn = (h as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof fn === "function") return fn.call(h);
  const raw = h.get("set-cookie");
  return raw ? raw.split(/,(?=\s*[^;,\s=]+=)/) : [];
}

export interface PageFetch {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  chain: Hop[];
  /** Lower-case header names. */
  headers: Record<string, string>;
  setCookies: string[];
  contentType: string;
  /** Only read for HTML responses, capped at 2 MB. */
  body?: string;
}

/** Add https:// when a bare domain is given. */
export const withScheme = (u: string) => (/^[a-z][a-z0-9+.-]*:/i.test(u.trim()) ? u.trim() : `https://${u.trim()}`);

/** One GET of a public page: headers, cookies, redirect chain and (for HTML) the markup. */
export async function fetchPage(url: string, timeoutMs = 15000): Promise<PageFetch> {
  const requestedUrl = withScheme(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const { res, finalUrl, chain } = await fetchWithChain(requestedUrl, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; red-design-mcp)", accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (key !== "set-cookie") headers[key] = headers[key] ? `${headers[key]}, ${v}` : v;
    });
    const contentType = headers["content-type"] ?? "";
    let body: string | undefined;
    if (/html/i.test(contentType)) body = (await readBytes(res, 2_000_000)).toString("utf8");
    else await res.body?.cancel();
    return { requestedUrl, finalUrl, status: res.status, chain, headers, setCookies: getSetCookies(res.headers), contentType, body };
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error(`Timed out after ${timeoutMs / 1000}s fetching ${requestedUrl}.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body without letting it grow past `max` bytes. */
export async function readBytes(res: Response, max: number): Promise<Buffer> {
  const tooBig = () => new Error(`Response is larger than ${Math.round(max / 1_000_000)} MB.`);
  const declared = Number(res.headers.get("content-length"));
  if (declared && declared > max) throw tooBig();
  if (!res.body) {
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > max) throw tooBig();
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; red-design-mcp)", accept: "text/html,text/css,*/*" },
    });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return (await readBytes(res, 2_000_000)).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

/** Collect inline <style> blocks and up to 8 linked stylesheets from a page. */
export async function collectCss(pageUrl: string): Promise<{ css: string; sheets: number }> {
  const base = assertHttp(pageUrl);
  const html = await fetchText(base.href);
  let css = "";
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css += "\n" + m[1];

  const hrefs: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const h = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!h) continue;
    try {
      hrefs.push(new URL(h[1], base).href);
    } catch {
      /* ignore bad href */
    }
  }
  // Each stylesheet URL goes through the same public-address check as the page itself.
  const results = await Promise.allSettled([...new Set(hrefs)].slice(0, 8).map((h) => fetchText(h)));
  let sheets = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      css += "\n" + r.value;
      sheets++;
    }
  }
  return { css, sheets };
}
