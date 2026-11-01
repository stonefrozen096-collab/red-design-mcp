import { contrastRatio, extractJson } from "./a11y.js";
import { deltaE } from "./color.js";
import { colorsIn, firstFamily, parseRules, stripComments, toPx } from "./cssparse.js";
import { flatColors } from "./system.js";

type Sev = "high" | "medium" | "low";

export interface LintFinding {
  sev: Sev;
  msg: string;
}

export interface LintResult {
  score: number;
  findings: LintFinding[];
  stats: { rules: number; colors: number; sizes: number; families: number };
}

export function runLint(raw: string, tokensJson?: string): LintResult {
  const css = stripComments(raw);
  const rules = parseRules(css);
  if (!rules.length) throw new Error("No CSS rules found.");

  const findings: LintFinding[] = [];
  const add = (sev: Sev, msg: string) => findings.push({ sev, msg });

  const colors = new Set<string>();
  const sizes = new Set<number>();
  const families = new Set<string>();
  const offGrid = new Set<number>();
  const small = new Set<number>();
  const noOutline: string[] = [];
  const lowContrast: string[] = [];
  let motion = false;

  for (const r of rules) {
    const map = new Map(r.decls);
    for (const [prop, val] of r.decls) {
      for (const c of colorsIn(val)) colors.add(c);
      if (prop === "font-size") {
        const px = toPx(val);
        if (px !== null && px > 0) {
          sizes.add(Math.round(px * 10) / 10);
          if (px < 12) small.add(Math.round(px * 10) / 10);
        }
      } else if (prop === "font-family") {
        const f = firstFamily(val);
        if (f) families.add(f);
      } else if (/^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left))?$/.test(prop)) {
        for (const t of val.split(/\s+/)) {
          const px = toPx(t);
          if (px !== null && px > 2 && Math.round(px) % 4 !== 0) offGrid.add(Math.round(px));
        }
      } else if (/^(animation|transition)/.test(prop)) motion = true;
    }
    const outline = map.get("outline") ?? "";
    const removesOutline = /^(none|0)\b/.test(outline) || map.get("outline-style") === "none";
    const isFocusRingRule = /:focus/.test(r.selector) && map.has("box-shadow");
    if (removesOutline && !isFocusRingRule) noOutline.push(r.selector);

    const bgVal = map.get("background-color") ?? map.get("background") ?? "";
    const fg = colorsIn(map.get("color") ?? "")[0];
    const bg = /gradient|url\(/i.test(bgVal) ? undefined : colorsIn(bgVal)[0];
    if (fg && bg) {
      const ratio = contrastRatio(fg, bg) ?? 21;
      if (ratio < 4.5) lowContrast.push(`\`${r.selector}\`: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }

  if (lowContrast.length) add("high", `Low text contrast (needs 4.5:1 unless large text): ${lowContrast.slice(0, 5).join("; ")}${lowContrast.length > 5 ? "; ..." : ""}`);
  if (noOutline.length && !/:focus-visible/.test(css)) add("high", `${noOutline.length} rule(s) remove the focus outline and no :focus-visible style exists: ${noOutline.slice(0, 4).map((s) => `\`${s}\``).join(", ")}`);
  if (small.size) add("medium", `Text below 12px hurts readability: ${[...small].sort((a, b) => a - b).join("px, ")}px`);
  if (colors.size > 12) add("medium", `${colors.size} distinct colors. Consolidate into a palette of design tokens.`);
  if (sizes.size > 8) add("medium", `${sizes.size} distinct font sizes. Use a type scale (see generate_type_scale).`);
  if (families.size > 3) add("medium", `${families.size} font families (${[...families].slice(0, 4).join(", ")}). Two is usually plenty.`);
  if (motion && !/prefers-reduced-motion/.test(css)) add("medium", "Animations or transitions without a prefers-reduced-motion override.");
  if (offGrid.size) add("low", `Spacing off the 4px grid: ${[...offGrid].sort((a, b) => a - b).slice(0, 8).join("px, ")}px`);
  const important = (css.match(/!important/gi) ?? []).length;
  if (important > 5) add("low", `${important} uses of !important. Fix specificity instead.`);

  if (tokensJson) {
    const tokenColors = Object.values(flatColors(extractJson(tokensJson).colors ?? extractJson(tokensJson)));
    if (tokenColors.length) {
      const drift = [...colors].filter((c) => Math.min(...tokenColors.map((t) => deltaE(c, t) ?? 100)) > 6);
      if (drift.length) add("medium", `${drift.length} color(s) not in your tokens: ${drift.slice(0, 6).join(", ")}`);
    }
  }

  const count = (s: Sev) => findings.filter((f) => f.sev === s).length;
  const score = Math.max(0, 100 - count("high") * 10 - count("medium") * 5 - count("low") * 2);
  return { score, findings, stats: { rules: rules.length, colors: colors.size, sizes: sizes.size, families: families.size } };
}

export function formatLint(r: LintResult): string {
  const count = (s: Sev) => r.findings.filter((f) => f.sev === s).length;
  const lines = [
    "## CSS lint",
    `Score: **${r.score}/100** · ${count("high")} high, ${count("medium")} medium, ${count("low")} low`,
    `${r.stats.rules} rules · ${r.stats.colors} colors · ${r.stats.sizes} font sizes · ${r.stats.families} font families`,
  ];
  for (const sev of ["high", "medium", "low"] as const) {
    const list = r.findings.filter((f) => f.sev === sev);
    if (list.length) lines.push("", `### ${sev[0].toUpperCase() + sev.slice(1)}`, ...list.map((f) => `- ${f.msg}`));
  }
  if (!r.findings.length) lines.push("", "No issues found. Nice work.");
  return lines.join("\n");
}

export function lintCss(raw: string, tokensJson?: string): string {
  return formatLint(runLint(raw, tokensJson));
}
