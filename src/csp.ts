import { createHash } from "node:crypto";
import { parseHtml } from "./htmlscan.js";

/* ------------------------------- CSP generation ------------------------------- */

export interface CspOptions {
  /** The page's own URL, so same-origin resources become 'self'. */
  pageUrl?: string;
  mode?: "report-only" | "enforce";
  /** Allow style="" attributes (CSP3 style-src-attr 'unsafe-inline'). Default true. */
  allowInlineStyleAttributes?: boolean;
}

export interface HashEntry {
  hash: string;
  preview: string;
}

export interface CspResult {
  headerName: string;
  header: string;
  directives: Record<string, string[]>;
  hashes: { script: HashEntry[]; style: HashEntry[] };
  notes: string[];
}

const sha256 = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
const preview = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 48);
const EXECUTABLE = new Set(["", "text/javascript", "application/javascript", "module", "text/ecmascript", "application/ecmascript"]);

export function generateCsp(html: string, opts: CspOptions = {}): CspResult {
  const p = parseHtml(html);
  const base = opts.pageUrl ?? "https://page.invalid/";
  let pageOrigin: string;
  try {
    pageOrigin = new URL(base).origin;
  } catch {
    throw new Error(`"${opts.pageUrl}" is not a valid URL.`);
  }
  const https = new URL(base).protocol === "https:";

  const source = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const v = raw.trim();
    if (!v || v.startsWith("#") || /^(javascript|mailto|tel|about|blob):/i.test(v)) return null;
    if (/^data:/i.test(v)) return "data:";
    try {
      const u = new URL(v.startsWith("//") ? "https:" + v : v, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.origin === pageOrigin ? "'self'" : u.origin;
    } catch {
      return null;
    }
  };
  const srcsetUrls = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);

  const d: Record<string, Set<string>> = {
    "script-src": new Set(["'self'"]), "style-src": new Set(["'self'"]), "img-src": new Set(["'self'"]),
    "font-src": new Set(["'self'"]), "connect-src": new Set(["'self'"]), "media-src": new Set(["'self'"]),
    "frame-src": new Set(), "object-src": new Set(), "form-action": new Set(["'self'"]),
  };
  const add = (dir: string, raw: string | undefined) => {
    const s = source(raw);
    if (s) d[dir].add(s);
  };

  let hasMedia = false, hasObject = false, styleAttrs = 0, handlers = 0, googleFonts = false;
  for (const t of p.tags) {
    for (const a of Object.keys(t.attrs)) if (/^on[a-z]+$/.test(a)) handlers++;
    if ("style" in t.attrs) styleAttrs++;
    const rel = (t.attrs.rel ?? "").toLowerCase();
    switch (t.name) {
      case "script": add("script-src", t.attrs.src); break;
      case "link":
        if (rel.includes("stylesheet")) {
          add("style-src", t.attrs.href);
          if (/fonts\.googleapis\.com/i.test(t.attrs.href ?? "")) googleFonts = true;
        } else if (rel.includes("preload") || rel.includes("prefetch")) {
          const as = (t.attrs.as ?? "").toLowerCase();
          add(as === "font" ? "font-src" : as === "style" ? "style-src" : as === "script" ? "script-src" : as === "image" ? "img-src" : "connect-src", t.attrs.href);
        } else if (rel.includes("icon")) add("img-src", t.attrs.href);
        break;
      case "img": add("img-src", t.attrs.src); srcsetUrls(t.attrs.srcset).forEach((u) => add("img-src", u)); break;
      case "source": if (t.attrs.srcset) srcsetUrls(t.attrs.srcset).forEach((u) => add("img-src", u)); else { hasMedia = true; add("media-src", t.attrs.src); } break;
      case "video": case "audio": hasMedia = true; add("media-src", t.attrs.src); add("img-src", t.attrs.poster); break;
      case "iframe": add("frame-src", t.attrs.src); break;
      case "object": hasObject = true; add("object-src", t.attrs.data); break;
      case "embed": hasObject = true; add("object-src", t.attrs.src); break;
      case "form": add("form-action", t.attrs.action); break;
    }
  }
  if (googleFonts) d["font-src"].add("https://fonts.gstatic.com");

  const hashes = { script: [] as HashEntry[], style: [] as HashEntry[] };
  for (const s of p.scripts) {
    if (s.attrs.src || !EXECUTABLE.has((s.attrs.type ?? "").toLowerCase()) || !s.content.trim()) continue;
    hashes.script.push({ hash: sha256(s.content), preview: preview(s.content) });
  }
  for (const s of p.styles) if (s.content.trim()) hashes.style.push({ hash: sha256(s.content), preview: preview(s.content) });
  hashes.script.forEach((h) => d["script-src"].add(h.hash));
  hashes.style.forEach((h) => d["style-src"].add(h.hash));

  const order = (set: Set<string>) => [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const rank = (v: string) => (v === "'self'" ? 0 : v.startsWith("'sha256-") ? 3 : v.endsWith(":") ? 2 : 1);

  const directives: Record<string, string[]> = { "default-src": ["'self'"] };
  directives["script-src"] = order(d["script-src"]);
  directives["style-src"] = order(d["style-src"]);
  if (styleAttrs && opts.allowInlineStyleAttributes !== false) directives["style-src-attr"] = ["'unsafe-inline'"];
  directives["img-src"] = order(d["img-src"]);
  directives["font-src"] = order(d["font-src"]);
  directives["connect-src"] = order(d["connect-src"]);
  if (hasMedia) directives["media-src"] = order(d["media-src"]);
  directives["frame-src"] = d["frame-src"].size ? order(d["frame-src"]) : ["'none'"];
  directives["object-src"] = hasObject && d["object-src"].size ? order(d["object-src"]) : ["'none'"];
  directives["base-uri"] = ["'self'"];
  directives["form-action"] = order(d["form-action"]);
  directives["frame-ancestors"] = ["'self'"];
  if (https) directives["upgrade-insecure-requests"] = [];

  const header = Object.entries(directives).map(([k, v]) => [k, ...v].join(" ")).join("; ");
  const reportOnly = (opts.mode ?? "report-only") === "report-only";
  const notes: string[] = [
    "Only resources written in the HTML are known. Scripts, fonts and data that JavaScript loads later (APIs, analytics, widgets) are not, so add them to the matching directive (usually connect-src) when the browser console reports a violation.",
    reportOnly ? "This is a report-only policy: nothing is blocked. Browse the site, fix the console reports, then switch to enforcement." : "This policy will block anything it does not list. Test every page first, ideally in report-only mode.",
  ];
  if (hashes.script.length || hashes.style.length) notes.push("Hashes only match the exact inline text. Changing a single character, or a build step that rewrites the block, means the hash must be regenerated. For server-rendered pages, per-request nonces are sturdier.");
  if (handlers) notes.push(`${handlers} inline event handler${handlers > 1 ? "s (onclick and similar) are" : " (onclick or similar) is"} blocked by this policy. Replace ${handlers > 1 ? "them" : "it"} with addEventListener in a script file.`);
  if (styleAttrs && opts.allowInlineStyleAttributes === false) notes.push(`${styleAttrs} style="" attribute${styleAttrs > 1 ? "s are" : " is"} blocked. Move them into a stylesheet.`);
  if (styleAttrs && opts.allowInlineStyleAttributes !== false) notes.push(`${styleAttrs} style="" attribute${styleAttrs > 1 ? "s" : ""} allowed through style-src-attr 'unsafe-inline' (modern browsers). Moving them into stylesheets would let you drop it.`);
  if (!opts.pageUrl) notes.push("No page URL was given, so every absolute URL counts as another origin and relative URLs count as 'self'.");
  return { headerName: reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", header, directives, hashes, notes };
}

export function formatCsp(r: CspResult): string {
  const fence = "`".repeat(3);
  const lines = [
    "## Content-Security-Policy",
    `${fence}http`,
    `${r.headerName}: ${r.header}`,
    fence,
    "",
    "### Directives",
    ...Object.entries(r.directives).map(([k, v]) => `- \`${k}\`: ${v.length ? v.map((x) => `\`${x}\``).join(" ") : "(flag, no value)"}`),
  ];
  const hs = [...r.hashes.script.map((h) => ({ ...h, kind: "script" })), ...r.hashes.style.map((h) => ({ ...h, kind: "style" }))];
  if (hs.length) lines.push("", "### Inline blocks allowed by hash", ...hs.map((h) => `- ${h.kind}: \`${h.preview}\` → \`${h.hash}\``));
  lines.push("", "### Before you ship it", ...r.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}

/* ---------------------------- Security header files ---------------------------- */

export const HEADER_PLATFORMS = ["netlify", "cloudflare-pages", "vercel", "nginx", "apache", "caddy", "express"] as const;
export type HeaderPlatform = (typeof HEADER_PLATFORMS)[number];

export interface HeaderOptions {
  csp?: string;
  cspMode?: "report-only" | "enforce";
  hstsPreload?: boolean;
  frame?: "deny" | "sameorigin";
  /** Adds Cross-Origin-Resource-Policy: same-site. Breaks other sites embedding your assets. */
  isolateCrossOrigin?: boolean;
}

export function securityHeaderList(o: HeaderOptions = {}): [string, string][] {
  const list: [string, string][] = [
    ["Strict-Transport-Security", `max-age=31536000; includeSubDomains${o.hstsPreload ? "; preload" : ""}`],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", (o.frame ?? "deny").toUpperCase()],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
  ];
  if (o.isolateCrossOrigin) list.push(["Cross-Origin-Resource-Policy", "same-site"]);
  if (o.csp) {
    if (o.csp.length > 4000 || !/^[\x20-\x7E]+$/.test(o.csp) || /["\\$`]/.test(o.csp)) {
      throw new Error('The CSP must be one line of printable ASCII, at most 4000 characters, without double quotes, backslashes, "$" or backticks (they could break out of the config file).');
    }
    list.push([(o.cspMode ?? "report-only") === "report-only" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", o.csp]);
  }
  return list;
}

export function generateSecurityHeaders(platform: HeaderPlatform, o: HeaderOptions = {}): { config: string; filename: string; notes: string[] } {
  const hs = securityHeaderList(o);
  let config: string;
  let filename: string;
  switch (platform) {
    case "netlify":
    case "cloudflare-pages":
      filename = "_headers";
      config = ["/*", ...hs.map(([k, v]) => `  ${k}: ${v}`)].join("\n");
      break;
    case "vercel":
      filename = "vercel.json";
      config = JSON.stringify({ headers: [{ source: "/(.*)", headers: hs.map(([key, value]) => ({ key, value })) }] }, null, 2);
      break;
    case "nginx":
      filename = "your server { } block";
      config = ["server_tokens off;", ...hs.map(([k, v]) => `add_header ${k} "${v}" always;`), 'proxy_hide_header X-Powered-By;  # only if you proxy to another app'].join("\n");
      break;
    case "apache":
      filename = ".htaccess or your VirtualHost";
      config = ["ServerTokens Prod  # server config only, not .htaccess", "<IfModule mod_headers.c>", ...hs.map(([k, v]) => `  Header always set ${k} "${v}"`), "  Header always unset X-Powered-By", "</IfModule>"].join("\n");
      break;
    case "caddy":
      filename = "Caddyfile (inside your site block)";
      config = ["header {", ...hs.map(([k, v]) => `    ${k} "${v}"`), "    -Server", "    -X-Powered-By", "}"].join("\n");
      break;
    case "express":
      filename = "your Express app";
      config = ['app.disable("x-powered-by");', "app.use((req, res, next) => {", ...hs.map(([k, v]) => `  res.setHeader(${JSON.stringify(k)}, ${JSON.stringify(v)});`), "  next();", "});"].join("\n");
      break;
  }
  const notes = [
    "Strict-Transport-Security only takes effect over HTTPS, and browsers remember it for a year. Make sure every subdomain supports HTTPS before using includeSubDomains.",
    o.hstsPreload ? "HSTS preload is very hard to undo (removal takes months). Only keep it if you intend to submit the domain to the preload list." : "HSTS preload is left off on purpose, because it is very hard to undo. Add it later if you want browsers to ship your domain as HTTPS-only.",
    "Cross-Origin-Opener-Policy: same-origin can break pop-up based sign-in (OAuth) and window.opener tricks. Test your login flow.",
    "X-Frame-Options is the older clickjacking header. Modern browsers use CSP frame-ancestors, so keep both.",
  ];
  if (!o.csp) notes.push("No Content-Security-Policy was included because a good one depends on your page. Use generate_csp, then pass its policy here.");
  else if ((o.cspMode ?? "report-only") === "report-only") notes.push("The CSP is report-only, so nothing is blocked yet. Switch cspMode to enforce once the console is clean.");
  if (platform === "nginx") notes.push("In nginx, add_header directives in a location block replace those from the server block. Repeat them there if you use location blocks with their own add_header.");
  return { config, filename, notes };
}

export function formatSecurityHeaders(platform: HeaderPlatform, r: { config: string; filename: string; notes: string[] }): string {
  const lang = platform === "vercel" ? "json" : platform === "express" ? "js" : platform === "apache" ? "apache" : platform === "nginx" ? "nginx" : "text";
  const fence = "`".repeat(3);
  return [`## Security headers for ${platform}`, `Put this in: ${r.filename}`, "", `${fence}${lang}`, r.config, fence, "", "### Notes", ...r.notes.map((n) => `- ${n}`)].join("\n");
}
