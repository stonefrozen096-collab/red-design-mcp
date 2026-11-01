import { contrastRatio, extractJson, hexToRgb, suggestFix } from "./a11y.js";
import { generatePalette, hslToRgb, normalizeHex, paletteLines, rgbToHex, rgbToHsl } from "./color.js";
import { RATIOS, typeScale, typeScaleLines, type ScaleRow } from "./typography.js";
import { motionLines } from "./foundations.js";

/* --------------------------------- Font pairings -------------------------------- */

export const MOODS = [
  "modern", "editorial", "luxury", "playful", "technical", "friendly",
  "brutalist", "corporate", "elegant", "minimal", "retro", "bold",
] as const;
export type Mood = (typeof MOODS)[number];

interface Font {
  name: string;
  weights: string; // e.g. "400;700"; "" for single-weight families
  kind: "sans" | "serif" | "mono";
}
interface Pairing {
  moods: Mood[];
  heading: Font;
  body: Font;
  note: string;
}

const F = (name: string, weights: string, kind: Font["kind"] = "sans"): Font => ({ name, weights, kind });

export const PAIRINGS: Pairing[] = [
  { moods: ["modern", "technical"], heading: F("Space Grotesk", "500;700"), body: F("Inter", "400;500;600"), note: "Geometric headlines with an ultra-readable body." },
  { moods: ["minimal", "modern"], heading: F("Manrope", "500;700"), body: F("Inter", "400;600"), note: "Calm, clean and product-friendly." },
  { moods: ["minimal", "friendly"], heading: F("DM Sans", "500;700"), body: F("DM Sans", "400;500"), note: "One family, tight and consistent." },
  { moods: ["editorial", "elegant"], heading: F("Playfair Display", "400;700", "serif"), body: F("Source Sans 3", "400;600"), note: "Classic high-contrast serif headlines." },
  { moods: ["editorial"], heading: F("Lora", "500;700", "serif"), body: F("Inter", "400;500"), note: "Warm serif paired with a neutral sans." },
  { moods: ["luxury", "elegant"], heading: F("Cormorant Garamond", "500;700", "serif"), body: F("Montserrat", "400;500"), note: "Refined, airy and high-end." },
  { moods: ["elegant", "luxury"], heading: F("DM Serif Display", "", "serif"), body: F("DM Sans", "400;500"), note: "Sharp display serif with a soft sans." },
  { moods: ["playful", "friendly"], heading: F("Fredoka", "500;600"), body: F("Nunito", "400;600;700"), note: "Rounded and cheerful." },
  { moods: ["playful"], heading: F("Baloo 2", "600;700"), body: F("Nunito", "400;600;700"), note: "Bouncy headlines, friendly body." },
  { moods: ["technical"], heading: F("JetBrains Mono", "500;700", "mono"), body: F("Inter", "400;500;600"), note: "Developer-tool feel." },
  { moods: ["technical", "corporate"], heading: F("IBM Plex Sans", "500;600"), body: F("IBM Plex Mono", "400;500", "mono"), note: "Engineered and precise." },
  { moods: ["friendly", "modern"], heading: F("Poppins", "500;600"), body: F("Open Sans", "400;600"), note: "Approachable and widely loved." },
  { moods: ["brutalist", "bold"], heading: F("Archivo Black", ""), body: F("Space Mono", "400;700", "mono"), note: "Heavy, raw and unapologetic." },
  { moods: ["brutalist", "technical"], heading: F("Space Grotesk", "700"), body: F("Space Mono", "400", "mono"), note: "Quirky grotesk over monospace." },
  { moods: ["corporate"], heading: F("Work Sans", "500;600;700"), body: F("Open Sans", "400;600"), note: "Trustworthy and neutral." },
  { moods: ["retro", "playful"], heading: F("Righteous", ""), body: F("Poppins", "400;500"), note: "Groovy display type with a clean body." },
  { moods: ["bold"], heading: F("Bebas Neue", ""), body: F("Roboto", "400;500;700"), note: "Condensed, loud and poster-like." },
  { moods: ["bold", "editorial"], heading: F("Montserrat", "700;800"), body: F("Merriweather", "400;700", "serif"), note: "Strong sans headlines over a readable serif." },
];

const FALLBACK: Record<Font["kind"], string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

const stack = (f: Font) => `"${f.name}", ${FALLBACK[f.kind]}`;

export function googleFontsUrl(fonts: Font[]): string {
  const byName = new Map<string, Set<number>>();
  for (const f of fonts) {
    const set = byName.get(f.name) ?? new Set<number>();
    for (const w of f.weights.split(";").filter(Boolean)) set.add(Number(w));
    byName.set(f.name, set);
  }
  const fams = [...byName].map(([name, ws]) => {
    const key = name.replace(/ /g, "+");
    return ws.size ? `family=${key}:wght@${[...ws].sort((a, b) => a - b).join(";")}` : `family=${key}`;
  });
  return `https://fonts.googleapis.com/css2?${fams.join("&")}&display=swap`;
}

export function pairingsFor(mood: Mood, count = 3): Pairing[] {
  return PAIRINGS.filter((p) => p.moods.includes(mood)).slice(0, count);
}

export function formatPairings(mood: Mood, count = 3): string {
  const list = pairingsFor(mood, count);
  const fence = "`".repeat(3);
  const out = [`## Font pairings for "${mood}"`];
  list.forEach((p, i) => {
    out.push(
      "",
      `### ${i + 1}. ${p.heading.name} + ${p.body.name}`,
      p.note,
      "",
      `${fence}css`,
      `@import url("${googleFontsUrl([p.heading, p.body])}");`,
      "",
      ":root {",
      `  --font-heading: ${stack(p.heading)};`,
      `  --font-body: ${stack(p.body)};`,
      "}",
      fence
    );
  });
  return out.join("\n");
}

/* ------------------------------ Shadows and spacing ------------------------------ */

const Y = [1, 2, 4, 8, 16, 24];
const SHADOW_NAMES = ["xs", "sm", "md", "lg", "xl", "2xl"];
const n1 = (n: number) => +n.toFixed(1);

export function generateShadows(colorHex: string, style: "soft" | "crisp", levels: number): { name: string; value: string }[] {
  const rgb = hexToRgb(colorHex);
  if (!rgb) throw new Error(`"${colorHex}" is not a valid hex color.`);
  const c = rgb.join(", ");
  return Y.slice(0, levels).map((y, i) => {
    const soft = style === "soft";
    const ambient = +((soft ? 0.04 : 0.08) + i * 0.01).toFixed(2);
    const key = +((soft ? 0.08 : 0.14) + i * 0.02).toFixed(2);
    const blur = soft ? y * 2 : y * 0.75;
    const spread = soft ? -n1(y / 4) : 0;
    return {
      name: SHADOW_NAMES[i],
      value: `0 ${n1(y / 2)}px ${n1(soft ? y : y / 2)}px rgba(${c}, ${ambient}), 0 ${y}px ${n1(blur)}px ${spread}px rgba(${c}, ${key})`,
    };
  });
}

const MULTIPLIERS = [0, 0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];

export function generateSpacing(base: number, unit: "px" | "rem"): { key: string; px: number; value: string }[] {
  const seen = new Set<number>();
  const out: { key: string; px: number; value: string }[] = [];
  for (const m of MULTIPLIERS) {
    const px = Math.round(base * m * 100) / 100;
    if (seen.has(px)) continue;
    seen.add(px);
    out.push({ key: String(px), px, value: unit === "px" ? `${px}px` : px === 0 ? "0" : `${+(px / 16).toFixed(4)}rem` });
  }
  return out;
}

/* ----------------------------------- Dark theme ---------------------------------- */

type Role = "surface" | "text" | "accent";

function roleOf(name: string): Role {
  if (/(bg|background|surface|card|panel|border|divider|overlay|layer)/i.test(name)) return "surface";
  if (/(text|foreground|fg|ink|heading|body|label|caption)/i.test(name)) return "text";
  return "accent";
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lightness = (hex: string) => rgbToHsl(hexToRgb(hex)!)[2];

function toDark(role: Role, hex: string, name = ""): string {
  const [h, s, l] = rgbToHsl(hexToRgb(hex)!);
  if (role === "surface") {
    // Borders must sit lighter than the background, and raised surfaces slightly lighter too.
    if (/(border|divider)/i.test(name)) return rgbToHex(hslToRgb(h, s * 0.5, clamp(0.16 + (1 - l) * 0.12, 0.16, 0.3)));
    if (/(surface|card|panel|layer|overlay)/i.test(name)) return rgbToHex(hslToRgb(h, s * 0.6, clamp(0.11 + (1 - l) * 0.16, 0.1, 0.26)));
    return rgbToHex(hslToRgb(h, s * 0.6, clamp(0.07 + (1 - l) * 0.16, 0.06, 0.24)));
  }
  if (role === "text") return rgbToHex(hslToRgb(h, s * 0.5, clamp(1 - l, 0.74, 0.96)));
  return rgbToHex(hslToRgb(h, s * 0.9, clamp(l + 0.08, 0.58, 0.72)));
}

export function flatColors(o: any, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = (prefix ? `${prefix}-${k}` : k).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    if (typeof v === "string") {
      const hex = normalizeHex(v);
      if (hex) out[key] = hex;
    } else if (v && typeof v === "object") Object.assign(out, flatColors(v, key));
  }
  return out;
}

export function generateDarkTheme(raw: string): string {
  const o = extractJson(raw);
  const flat = flatColors(o.colors ?? o);
  const names = Object.keys(flat);
  if (!names.length) throw new Error("No hex colors found. Pass tokens JSON with a `colors` object.");

  const mapped: Record<string, { role: Role; hex: string }> = {};
  for (const n of names) {
    const role = roleOf(n);
    mapped[n] = { role, hex: toDark(role, flat[n], n) };
  }
  const surfaces = names.filter((n) => mapped[n].role === "surface");
  const bgName = surfaces.find((n) => /(^|-)(bg|background)(-|$)/.test(n)) ?? [...surfaces].sort((a, b) => lightness(mapped[a].hex) - lightness(mapped[b].hex))[0];
  const bg = bgName ? mapped[bgName].hex : "#121212";

  const checks: string[] = [];
  for (const n of names) {
    const m = mapped[n];
    if (m.role === "surface") continue;
    const need = m.role === "text" ? 4.5 : 3;
    let ratio = contrastRatio(m.hex, bg) ?? 0;
    if (ratio < need) {
      m.hex = suggestFix(m.hex, bg, need) ?? m.hex;
      ratio = contrastRatio(m.hex, bg) ?? 0;
    }
    checks.push(`${ratio >= need ? "✓" : "✗"} ${n}: ${ratio.toFixed(2)}:1 on background (needs ${need}:1)`);
  }

  const vars = names.map((n) => `--color-${n}: ${mapped[n].hex};`);
  const fence = "`".repeat(3);
  const css = [
    ':root[data-theme="dark"] {',
    "  color-scheme: dark;",
    ...vars.map((v) => `  ${v}`),
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    '  :root:not([data-theme="light"]) {',
    "    color-scheme: dark;",
    ...vars.map((v) => `    ${v}`),
    "  }",
    "}",
  ].join("\n");
  return `## Dark theme\n\n${fence}css\n${css}\n${fence}\n\n### Contrast checks\n${checks.join("\n")}`;
}

/* ---------------------------------- Contrast matrix ------------------------------- */

export function formatContrastMatrix(input: { name?: string; hex: string }[]): string {
  const colors = input
    .map((c) => ({ name: c.name ?? c.hex, hex: normalizeHex(c.hex) }))
    .filter((c): c is { name: string; hex: string } => c.hex !== null);
  if (colors.length < 2) throw new Error("Provide at least two valid hex colors.");

  const tag = (r: number) => (r >= 7 ? "AAA" : r >= 4.5 ? "AA" : r >= 3 ? "large" : "fail");
  const lines = [
    "## Contrast matrix",
    "",
    `| Text on → | ${colors.map((c) => c.name).join(" | ")} |`,
    `|---|${colors.map(() => "---").join("|")}|`,
  ];
  const pairs: { fg: string; bg: string; r: number }[] = [];
  for (const fg of colors) {
    const cells = colors.map((bg) => {
      if (bg === fg) return "-";
      const r = contrastRatio(fg.hex, bg.hex) ?? 0;
      pairs.push({ fg: fg.name, bg: bg.name, r });
      return `${r.toFixed(1)} ${tag(r)}`;
    });
    lines.push(`| **${fg.name}** | ${cells.join(" | ")} |`);
  }
  lines.push("", "AAA 7+ · AA 4.5+ · large 3+ (large text and UI only) · fail below 3");
  const best = [...pairs].filter((p) => p.r >= 4.5).sort((a, b) => b.r - a.r);
  const seen = new Set<string>();
  const top = best.filter((p) => {
    const k = [p.fg, p.bg].sort().join("|");
    return seen.has(k) ? false : (seen.add(k), true);
  }).slice(0, 3);
  if (top.length) lines.push("", "Best accessible combos:", ...top.map((p) => `- ${p.fg} on ${p.bg} (${p.r.toFixed(1)}:1)`));
  return lines.join("\n");
}

/* ---------------------------------- Design system -------------------------------- */

const STEPS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
const RADII: Record<string, Record<string, string>> = {
  sharp: { sm: "0px", md: "2px", lg: "4px", xl: "6px" },
  soft: { sm: "4px", md: "8px", lg: "12px", xl: "20px" },
  round: { sm: "8px", md: "16px", lg: "24px", xl: "32px" },
};

export interface SystemOptions {
  brand: string;
  mood: Mood;
  harmony: string;
  baseFontSize: number;
  typeRatio: number;
  spacingBase: number;
  shadowStyle: "soft" | "crisp";
  radius: "sharp" | "soft" | "round";
}

export interface SystemResult {
  css: string;
  json: Record<string, unknown>;
  checks: string[];
  summary: string;
}

function bestOn(hex: string): string {
  return (contrastRatio("#ffffff", hex) ?? 0) >= (contrastRatio("#000000", hex) ?? 0) ? "#ffffff" : "#000000";
}

export function generateDesignSystem(o: SystemOptions): SystemResult {
  const palette = generatePalette(o.brand, o.harmony);
  const pair = pairingsFor(o.mood, 1)[0];
  const rows: ScaleRow[] = typeScale({ base: o.baseFontSize, ratio: o.typeRatio, stepsDown: 2, stepsUp: 6, fluid: true, minViewport: 360, maxViewport: 1280 });
  const spacing = generateSpacing(o.spacingBase, "rem");
  const radii = { ...RADII[o.radius], full: "9999px" };
  const shadows = generateShadows(palette.neutral["900"], o.shadowStyle, 5);
  const n = palette.neutral;
  const p = palette.primary;

  const checks: string[] = [];
  const report = (label: string, fg: string, bg: string, min: number) => {
    const r = contrastRatio(fg, bg) ?? 0;
    checks.push(`${r >= min ? "✓" : "✗"} ${label}: ${r.toFixed(2)}:1 (needs ${min}:1)`);
  };

  // Light theme
  const lightBg = n["50"];
  let lightMuted = n["600"];
  if ((contrastRatio(lightMuted, lightBg) ?? 0) < 4.5) lightMuted = suggestFix(lightMuted, lightBg, 4.5) ?? lightMuted;
  const pStep = ["500", "600", "700", "800"].find((s) => palette.on_primary[s].text === "#ffffff" && palette.on_primary[s].ratio >= 4.5) ?? "700";
  const hoverStep = STEPS[Math.min(STEPS.indexOf(pStep) + 1, STEPS.length - 1)];
  const light: Record<string, string> = {
    bg: lightBg, surface: "#ffffff", text: n["900"], muted: lightMuted, border: n["200"],
    primary: p[pStep], "primary-hover": p[hoverStep], "on-primary": "#ffffff", focus: p[pStep],
  };
  report("Light: text on background", light.text, light.bg, 4.5);
  report("Light: muted text on background", light.muted, light.bg, 4.5);
  report("Light: button label on primary", light["on-primary"], light.primary, 4.5);
  report("Light: primary on background (UI)", light.primary, light.bg, 3);

  // Dark theme
  const darkBg = n["950"];
  const darkSurface = n["900"];
  let darkMuted = n["400"];
  if ((contrastRatio(darkMuted, darkSurface) ?? 0) < 4.5) darkMuted = suggestFix(darkMuted, darkSurface, 4.5) ?? darkMuted;
  const dark: Record<string, string> = {
    bg: darkBg, surface: darkSurface, text: n["50"], muted: darkMuted, border: n["800"],
    primary: p["400"], "primary-hover": p["300"], "on-primary": bestOn(p["400"]), focus: p["400"],
  };
  report("Dark: text on surface", dark.text, dark.surface, 4.5);
  report("Dark: muted text on surface", dark.muted, dark.surface, 4.5);
  report("Dark: button label on primary", dark["on-primary"], dark.primary, 4.5);
  report("Dark: primary on background (UI)", dark.primary, dark.bg, 3);

  const sem = (m: Record<string, string>, pad: string) => Object.entries(m).map(([k, v]) => `${pad}--color-${k}: ${v};`);
  const nearest = (px: number) => spacing.reduce((b, c) => (Math.abs(c.px - px) < Math.abs(b.px - px) ? c : b)).key;
  const s8 = nearest(8);
  const s16 = nearest(16);
  const fontUrl = googleFontsUrl([pair.heading, pair.body]);

  const css = [
    `/* red-design-mcp: ${o.mood} design system for ${palette.base} (${o.harmony} harmony) */`,
    `@import url("${fontUrl}");`,
    "",
    ":root {",
    "  color-scheme: light;",
    "  /* Fonts */",
    `  --font-heading: ${stack(pair.heading)};`,
    `  --font-body: ${stack(pair.body)};`,
    "  /* Semantic colors (light) */",
    ...sem(light, "  "),
    "  /* Color scales */",
    ...paletteLines(palette),
    "  /* Type (fluid) */",
    ...typeScaleLines(rows),
    "  /* Spacing */",
    ...spacing.map((s) => `  --space-${s.key}: ${s.value};`),
    "  /* Radii */",
    ...Object.entries(radii).map(([k, v]) => `  --radius-${k}: ${v};`),
    "  /* Shadows */",
    ...shadows.map((s) => `  --shadow-${s.name}: ${s.value};`),
    "  /* Motion */",
    ...motionLines("balanced"),
    "}",
    "",
    ':root[data-theme="dark"] {',
    "  color-scheme: dark;",
    ...sem(dark, "  "),
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    '  :root:not([data-theme="light"]) {',
    "    color-scheme: dark;",
    ...sem(dark, "    "),
    "  }",
    "}",
    "",
    "*, *::before, *::after { box-sizing: border-box; }",
    "body { margin: 0; font-family: var(--font-body); font-size: var(--text-base); line-height: var(--leading-base); color: var(--color-text); background: var(--color-bg); }",
    "h1, h2, h3, h4 { font-family: var(--font-heading); line-height: 1.15; }",
    "h1 { font-size: var(--text-4xl); } h2 { font-size: var(--text-3xl); } h3 { font-size: var(--text-2xl); } h4 { font-size: var(--text-xl); }",
    "a { color: var(--color-primary); }",
    ":focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }",
    `.card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); padding: var(--space-${s16}); }`,
    `.btn { background: var(--color-primary); color: var(--color-on-primary); border: 0; border-radius: var(--radius-md); padding: var(--space-${s8}) var(--space-${s16}); min-height: 44px; font: inherit; font-weight: 600; cursor: pointer; }`,
    ".btn:hover { background: var(--color-primary-hover); }",
    "@media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }",
  ].join("\n");

  return {
    css,
    checks,
    summary: `${pair.heading.name} + ${pair.body.name} · ${o.harmony} palette from ${palette.base} · fluid type (${o.typeRatio} ratio) · ${o.radius} corners · ${o.shadowStyle} shadows · light and dark themes`,
    json: {
      brand: palette.base,
      mood: o.mood,
      fonts: { heading: stack(pair.heading), body: stack(pair.body), import: fontUrl },
      palette,
      semantic: { light, dark },
      typeScale: rows,
      spacing,
      radii,
      shadows,
    },
  };
}

export { RATIOS };
