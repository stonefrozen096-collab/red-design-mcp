/** A small, forgiving HTML tokenizer plus an accessibility and quality audit built on it. */

export interface Tag {
  name: string;
  attrs: Record<string, string>;
  index: number;
  end: number;
}

export interface Block {
  attrs: Record<string, string>;
  content: string;
}

export interface ParsedHtml {
  /** HTML with comments and script/style contents blanked out (same length, so indexes line up). */
  masked: string;
  tags: Tag[];
  scripts: Block[];
  styles: Block[];
}

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export const decodeEntities = (s: string) =>
  s.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ");

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

export function parseHtml(html: string): ParsedHtml {
  let masked = html.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  const scripts: Block[] = [];
  const styles: Block[] = [];
  masked = masked.replace(/<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/gi, (m, name: string, rawAttrs: string, content: string) => {
    (name.toLowerCase() === "script" ? scripts : styles).push({ attrs: parseAttrs(rawAttrs), content });
    return `<${name}${rawAttrs}>${" ".repeat(content.length)}</${name}>`;
  });
  const tags: Tag[] = [];
  for (const m of masked.matchAll(TAG_RE)) {
    tags.push({ name: m[1].toLowerCase(), attrs: parseAttrs(m[2] ?? ""), index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return { masked, tags, scripts, styles };
}

/** Inner HTML of the element that starts at `tag` (up to its first closing tag). */
export function innerHtml(p: ParsedHtml, tag: Tag): string {
  const re = new RegExp(`</${tag.name}\\s*>`, "gi");
  re.lastIndex = tag.end;
  const m = re.exec(p.masked);
  return m ? p.masked.slice(tag.end, m.index) : "";
}

export const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/* --------------------------------- HTML audit --------------------------------- */

export type Severity = "high" | "medium" | "low";
export interface HtmlFinding {
  sev: Severity;
  area: "accessibility" | "semantics" | "performance";
  msg: string;
  fix: string;
}

export interface HtmlAudit {
  score: number;
  findings: HtmlFinding[];
  stats: { tags: number; images: number; links: number; forms: number; headings: number };
  fragment: boolean;
}

const GENERIC_LINK = /^(click here|here|read more|more|learn more|link|this|details|continue)$/i;
const SKIP_LABEL_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

export function auditHtml(html: string): HtmlAudit {
  const p = parseHtml(html);
  const findings: HtmlFinding[] = [];
  const add = (sev: Severity, area: HtmlFinding["area"], msg: string, fix: string) => findings.push({ sev, area, msg, fix });
  const named = (n: string) => p.tags.filter((t) => t.name === n);
  const fragment = !named("html").length && !named("head").length;

  if (!fragment) {
    const htmlTag = named("html")[0];
    if (!htmlTag?.attrs.lang?.trim()) add("high", "accessibility", "The <html> element has no lang attribute, so screen readers guess the language.", 'Add lang, for example <html lang="en"> (WCAG 3.1.1).');
    const title = named("title")[0];
    if (!title || !stripTags(innerHtml(p, title))) add("medium", "semantics", "The page has no <title>, or it is empty.", "Add a short, unique <title> that says what the page is.");
    const viewport = named("meta").find((t) => t.attrs.name?.toLowerCase() === "viewport");
    if (!viewport) add("medium", "semantics", "No viewport meta tag, so phones render the page at desktop width.", 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
    else {
      const c = (viewport.attrs.content ?? "").toLowerCase();
      const maxScale = /maximum-scale\s*=\s*([\d.]+)/.exec(c);
      if (/user-scalable\s*=\s*(no|0)/.test(c) || (maxScale && parseFloat(maxScale[1]) < 2)) {
        add("high", "accessibility", "The viewport blocks pinch-zoom, which low-vision users rely on.", "Remove user-scalable=no and any maximum-scale below 2 (WCAG 1.4.4).");
      }
    }
    if (!named("main").length && !p.tags.some((t) => t.attrs.role === "main")) add("low", "semantics", "No <main> landmark, so keyboard and screen-reader users cannot jump to the content.", "Wrap the primary content in <main>.");
  }

  const images = named("img");
  const noAlt = images.filter((t) => !("alt" in t.attrs) && t.attrs.role !== "presentation");
  if (noAlt.length) add("high", "accessibility", `${noAlt.length} image${noAlt.length > 1 ? "s have" : " has"} no alt attribute.`, 'Describe meaningful images in alt, and use alt="" for decorative ones (WCAG 1.1.1).');
  const noSize = images.filter((t) => !t.attrs.width || !t.attrs.height);
  if (noSize.length) add("low", "performance", `${noSize.length} image${noSize.length > 1 ? "s lack" : " lacks"} width and height, which causes layout shift while loading.`, "Set width and height attributes (or CSS aspect-ratio) on images.");

  // Form controls need a name: a <label for>, a wrapping <label>, or an aria attribute.
  const labels = named("label");
  const labelFor = new Set(labels.map((l) => l.attrs.for).filter(Boolean));
  const labelRanges = labels.map((l) => [l.end, l.end + innerHtml(p, l).length]);
  const unlabeled = p.tags.filter((t) => {
    if (!["input", "select", "textarea"].includes(t.name)) return false;
    if (t.name === "input" && SKIP_LABEL_TYPES.has((t.attrs.type ?? "text").toLowerCase())) return false;
    if (t.attrs["aria-label"]?.trim() || t.attrs["aria-labelledby"] || t.attrs.title?.trim()) return false;
    if (t.attrs.id && labelFor.has(t.attrs.id)) return false;
    return !labelRanges.some(([s, e]) => t.index >= s && t.index <= e);
  });
  if (unlabeled.length) add("high", "accessibility", `${unlabeled.length} form field${unlabeled.length > 1 ? "s have" : " has"} no label.`, "Connect each field to a visible <label for> (placeholders are not labels). WCAG 1.3.1 and 3.3.2.");

  const emptyButtons = named("button").filter((t) => {
    const inner = innerHtml(p, t);
    return !stripTags(inner) && !/<img[^>]+alt\s*=\s*["'][^"']+["']/i.test(inner) && !/<title>[^<]+<\/title>/i.test(inner) && !t.attrs["aria-label"]?.trim() && !t.attrs["aria-labelledby"] && !t.attrs.title?.trim();
  });
  if (emptyButtons.length) add("high", "accessibility", `${emptyButtons.length} button${emptyButtons.length > 1 ? "s have" : " has"} no accessible name (for example an icon-only button).`, "Add visible text or an aria-label that says what the button does (WCAG 4.1.2).");

  const links = named("a").filter((t) => "href" in t.attrs);
  const emptyLinks = links.filter((t) => {
    const inner = innerHtml(p, t);
    return !stripTags(inner) && !/<img[^>]+alt\s*=\s*["'][^"']+["']/i.test(inner) && !t.attrs["aria-label"]?.trim() && !t.attrs["aria-labelledby"] && !t.attrs.title?.trim();
  });
  if (emptyLinks.length) add("high", "accessibility", `${emptyLinks.length} link${emptyLinks.length > 1 ? "s have" : " has"} no text or accessible name.`, "Give every link descriptive text or an aria-label (WCAG 2.4.4).");
  const vague = links.filter((t) => GENERIC_LINK.test(stripTags(innerHtml(p, t))));
  if (vague.length) add("low", "accessibility", `${vague.length} link${vague.length > 1 ? "s use" : " uses"} vague text such as "click here" or "read more".`, "Make link text meaningful on its own, for example \"Read the pricing guide\".");

  const headings = p.tags.filter((t) => /^h[1-6]$/.test(t.name)).map((t) => ({ level: Number(t.name[1]) }));
  if (!fragment && headings.length && !headings.some((h) => h.level === 1)) add("low", "semantics", "The page has no <h1>.", "Use one <h1> that names the page.");
  if (headings.filter((h) => h.level === 1).length > 1) add("low", "semantics", "The page has more than one <h1>.", "Use a single <h1> and <h2> to <h6> for sections.");
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level > headings[i - 1].level + 1) {
      add("medium", "accessibility", `Heading levels skip from h${headings[i - 1].level} to h${headings[i].level}.`, "Do not skip heading levels; they form the page outline screen-reader users navigate by.");
      break;
    }
  }

  const ids = p.tags.map((t) => t.attrs.id).filter(Boolean);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) add("medium", "accessibility", `Duplicate id values: ${dupes.slice(0, 5).join(", ")}.`, "ids must be unique, or labels and aria references point at the wrong element.");
  const posTab = p.tags.filter((t) => Number(t.attrs.tabindex) > 0);
  if (posTab.length) add("medium", "accessibility", `${posTab.length} element${posTab.length > 1 ? "s use" : " uses"} a positive tabindex, which breaks the natural focus order.`, "Use tabindex=\"0\" or \"-1\" only, and fix the DOM order instead.");
  const frames = named("iframe").filter((t) => !t.attrs.title?.trim());
  if (frames.length) add("medium", "accessibility", `${frames.length} iframe${frames.length > 1 ? "s have" : " has"} no title.`, "Add a title that describes the embedded content.");
  const autoplay = p.tags.filter((t) => (t.name === "video" || t.name === "audio") && "autoplay" in t.attrs);
  if (autoplay.length) add("medium", "accessibility", `${autoplay.length} media element${autoplay.length > 1 ? "s autoplay" : " autoplays"}.`, "Do not autoplay audio. If video must autoplay, keep it muted and give a pause control (WCAG 1.4.2, 2.2.2).");
  const tablesNoHeaders = named("table").filter((t) => !/<th[\s>]/i.test(innerHtml(p, t)));
  if (tablesNoHeaders.length) add("low", "accessibility", `${tablesNoHeaders.length} table${tablesNoHeaders.length > 1 ? "s have" : " has"} no header cells.`, "Use <th> for header cells so screen readers can read rows and columns.");
  const blocking = p.tags.filter((t) => t.name === "script" && t.attrs.src && !("async" in t.attrs) && !("defer" in t.attrs) && (t.attrs.type ?? "").toLowerCase() !== "module");
  if (blocking.length > 2) add("low", "performance", `${blocking.length} scripts block rendering (no async, defer or type=module).`, "Add defer to scripts that do not need to run before the page paints.");

  const count = (s: Severity) => findings.filter((f) => f.sev === s).length;
  const score = Math.max(0, 100 - count("high") * 10 - count("medium") * 5 - count("low") * 2);
  return {
    score,
    findings,
    fragment,
    stats: { tags: p.tags.length, images: images.length, links: links.length, forms: named("form").length, headings: headings.length },
  };
}

export function formatHtmlAudit(a: HtmlAudit, label = "the page"): string {
  const count = (s: Severity) => a.findings.filter((f) => f.sev === s).length;
  const lines = [
    "## HTML audit",
    `Score: **${a.score}/100** for ${label} · ${count("high")} high, ${count("medium")} medium, ${count("low")} low`,
    `${a.stats.tags} elements · ${a.stats.images} images · ${a.stats.links} links · ${a.stats.forms} forms · ${a.stats.headings} headings${a.fragment ? " · fragment, so page-level checks (lang, title, viewport, main) were skipped" : ""}`,
  ];
  for (const sev of ["high", "medium", "low"] as const) {
    const list = a.findings.filter((f) => f.sev === sev);
    if (list.length) lines.push("", `### ${sev[0].toUpperCase() + sev.slice(1)}`, ...list.map((f) => `- ${f.msg} Fix: ${f.fix}`));
  }
  if (!a.findings.length) lines.push("", "No issues found.");
  lines.push("", "_This is a static check of the markup. It cannot judge color contrast (use `audit_accessibility` or `lint_css`) or behavior that scripts add later._");
  return lines.join("\n");
}
