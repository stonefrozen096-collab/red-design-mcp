import { contrastRatio, hexToRgb } from "./a11y.js";

export type RGB = [number, number, number];
export type HSL = [number, number, number];

export function rgbToHex(rgb: RGB): string {
  return "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

export function normalizeHex(hex: string): string | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb) : null;
}

export function rgbToHsl([r0, g0, b0]: RGB): HSL {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h0: number, s: number, l: number): RGB {
  const h = ((h0 % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c0: number): number {
  const c = Math.max(0, Math.min(1, c0));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

export function rgbToLab(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb.map(srgbToLinear);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Perceptual color distance (CIE76). ~2 is barely noticeable, 10+ is clearly different. */
export function deltaE(a: string, b: string): number | null {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return null;
  const [l1, a1, b1] = rgbToLab(ra);
  const [l2, a2, b2] = rgbToLab(rb);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/* ---------------------------------- Palette --------------------------------- */

const STOPS: [string, number][] = [
  ["50", 0.97], ["100", 0.93], ["200", 0.85], ["300", 0.74], ["400", 0.62], ["500", 0.5],
  ["600", 0.42], ["700", 0.34], ["800", 0.26], ["900", 0.18], ["950", 0.11],
];

export const HARMONIES: Record<string, number[]> = {
  monochromatic: [0],
  analogous: [-30, 30],
  complementary: [180],
  "split-complementary": [150, 210],
  triadic: [120, 240],
  tetradic: [90, 180, 270],
};

export type Scale = Record<string, string>;

export function buildScale(h: number, s: number, baseHex?: string, baseL?: number): Scale {
  const scale: Scale = {};
  for (const [step, l] of STOPS) {
    const edge = Math.abs(l - 0.5) * 2;
    scale[step] = rgbToHex(hslToRgb(h, s * (1 - 0.35 * edge * edge), l));
  }
  if (baseHex && baseL !== undefined) {
    const nearest = STOPS.reduce((best, cur) => (Math.abs(cur[1] - baseL) < Math.abs(best[1] - baseL) ? cur : best));
    scale[nearest[0]] = baseHex;
  }
  return scale;
}

export interface Palette {
  base: string;
  harmony: string;
  primary: Scale;
  accents: Record<string, Scale>;
  neutral: Scale;
  semantic: Record<string, Scale>;
  on_primary: Record<string, { text: string; ratio: number }>;
  /** Best label color (white or black) on each semantic color's solid 600 step. */
  on_semantic: Record<string, { text: string; ratio: number }>;
}

export function generatePalette(baseInput: string, harmony: string): Palette {
  const base = normalizeHex(baseInput);
  if (!base) throw new Error(`"${baseInput}" is not a valid hex color (use #rgb or #rrggbb).`);
  const offsets = HARMONIES[harmony];
  if (!offsets) throw new Error(`Unknown harmony "${harmony}". Use: ${Object.keys(HARMONIES).join(", ")}.`);

  const [h, s, l] = rgbToHsl(hexToRgb(base)!);
  const primary = buildScale(h, s, base, l);

  const accents: Record<string, Scale> = {};
  offsets.forEach((o, i) => {
    const sat = harmony === "monochromatic" ? s * 0.45 : s;
    const hue = h + o;
    accents[`accent${i + 1}`] = buildScale(hue, sat, rgbToHex(hslToRgb(hue, sat, l)), l);
  });

  const neutral = buildScale(h, Math.min(s, 0.1));

  const semSat = Math.max(0.5, Math.min(0.75, s));
  const semantic: Record<string, Scale> = {};
  for (const [name, hue] of [["success", 142], ["warning", 38], ["danger", 4], ["info", 210]] as const) {
    const full = buildScale(hue, semSat);
    semantic[name] = { "100": full["100"], "600": full["600"], "800": full["800"] };
  }

  const on_primary: Palette["on_primary"] = {};
  for (const [step, hex] of Object.entries(primary)) {
    const w = contrastRatio("#ffffff", hex) ?? 0;
    const k = contrastRatio("#000000", hex) ?? 0;
    on_primary[step] = w >= k ? { text: "#ffffff", ratio: +w.toFixed(2) } : { text: "#000000", ratio: +k.toFixed(2) };
  }
  const on_semantic: Palette["on_semantic"] = {};
  for (const [name, scale] of Object.entries(semantic)) {
    const w = contrastRatio("#ffffff", scale["600"]) ?? 0;
    const k = contrastRatio("#000000", scale["600"]) ?? 0;
    on_semantic[name] = w >= k ? { text: "#ffffff", ratio: +w.toFixed(2) } : { text: "#000000", ratio: +k.toFixed(2) };
  }
  return { base, harmony, primary, accents, neutral, semantic, on_primary, on_semantic };
}

function groups(p: Palette): Record<string, Scale> {
  return { primary: p.primary, ...p.accents, neutral: p.neutral, ...p.semantic };
}

export function paletteLines(p: Palette): string[] {
  const lines: string[] = [];
  for (const [name, scale] of Object.entries(groups(p))) {
    for (const [step, hex] of Object.entries(scale)) lines.push(`  --${name}-${step}: ${hex};`);
  }
  return lines;
}

export function paletteToCss(p: Palette): string {
  return [":root {", ...paletteLines(p), "}"].join("\n");
}

export function paletteToTailwind(p: Palette): string {
  const cfg = { theme: { extend: { colors: groups(p) } } };
  return `/** @type {import('tailwindcss').Config} */\nmodule.exports = ${JSON.stringify(cfg, null, 2)};`;
}

/* ------------------------------ Color blindness ------------------------------ */

export type Vision = "protanopia" | "deuteranopia" | "tritanopia" | "achromatopsia";
export const VISIONS: Vision[] = ["protanopia", "deuteranopia", "tritanopia", "achromatopsia"];

// Machado et al. (2009), severity 1.0, applied in linear RGB.
const MATRICES: Record<Exclude<Vision, "achromatopsia">, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

export function simulate(hex: string, type: Vision): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const lin = rgb.map(srgbToLinear);
  if (type === "achromatopsia") {
    const v = linearToSrgb(0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]);
    return rgbToHex([v, v, v]);
  }
  const out = MATRICES[type].map((row) => linearToSrgb(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
  return rgbToHex(out as RGB);
}

export interface NamedColor {
  name: string;
  hex: string;
}

export interface Confusion {
  a: NamedColor;
  b: NamedColor;
  type: Vision;
  normal: number;
  simulated: number;
}

export function findConfusions(colors: NamedColor[]): Confusion[] {
  const out: Confusion[] = [];
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const normal = deltaE(colors[i].hex, colors[j].hex)!;
      if (normal < 20) continue;
      for (const type of VISIONS) {
        const simulated = deltaE(simulate(colors[i].hex, type)!, simulate(colors[j].hex, type)!)!;
        if (simulated < 10) out.push({ a: colors[i], b: colors[j], type, normal, simulated });
      }
    }
  }
  return out;
}

export function formatColorblindReport(input: NamedColor[]): string {
  const colors = input
    .map((c) => ({ name: c.name, hex: normalizeHex(c.hex) }))
    .filter((c): c is NamedColor => c.hex !== null);
  if (!colors.length) throw new Error("No valid hex colors provided.");

  const lines = ["## Color-blindness simulation", "", "| Color | Normal | Protan. | Deutan. | Tritan. | Achroma. |", "|---|---|---|---|---|---|"];
  for (const c of colors) {
    lines.push(`| ${c.name} | ${c.hex} | ${VISIONS.map((v) => simulate(c.hex, v)).join(" | ")} |`);
  }
  lines.push("");
  const confusions = findConfusions(colors);
  if (!confusions.length) {
    lines.push("No clearly different pairs become hard to tell apart. Nice.");
  } else {
    lines.push("### Pairs that become hard to tell apart");
    for (const c of confusions) {
      lines.push(
        `- **${c.a.name}** (${c.a.hex}) vs **${c.b.name}** (${c.b.hex}) under ${c.type}: distinct normally (ΔE ${c.normal.toFixed(0)}), nearly identical when simulated (ΔE ${c.simulated.toFixed(0)}). Add an icon, label or pattern, or change their lightness.`
      );
    }
  }
  lines.push("", "About 1 in 12 men and 1 in 200 women have a color-vision deficiency, so never rely on color alone.");
  return lines.join("\n");
}
