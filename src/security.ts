import { parseHtml, decodeEntities, type Tag } from "./htmlscan.js";
import { scanSecrets } from "./secrets.js";

export type SecSeverity = "high" | "medium" | "low" | "info";
export interface SecurityFinding {
  sev: SecSeverity;
  area: "transport" | "headers" | "csp" | "cookies" | "content" | "privacy" | "disclosure";
  msg: string;
  fix?: string;
}

export interface SecurityInput {
  url: string;
  finalUrl: string;
  status: number;
  chain: { url: string; status: number; location?: string }[];
  /** Lower-case header names. */
  headers: Record<string, string>;
  setCookies: string[];
  body?: string;
  contentType?: string;
}

export interface SecurityReport {
  score: number;
  grade: string;
  findings: SecurityFinding[];
  good: string[];
  thirdParties: string[];
  trackers: { host: string; name: string }[];
}

/* --------------------------------- CSP parsing -------------------------------- */

export function parseCsp(value: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of value.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    if (!(name in out)) out[name] = tokens.slice(1);
  }
  return out;
}

const TRACKERS: [string, string][] = [
  ["google-analytics.com", "Google Analytics"], ["googletagmanager.com", "Google Tag Manager"], ["doubleclick.net", "Google Ads"],
  ["googlesyndication.com", "Google AdSense"], ["connect.facebook.net", "Meta Pixel"], ["facebook.com", "Meta"],
  ["hotjar.com", "Hotjar"], ["clarity.ms", "Microsoft Clarity"], ["segment.com", "Segment"], ["segment.io", "Segment"],
  ["mixpanel.com", "Mixpanel"], ["amplitude.com", "Amplitude"], ["fullstory.com", "FullStory"], ["intercom.io", "Intercom"],
  ["hs-scripts.com", "HubSpot"], ["hsforms.net", "HubSpot"], ["analytics.tiktok.com", "TikTok Pixel"], ["snap.licdn.com", "LinkedIn Insight"],
  ["ads-twitter.com", "X (Twitter) Ads"], ["ct.pinterest.com", "Pinterest Tag"], ["criteo.com", "Criteo"], ["taboola.com", "Taboola"],
  ["outbrain.com", "Outbrain"], ["nr-data.net", "New Relic"], ["cloudflareinsights.com", "Cloudflare Web Analytics"],
  ["plausible.io", "Plausible"], ["matomo.cloud", "Matomo"], ["heapanalytics.com", "Heap"], ["crazyegg.com", "Crazy Egg"],
];

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith("." + domain);

const URL_ATTRS: Record<string, string[]> = {
  script: ["src"], img: ["src"], iframe: ["src"], link: ["href"], source: ["src"], video: ["src", "poster"], audio: ["src"],
  embed: ["src"], object: ["data"], form: ["action"], a: ["href"],
};

/** Resolve an attribute URL against the page. Returns null for non-network values. */
function resolveUrl(raw: string | undefined, base: string): URL | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || /^(data|blob|javascript|mailto|tel|about|#)/i.test(v)) return null;
  try {
    return new URL(v.startsWith("//") ? "https:" + v : v, base);
  } catch {
    return null;
  }
}

const CRED_COOKIE = /(sess|sid|token|auth|jwt|login|csrf|xsrf|remember)/i;

export function analyzeSecurity(i: SecurityInput): SecurityReport {
  const findings: SecurityFinding[] = [];
  const good: string[] = [];
  const add = (sev: SecSeverity, area: SecurityFinding["area"], msg: string, fix?: string) => findings.push({ sev, area, msg, fix });
  const h = i.headers;
  const final = new URL(i.finalUrl);
  const https = final.protocol === "https:";
  const isHtml = (i.contentType ?? h["content-type"] ?? "").toLowerCase().includes("html");

  /* ---- Transport ---- */
  if (!https) add("high", "transport", "The page is served over plain HTTP, so anything sent to or from it can be read or changed on the network.", "Serve the site over HTTPS and redirect all HTTP traffic to it.");
  else good.push("Served over HTTPS");
  const start = new URL(i.url);
  if (start.protocol === "http:" && https) good.push("HTTP requests redirect to HTTPS");
  if (start.protocol === "http:" && !https) add("high", "transport", "http:// does not redirect to https://.", "Add a permanent redirect from HTTP to HTTPS.");
  const downgrade = i.chain.find((c) => c.location && c.url.startsWith("https:") && c.location.startsWith("http:"));
  if (downgrade) add("high", "transport", `A redirect sends visitors from HTTPS back to HTTP (${new URL(downgrade.url).host}).`, "Never redirect from https:// to http://.");
  if (https) {
    const hsts = h["strict-transport-security"];
    if (!hsts) add("medium", "headers", "No Strict-Transport-Security (HSTS) header, so browsers can be tricked into using HTTP.", "Send Strict-Transport-Security: max-age=31536000; includeSubDomains");
    else {
      const age = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
      if (age < 15552000) add("medium", "headers", `HSTS max-age is only ${age} seconds (${Math.round(age / 86400)} days).`, "Use at least 15552000 (180 days); 31536000 (one year) is the common choice.");
      else good.push("HSTS is enabled with a long max-age");
      if (!/includesubdomains/i.test(hsts)) add("low", "headers", "HSTS does not cover subdomains.", "Add includeSubDomains once every subdomain supports HTTPS.");
    }
  }

  /* ---- Content-Security-Policy ---- */
  const cspHeader = h["content-security-policy"];
  const cspRO = h["content-security-policy-report-only"];
  const csp = cspHeader ? parseCsp(cspHeader) : null;
  if (!csp) {
    add("medium", "csp", cspRO ? "Only a Content-Security-Policy-Report-Only header is set, so nothing is blocked yet." : "No Content-Security-Policy header, so injected scripts run freely if an XSS bug exists.", "Start with the policy from generate_csp in report-only mode, then enforce it.");
  } else {
    good.push("Content-Security-Policy is set");
    const scriptSrc = csp["script-src"] ?? csp["default-src"] ?? [];
    const hasNonceOrHash = scriptSrc.some((t) => /^'(nonce|sha256|sha384|sha512)-/.test(t));
    if (scriptSrc.includes("'unsafe-inline'") && !hasNonceOrHash) add("medium", "csp", "script-src allows 'unsafe-inline', which cancels most of the protection against XSS.", "Replace inline scripts with files, or allow them with nonces or hashes (generate_csp computes hashes).");
    if (scriptSrc.includes("'unsafe-eval'")) add("medium", "csp", "script-src allows 'unsafe-eval'.", "Remove eval-like code, then drop 'unsafe-eval'.");
    if (scriptSrc.includes("*") || scriptSrc.some((t) => t === "https:" || t === "http:" || t === "data:")) add("medium", "csp", "script-src allows scripts from almost anywhere (a bare *, https:, http: or data:).", "List only the hosts you really load scripts from.");
    if (!("object-src" in csp) && !("default-src" in csp)) add("low", "csp", "No object-src, so plugins are not blocked.", "Add object-src 'none'.");
    else if ((csp["object-src"] ?? csp["default-src"] ?? []).some((t) => t !== "'none'") && "object-src" in csp) add("low", "csp", "object-src is not 'none'.", "Add object-src 'none'.");
    if (!("base-uri" in csp)) add("low", "csp", "No base-uri, so an injected <base> tag can redirect relative URLs.", "Add base-uri 'self'.");
    if (!("frame-ancestors" in csp) && !h["x-frame-options"]) add("medium", "csp", "No frame-ancestors in the CSP and no X-Frame-Options, so other sites can frame this page (clickjacking).", "Add frame-ancestors 'self' (or 'none').");
  }

  /* ---- Other headers ---- */
  const xfo = h["x-frame-options"]?.toLowerCase();
  if (csp?.["frame-ancestors"] || xfo === "deny" || xfo === "sameorigin") good.push("Clickjacking protection (frame-ancestors or X-Frame-Options)");
  else if (xfo) add("low", "headers", `X-Frame-Options has an unsupported value ("${h["x-frame-options"]}").`, "Use DENY or SAMEORIGIN, or better, CSP frame-ancestors.");
  if ((h["x-content-type-options"] ?? "").toLowerCase() === "nosniff") good.push("X-Content-Type-Options: nosniff");
  else add("medium", "headers", "Missing X-Content-Type-Options: nosniff, so browsers may guess file types and run uploaded content as script.", "Send X-Content-Type-Options: nosniff");
  const ref = (h["referrer-policy"] ?? "").toLowerCase();
  if (!ref) add("low", "headers", "No Referrer-Policy, so full URLs (which may contain private data) can leak to other sites.", "Send Referrer-Policy: strict-origin-when-cross-origin");
  else if (/unsafe-url|no-referrer-when-downgrade/.test(ref)) add("low", "headers", `Referrer-Policy "${ref}" leaks full URLs to other sites.`, "Use strict-origin-when-cross-origin or stricter.");
  else good.push("Referrer-Policy is set");
  if (!h["permissions-policy"]) add("low", "headers", "No Permissions-Policy, so powerful features (camera, microphone, location) are not explicitly limited.", "Send a Permissions-Policy that disables the features you do not use.");
  else good.push("Permissions-Policy is set");
  if (!h["cross-origin-opener-policy"]) add("info", "headers", "No Cross-Origin-Opener-Policy.", "Consider Cross-Origin-Opener-Policy: same-origin (check that popups and OAuth flows still work).");

  /* ---- Information disclosure ---- */
  const server = h["server"];
  if (server && /\d+\.\d+/.test(server)) add("low", "disclosure", `The Server header reveals a version ("${server}").`, "Hide version numbers (nginx: server_tokens off; Apache: ServerTokens Prod).");
  if (h["x-powered-by"]) add("low", "disclosure", `X-Powered-By reveals the technology ("${h["x-powered-by"]}").`, "Remove the X-Powered-By header.");
  if (h["x-aspnet-version"] || h["x-aspnetmvc-version"]) add("low", "disclosure", "An ASP.NET version header is sent.", "Remove X-AspNet-Version and X-AspNetMvc-Version.");
  const acao = h["access-control-allow-origin"];
  if (acao === "*" && /true/i.test(h["access-control-allow-credentials"] ?? "")) add("high", "headers", "CORS allows every origin with credentials.", "Never combine Access-Control-Allow-Origin: * with credentials; allow specific origins.");
  else if (acao === "*") add("info", "headers", "CORS allows any origin to read responses (Access-Control-Allow-Origin: *). Fine for public data, wrong for anything private.");

  /* ---- Cookies (names only, values are never read out) ---- */
  for (const raw of i.setCookies) {
    const name = raw.split("=")[0].trim();
    const attrs = raw.split(";").slice(1).map((a) => a.trim().toLowerCase());
    const has = (a: string) => attrs.some((x) => x === a || x.startsWith(a + "="));
    const sameSite = attrs.find((a) => a.startsWith("samesite="))?.split("=")[1];
    const sensitive = CRED_COOKIE.test(name);
    if (https && !has("secure")) add(sensitive ? "high" : "medium", "cookies", `Cookie "${name}" is missing Secure, so it can be sent over HTTP.`, "Add the Secure attribute.");
    if (!has("httponly") && sensitive) add("high", "cookies", `Cookie "${name}" looks like a session or token and is missing HttpOnly, so scripts (and XSS) can read it.`, "Add HttpOnly.");
    if (!sameSite) add("low", "cookies", `Cookie "${name}" has no SameSite attribute.`, "Add SameSite=Lax (or Strict).");
    else if (sameSite === "none" && !has("secure")) add("medium", "cookies", `Cookie "${name}" uses SameSite=None without Secure, which browsers reject.`, "Add Secure when using SameSite=None.");
  }
  if (i.setCookies.length && !findings.some((f) => f.area === "cookies")) good.push(`${i.setCookies.length} cookie${i.setCookies.length > 1 ? "s" : ""} set with safe attributes`);

  /* ---- HTML content ---- */
  const thirdParties = new Set<string>();
  const trackers: { host: string; name: string }[] = [];
  if (isHtml && i.body) {
    const p = parseHtml(i.body);
    const pageHost = final.hostname.replace(/^www\./, "");
    const isThird = (host: string) => !(host === pageHost || host.endsWith("." + pageHost) || hostMatches(final.hostname, host));
    const mixedActive: string[] = [];
    const mixedPassive: string[] = [];
    const noSri: string[] = [];
    let jsUrls = 0, blankNoRel = 0;

    const consider = (t: Tag) => {
      for (const attr of URL_ATTRS[t.name] ?? []) {
        const u = resolveUrl(t.attrs[attr], i.finalUrl);
        if (!u) continue;
        if (isThird(u.hostname) && t.name !== "a" && t.name !== "form") thirdParties.add(u.hostname);
        if (https && u.protocol === "http:") {
          const active = t.name === "script" || t.name === "iframe" || t.name === "object" || t.name === "embed" || (t.name === "link" && /stylesheet/i.test(t.attrs.rel ?? ""));
          if (t.name === "a") continue; // plain links are not mixed content
          (active ? mixedActive : mixedPassive).push(u.href);
        }
        const sriNeeded = (t.name === "script" && attr === "src") || (t.name === "link" && /stylesheet/i.test(t.attrs.rel ?? ""));
        if (sriNeeded && isThird(u.hostname) && !t.attrs.integrity) noSri.push(`${t.name === "script" ? "script" : "stylesheet"} ${u.hostname}`);
      }
    };
    for (const t of p.tags) consider(t);

    if (mixedActive.length) add("high", "content", `${mixedActive.length} script/frame/stylesheet load${mixedActive.length > 1 ? "" : "s"} over http:// on an https:// page (blocked or exploitable): ${mixedActive.slice(0, 3).join(", ")}.`, "Load every resource over https://.");
    if (mixedPassive.length) add("medium", "content", `${mixedPassive.length} image/media resource${mixedPassive.length > 1 ? "s load" : " loads"} over http:// on an https:// page.`, "Use https:// URLs for all resources.");

    const noSriScripts = noSri.filter((x) => x.startsWith("script"));
    const noSriStyles = noSri.filter((x) => x.startsWith("stylesheet"));
    if (noSriScripts.length) add("medium", "content", `${noSriScripts.length} third-party script${noSriScripts.length > 1 ? "s" : ""} without Subresource Integrity (${[...new Set(noSriScripts.map((s) => s.slice(7)))].slice(0, 4).join(", ")}). If that host is compromised, so is your page.`, "Add integrity=\"sha384-...\" and crossorigin=\"anonymous\" for static third-party files, or self-host them.");
    if (noSriStyles.length) add("low", "content", `${noSriStyles.length} third-party stylesheet${noSriStyles.length > 1 ? "s" : ""} without Subresource Integrity.`, "Add an integrity attribute, or self-host the stylesheet.");

    for (const f of p.tags.filter((t) => t.name === "form")) {
      const action = resolveUrl(f.attrs.action, i.finalUrl);
      if (action?.protocol === "http:") add("high", "content", `A form posts to an http:// address (${action.hostname}), sending what users type in the clear.`, "Point the form action at an https:// URL.");
    }
    const pw = p.tags.filter((t) => t.name === "input" && (t.attrs.type ?? "").toLowerCase() === "password");
    if (pw.length && !https) add("high", "content", "A password field is on a page that is not served over HTTPS.", "Serve every page with a login form over HTTPS.");
    if (pw.some((t) => !t.attrs.autocomplete)) add("low", "content", "A password field has no autocomplete attribute, which hurts password managers.", 'Use autocomplete="current-password" or "new-password".');

    for (const t of p.tags) {
      for (const attr of ["href", "src", "action"]) if (/^\s*javascript:/i.test(t.attrs[attr] ?? "")) jsUrls++;
      if (t.name === "a" && (t.attrs.target ?? "").toLowerCase() === "_blank" && !/noopener|noreferrer/i.test(t.attrs.rel ?? "")) blankNoRel++;
    }
    if (jsUrls) add("medium", "content", `${jsUrls} javascript: URL${jsUrls > 1 ? "s" : ""} in attributes, which a strict CSP would block.`, "Use real links and event listeners instead.");
    if (blankNoRel) add("low", "content", `${blankNoRel} link${blankNoRel > 1 ? "s open" : " opens"} a new tab (target="_blank") without rel="noopener". Current browsers imply it, older ones do not.`, 'Add rel="noopener noreferrer".');
    const handlers = p.tags.reduce((n, t) => n + Object.keys(t.attrs).filter((a) => /^on[a-z]+$/.test(a)).length, 0);
    const inlineScripts = p.scripts.filter((s) => !s.attrs.src && !/json|importmap|speculation/i.test(s.attrs.type ?? "")).length;
    if (handlers || inlineScripts) add("info", "csp", `${inlineScripts} inline script${inlineScripts === 1 ? "" : "s"} and ${handlers} inline event handler${handlers === 1 ? "" : "s"}. A strict CSP needs inline scripts hashed or moved to files, and handlers replaced with event listeners.`);
    const generator = p.tags.find((t) => t.name === "meta" && t.attrs.name?.toLowerCase() === "generator");
    if (generator?.attrs.content && /\d+\.\d+/.test(generator.attrs.content)) add("low", "disclosure", `The page names its software and version ("${generator.attrs.content}").`, "Remove the generator meta tag or hide the version.");
    if (p.tags.some((t) => t.name === "meta" && t.attrs["http-equiv"]?.toLowerCase() === "content-security-policy") && !cspHeader) add("info", "csp", "A CSP is set only through a <meta> tag. Meta policies cannot use frame-ancestors or report-uri.", "Send the policy as an HTTP header.");

    const secrets = scanSecrets(i.body);
    if (secrets.length) add("high", "content", `${secrets.length} possible credential${secrets.length > 1 ? "s" : ""} in the page source (${[...new Set(secrets.map((s) => s.rule))].slice(0, 3).join(", ")}). Anyone can read them.`, "Run scan_secrets on the source for exact locations, revoke the credentials and move them server-side.");

    // Privacy
    for (const host of thirdParties) {
      const t = TRACKERS.find(([d]) => hostMatches(host, d));
      if (t) trackers.push({ host, name: t[1] });
    }
    if (trackers.length) add("info", "privacy", `Known tracking or analytics services load on this page: ${[...new Set(trackers.map((t) => t.name))].join(", ")}. They may need consent under GDPR and similar laws.`, "Disclose them in your privacy policy and load them only after consent where required.");
    if ([...thirdParties].some((x) => hostMatches(x, "fonts.googleapis.com") || hostMatches(x, "fonts.gstatic.com"))) add("info", "privacy", "Fonts load from Google's servers, which shares visitors' IP addresses with Google (a GDPR concern in some courts).", "Self-host the font files.");
  }

  /* ---- Score ---- */
  const weights: Record<SecSeverity, number> = { high: 15, medium: 7, low: 2, info: 0 };
  const score = Math.max(0, 100 - findings.reduce((n, f) => n + weights[f.sev], 0));
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 55 ? "D" : "F";
  return { score, grade, findings, good, thirdParties: [...thirdParties].sort(), trackers };
}

export function formatSecurityReport(r: SecurityReport, i: SecurityInput): string {
  const count = (s: SecSeverity) => r.findings.filter((f) => f.sev === s).length;
  const lines = [
    `## Security check: ${new URL(i.finalUrl).host}`,
    `Grade **${r.grade}** · score ${r.score}/100 · ${count("high")} high, ${count("medium")} medium, ${count("low")} low, ${count("info")} notes`,
    `Checked one ${i.status} response from ${i.finalUrl}${i.chain.length ? ` after ${i.chain.length} redirect${i.chain.length > 1 ? "s" : ""}` : ""}. Only what the server sends to any visitor was inspected.`,
  ];
  for (const [sev, title] of [["high", "High"], ["medium", "Medium"], ["low", "Low"], ["info", "Notes"]] as const) {
    const list = r.findings.filter((f) => f.sev === sev);
    if (list.length) lines.push("", `### ${title}`, ...list.map((f) => `- [${f.area}] ${f.msg}${f.fix ? ` **Fix:** ${f.fix}` : ""}`));
  }
  if (r.good.length) lines.push("", "### Already good", ...r.good.map((g) => `- ${g}`));
  if (r.thirdParties.length) lines.push("", `### Third-party hosts (${r.thirdParties.length})`, r.thirdParties.slice(0, 20).join(", ") + (r.thirdParties.length > 20 ? ", ..." : ""));
  lines.push("", "_Next: `generate_csp` builds a Content-Security-Policy from this page, and `generate_security_headers` writes the header set for your host. This is a passive check of headers and markup; it does not test for vulnerabilities in your code._");
  return lines.join("\n");
}

export { decodeEntities };
