import { parseColor } from "./colorparse.js";
import { rgbToHex, rgbToHsl } from "./color.js";
import type { Tokens } from "./tokens.js";

export interface Rule {
  selector: string;
  decls: [string, string][];
  /** At-rule preludes this rule sits inside, e.g. "@media (prefers-color-scheme: dark)". */
  context?: string[];
}

export const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

interface Node {
  prelude: string;
  decls: [string, string][];
  children: Node[];
}

const MAX_DEPTH = 64;

/**
 * A small CSS tokenizer-parser. It understands strings, url(), comments, nested rules (CSS nesting),
 * at-rule blocks and custom properties whose values contain braces, which a flat regex cannot.
 */
function parseBlock(css: string, start: number, depth: number): { decls: [string, string][]; children: Node[]; end: number } {
  if (depth > MAX_DEPTH) throw new Error("CSS is nested too deeply to analyze.");
  const decls: [string, string][] = [];
  const children: Node[] = [];
  const n = css.length;
  let i = start;
  let buf = "";

  const pushDecl = () => {
    const t = buf.trim();
    buf = "";
    if (!t || t.startsWith("@")) return;
    const c = t.indexOf(":");
    if (c < 1) return;
    const prop = t.slice(0, c).trim().toLowerCase();
    if (!/^(--[\w-]+|-?[a-z][\w-]*)$/.test(prop)) return;
    decls.push([prop, t.slice(c + 1).replace(/!important/gi, "").trim()]);
  };

  while (i < n) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const e = css.indexOf("*/", i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && css[j] !== ch) {
        if (css[j] === "\\") j++;
        j++;
      }
      buf += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if ((ch === "u" || ch === "U") && css.slice(i, i + 4).toLowerCase() === "url(" && (i === 0 || !/[\w-]/.test(css[i - 1]))) {
      let j = i + 4;
      while (j < n && /\s/.test(css[j])) j++;
      if (css[j] === '"' || css[j] === "'") {
        const q = css[j++];
        while (j < n && css[j] !== q) {
          if (css[j] === "\\") j++;
          j++;
        }
      }
      while (j < n && css[j] !== ")") j++;
      buf += "url()"; // contents (data URLs, paths) are irrelevant and may contain braces or colors
      i = j + 1;
      continue;
    }
    if (ch === "{") {
      const pre = buf.trim();
      if (/^--[\w-]+\s*:$/.test(pre)) {
        let d = 1;
        let j = i + 1;
        while (j < n && d > 0) {
          if (css[j] === "{") d++;
          else if (css[j] === "}") d--;
          j++;
        }
        decls.push([pre.slice(0, pre.indexOf(":")).trim().toLowerCase(), css.slice(i, j).trim()]);
        buf = "";
        i = j;
        continue;
      }
      const inner = parseBlock(css, i + 1, depth + 1);
      children.push({ prelude: pre, decls: inner.decls, children: inner.children });
      buf = "";
      i = inner.end + 1;
      continue;
    }
    if (ch === "}") {
      pushDecl();
      return { decls, children, end: i };
    }
    if (ch === ";") {
      pushDecl();
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  pushDecl();
  return { decls, children, end: n };
}

const GROUPING_AT_RULES = new Set(["media", "supports", "layer", "container", "scope", "document", "starting-style"]);

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function flatten(nodes: Node[], parent: string[] | null, ctx: string[], out: Rule[]): void {
  for (const node of nodes) {
    if (node.prelude.startsWith("@")) {
      const name = node.prelude.slice(1).split(/[\s(]/)[0].toLowerCase();
      if (!GROUPING_AT_RULES.has(name)) continue; // @keyframes, @font-face, @property ... are not style rules
      const next = [...ctx, node.prelude];
      if (node.decls.length && parent) out.push({ selector: parent.join(", "), decls: node.decls, context: next });
      flatten(node.children, parent, next, out);
    } else {
      const own = splitTopLevel(node.prelude);
      const sels = parent ? parent.flatMap((p) => own.map((c) => (c.includes("&") ? c.replace(/&/g, p) : `${p} ${c}`))) : own;
      if (node.decls.length) out.push({ selector: sels.join(", "), decls: node.decls, context: ctx });
      flatten(node.children, sels, ctx, out);
    }
  }
}

export function parseRules(css: string): Rule[] {
  const nodes: Node[] = [];
  let i = 0;
  while (i < css.length) {
    const r = parseBlock(css, i, 0);
    nodes.push(...r.children);
    i = r.end + 1; // continue past a stray closing brace
  }
  const out: Rule[] = [];
  flatten(nodes, null, [], out);
  return out;
}

const HEX_RE = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-z_-])/gi;
const FUNC_RE = /(?<![\w-])(?:rgba?|hsla?|hwb|oklch|oklab)\([^()]*\)/gi;

/** Opaque color literals in a CSS value, as normalized #rrggbb. Translucent colors are skipped. */
export function colorsIn(value: string): string[] {
  const out: string[] = [];
  for (const re of [HEX_RE, FUNC_RE]) {
    for (const m of value.matchAll(re)) {
      const c = parseColor(m[0]);
      if (c && c.alpha >= 1) out.push(rgbToHex(c.rgb));
    }
  }
  return out;
}

export function toPx(v: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem|em)$/.exec(v.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === "px" ? n : n * 16;
}

const GENERIC = /^(inherit|initial|unset|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|var\(.*)$/i;

export function firstFamily(value: string): string | null {
  const f = value.split(",")[0].replace(/["']/g, "").trim();
  return !f || GENERIC.test(f) ? null : f;
}

const SIZE_NAMES = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"];
const top = <K>(m: Map<K, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

export interface CssStats {
  rules: number;
  distinctColors: number;
  fontFamilies: number;
  fontSizes: number;
}

export function extractCssTokens(css: string): { tokens: Tokens; stats: CssStats } {
  const rules = parseRules(css);
  if (!rules.length) throw new Error("No CSS rules found. This page may style itself with JavaScript; use capture_url and the vision tools instead.");

  const colorCount = new Map<string, number>();
  const named: Record<string, string> = {};
  const fonts = new Map<string, number>();
  const sizes = new Set<number>();
  const radii = new Set<number>();
  const spacing = new Map<number, number>();
  const shadows = new Map<string, number>();
  const weights = new Set<string>();
  let bodyFont: string | undefined, headingFont: string | undefined, bodyBg: string | undefined, bodyText: string | undefined;

  for (const r of rules) {
    const sels = r.selector.split(",").map((s) => s.trim());
    const isRoot = sels.some((s) => [":root", "html", "body", "*"].includes(s));
    const isHeading = sels.some((s) => /^h[1-6]$/i.test(s));
    const dark = (r.context ?? []).some((c) => /prefers-color-scheme\s*:\s*dark/i.test(c));
    for (const [prop, val] of r.decls) {
      const cs = colorsIn(val);
      // Dark-mode overrides still count as used colors, but must not replace the light-mode tokens.
      if (!dark && prop.startsWith("--") && cs.length === 1 && /^(#|rgb|hsl|hwb|oklch|oklab)/i.test(val)) {
        named[prop.slice(2).toLowerCase().replace(/[^a-z0-9-]+/g, "-")] ??= cs[0];
      }
      for (const c of cs) bump(colorCount, c);
      if (!dark && isRoot && (prop === "background" || prop === "background-color")) bodyBg ??= cs[0];
      if (!dark && isRoot && prop === "color") bodyText ??= cs[0];
      if (prop === "font-family") {
        const f = firstFamily(val);
        if (f) {
          bump(fonts, f);
          if (isRoot) bodyFont ??= f;
          if (isHeading) headingFont ??= f;
        }
      } else if (prop === "font-size") {
        const px = toPx(val);
        if (px !== null && px > 0) sizes.add(Math.round(px * 10) / 10);
      } else if (prop === "font-weight" && /^\d{3}$/.test(val)) weights.add(val);
      else if (prop === "border-radius") {
        const px = toPx(val.split(/\s+/)[0]);
        if (px !== null && px > 0) radii.add(Math.round(px));
      } else if (/^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left))?$/.test(prop)) {
        for (const t of val.split(/\s+/)) {
          const px = toPx(t);
          if (px !== null && px > 0) bump(spacing, Math.round(px));
        }
      } else if (prop === "box-shadow" && val !== "none" && val.length < 160) bump(shadows, val);
    }
  }

  // Colors: custom-property names first, then roles, then ranked leftovers.
  const colors: Record<string, string> = {};
  const used = new Set<string>();
  const put = (name: string, hex: string) => {
    let n = name, i = 2;
    while (n in colors) n = `${name}-${i++}`;
    colors[n] = hex;
    used.add(hex);
  };
  Object.entries(named).slice(0, 24).forEach(([n, h]) => put(n, h));
  if (bodyBg && !used.has(bodyBg)) put("background", bodyBg);
  if (bodyText && !used.has(bodyText)) put("text", bodyText);
  const ranked = top(colorCount, 40).filter((c) => !used.has(c));
  const chromatic = ranked.filter((c) => { const [, s, l] = rgbToHsl(hexToRgbSafe(c)); return s >= 0.12 && l > 0.06 && l < 0.97; });
  const neutral = ranked.filter((c) => !chromatic.includes(c)).sort((a, b) => rgbToHsl(hexToRgbSafe(a))[2] - rgbToHsl(hexToRgbSafe(b))[2]);
  chromatic.slice(0, 5).forEach((c, i) => put(i === 0 && !("primary" in colors) ? "primary" : `accent-${i + 1}`, c));
  neutral.slice(0, 6).forEach((c, i) => put(`neutral-${i + 1}`, c));

  // Fonts
  const rankedFonts = top(fonts, 6);
  const fontFamilies: Record<string, string> = {};
  const body = bodyFont ?? rankedFonts[0];
  const heading = headingFont ?? rankedFonts.find((f) => f !== body);
  if (body) fontFamilies.body = body;
  if (heading && heading !== body) fontFamilies.heading = heading;
  const mono = rankedFonts.find((f) => /mono|code|courier|consolas|menlo/i.test(f));
  if (mono) fontFamilies.mono = mono;

  // Sizes: name relative to the size closest to 16px.
  const sortedSizes = [...sizes].sort((a, b) => a - b).slice(-10);
  const fontSizes: Record<string, string> = {};
  if (sortedSizes.length) {
    const baseIdx = sortedSizes.reduce((b, s, i) => (Math.abs(s - 16) < Math.abs(sortedSizes[b] - 16) ? i : b), 0);
    sortedSizes.forEach((s, i) => {
      const idx = 2 + (i - baseIdx);
      fontSizes[SIZE_NAMES[idx] ?? `size-${i + 1}`] = `${s}px`;
    });
  }

  const weightNames: Record<string, string> = { "300": "light", "400": "regular", "500": "medium", "600": "semibold", "700": "bold", "800": "extrabold" };
  const fontWeights: Record<string, string> = {};
  [...weights].sort().forEach((w) => (fontWeights[weightNames[w] ?? `w${w}`] = w));

  const radiiSorted = [...radii].filter((r) => r < 999).sort((a, b) => a - b);
  const pick = radiiSorted.length > 4 ? [0, 1, 2, 3].map((i) => radiiSorted[Math.round((i * (radiiSorted.length - 1)) / 3)]) : radiiSorted;
  const radiiOut: Record<string, string> = {};
  [...new Set(pick)].forEach((r, i) => (radiiOut[["sm", "md", "lg", "xl"][i]] = `${r}px`));
  if ([...radii].some((r) => r >= 999)) radiiOut.full = "9999px";

  const spacingOut: Record<string, string> = {};
  top(spacing, 8).sort((a, b) => a - b).forEach((px) => (spacingOut[String(px)] = `${px}px`));

  const shadowsOut: Record<string, string> = {};
  top(shadows, 3).forEach((s, i) => (shadowsOut[["sm", "md", "lg"][i]] = s));

  return {
    tokens: { colors, fontFamilies, fontSizes, fontWeights, spacing: spacingOut, radii: radiiOut, shadows: shadowsOut },
    stats: { rules: rules.length, distinctColors: colorCount.size, fontFamilies: fonts.size, fontSizes: sizes.size },
  };
}

function hexToRgbSafe(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
