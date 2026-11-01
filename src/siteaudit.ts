import { extractCssTokens } from "./cssparse.js";
import { findConfusions } from "./color.js";
import { runLint } from "./lint.js";
import { formatContrastMatrix } from "./system.js";
import { RATIOS } from "./typography.js";

export function analyzeScale(sizes: number[]): { summary: string; irregular: boolean } {
  const s = [...new Set(sizes)].sort((a, b) => a - b);
  if (s.length < 3) return { summary: "Too few font sizes to judge a scale.", irregular: false };
  const ratios = s.slice(1).map((v, i) => v / s[i]);
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const spread = Math.max(...ratios.map((r) => Math.abs(r - avg)));
  const [name] = Object.entries(RATIOS).reduce((b, c) => (Math.abs(c[1] - avg) < Math.abs(b[1] - avg) ? c : b));
  const irregular = spread > 0.12;
  return {
    irregular,
    summary: `${s.map((v) => `${v}px`).join(", ")}. Average step ${avg.toFixed(2)} (closest to ${name}), ${irregular ? "irregular: steps vary a lot" : "consistent"}.`,
  };
}

export function auditCss(css: string, label: string): string {
  const { tokens, stats } = extractCssTokens(css);
  const lint = runLint(css, JSON.stringify(tokens));
  const colors = Object.entries(tokens.colors);
  const sizes = Object.values(tokens.fontSizes).map((v) => parseFloat(v));
  const scale = analyzeScale(sizes);
  const confusions = findConfusions(colors.slice(0, 12).map(([name, hex]) => ({ name, hex })));

  const overall = Math.max(0, lint.score - Math.min(9, confusions.length * 3) - (scale.irregular ? 5 : 0));
  const list = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "none found";

  const out = [
    `## Site audit: ${label}`,
    `**Overall: ${overall}/100** · ${stats.rules} rules, ${stats.distinctColors} distinct colors, ${stats.fontFamilies} font families, ${stats.fontSizes} font sizes`,
    "",
    "### Design language",
    `- **Palette:** ${colors.map(([k, v]) => `${k} ${v}`).join(", ") || "none found"}`,
    `- **Fonts:** ${list(tokens.fontFamilies)}`,
    `- **Type scale:** ${scale.summary}`,
    `- **Radii:** ${list(tokens.radii)}`,
    `- **Common spacing:** ${list(tokens.spacing)}`,
    `- **Shadows:** ${Object.keys(tokens.shadows).length || "none"} found`,
    "",
    "### Quality findings",
  ];
  out.push(...(lint.findings.length ? lint.findings.map((f) => `- [${f.sev}] ${f.msg}`) : ["No issues found."]));

  if (colors.length >= 2) {
    out.push("", formatContrastMatrix(colors.slice(0, 6).map(([name, hex]) => ({ name, hex }))).replace(/^## /, "### Palette accessibility\n#### "));
  }

  out.push("", "### Color-blind risks");
  if (confusions.length) {
    for (const c of confusions.slice(0, 5)) out.push(`- ${c.a.name} (${c.a.hex}) and ${c.b.name} (${c.b.hex}) become hard to tell apart under ${c.type}.`);
  } else out.push("No clearly different color pairs collapse under simulated color blindness.");

  const fixes: string[] = [
    ...lint.findings.filter((f) => f.sev === "high").map((f) => f.msg),
    ...lint.findings.filter((f) => f.sev === "medium").map((f) => f.msg),
    ...confusions.slice(0, 2).map((c) => `Do not rely on color alone to separate ${c.a.name} and ${c.b.name}; add an icon, label or pattern.`),
    ...(scale.irregular ? ["Adopt a modular type scale (see generate_type_scale) to replace ad hoc font sizes."] : []),
    ...lint.findings.filter((f) => f.sev === "low").map((f) => f.msg),
  ].slice(0, 5);
  out.push("", "### Top fixes", ...(fixes.length ? fixes.map((f, i) => `${i + 1}. ${f}`) : ["Nothing urgent. This is in good shape."]));
  out.push("", "_Next: `generate_design_system` can consolidate this into a clean system, and `convert_tokens` exports these tokens._");
  return out.join("\n");
}
