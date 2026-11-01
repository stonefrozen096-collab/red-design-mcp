import { hexToRgb, extractJson } from "./a11y.js";
import { deltaE, rgbToHex } from "./color.js";

interface Fingerprint {
  colors: string[];
  fonts: string[];
  radii: number[];
  spacing: number[];
  keywords: string[];
}

const nums = (v: unknown, allowZero = false): number[] =>
  (String(v ?? "").match(/\d+(\.\d+)?/g) ?? []).map(Number).filter((n) => (allowZero ? n >= 0 : n > 0));
const flat = (o: unknown): unknown[] =>
  o && typeof o === "object" ? Object.values(o as object).flatMap((v) => (v && typeof v === "object" ? flat(v) : [v])) : [];

export function fingerprint(raw: string): Fingerprint {
  const o = extractJson(raw);
  const colors = flat(o.colors)
    .filter((v): v is string => typeof v === "string" && !!hexToRgb(v))
    .map((v) => rgbToHex(hexToRgb(v)!));
  const famSrc = o.fontFamilies ? Object.values(o.fontFamilies) : o.typography?.families ?? [];
  const fonts = (famSrc as unknown[])
    .map((f) => String(f).split(",")[0].replace(/["']/g, "").trim().toLowerCase())
    .filter(Boolean);
  const radii = o.radii ? flat(o.radii).flatMap((v) => nums(v, true)) : nums(o.shape?.radius, true);
  const spacing = o.spacing && typeof o.spacing === "object" && !o.spacing.base ? flat(o.spacing).flatMap((v) => nums(v)) : nums(o.spacing?.base);
  const keywords = ((o.style_keywords ?? []) as unknown[]).map((k) => String(k).toLowerCase());
  return { colors: [...new Set(colors)], fonts: [...new Set(fonts)], radii, spacing, keywords };
}

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

function colorSim(a: string[], b: string[]): number | null {
  if (!a.length || !b.length) return null;
  const one = (x: string[], y: string[]) =>
    mean(x.map((c) => Math.max(0, 1 - Math.min(...y.map((d) => deltaE(c, d) ?? 100)) / 40)));
  return (one(a, b) + one(b, a)) / 2;
}

function setSim(a: string[], b: string[]): number | null {
  if (!a.length || !b.length) return null;
  const inter = a.filter((x) => b.includes(x)).length;
  return inter / new Set([...a, ...b]).size;
}

function numSim(a: number[], b: number[], tol: number): number | null {
  if (!a.length || !b.length) return null;
  const m = (x: number[], y: number[]) => x.filter((v) => y.some((w) => Math.abs(v - w) <= tol)).length / x.length;
  return (m(a, b) + m(b, a)) / 2;
}

const TIPS: Record<string, string> = {
  Palette: "Shift the dominant hues or swap the accent color so the palette reads as its own.",
  Typography: "Pick a different type pairing; fonts are one of the fastest ways to look distinct.",
  "Shape (radii)": "Change the corner-radius system (for example sharp vs. fully rounded).",
  Spacing: "Use a different spacing rhythm (for example a 6px or 10px base instead of 8px).",
  "Style keywords": "Choose a different style direction in `reimagine` and raise the inspiration dial.",
};

export function originalityReport(rawA: string, rawB: string): string {
  const a = fingerprint(rawA);
  const b = fingerprint(rawB);
  const dims: [string, number, number | null][] = [
    ["Palette", 0.4, colorSim(a.colors, b.colors)],
    ["Typography", 0.25, setSim(a.fonts, b.fonts)],
    ["Shape (radii)", 0.15, numSim(a.radii, b.radii, 2)],
    ["Spacing", 0.1, numSim(a.spacing, b.spacing, 1)],
    ["Style keywords", 0.1, setSim(a.keywords, b.keywords)],
  ];
  const used = dims.filter((d): d is [string, number, number] => d[2] !== null);
  if (!used.length) throw new Error("Nothing comparable found. Pass JSON from extract_tokens or analyze_design for both designs.");

  const totalW = used.reduce((s, d) => s + d[1], 0);
  const overall = used.reduce((s, d) => s + d[1] * d[2], 0) / totalW;
  const verdict =
    overall < 0.35 ? "Distinct" : overall < 0.6 ? "Inspired by the source" : overall < 0.8 ? "Close, differentiate more" : "Too similar";

  const lines = [
    "## Originality check",
    `Similarity: **${Math.round(overall * 100)}%** (${verdict})`,
    "",
    "| Dimension | Similarity |",
    "|---|---|",
    ...used.map((d) => `| ${d[0]} | ${Math.round(d[2] * 100)}% |`),
  ];
  const high = used.filter((d) => d[2] >= 0.7);
  if (high.length) {
    lines.push("", "### To differentiate further");
    for (const d of high) lines.push(`- **${d[0]}**: ${TIPS[d[0]]}`);
  }
  lines.push("", "_This compares palette, type, shape and spacing tokens. It does not judge layout or content and is not legal advice._");
  return lines.join("\n");
}
