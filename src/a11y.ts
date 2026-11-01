export interface PairInput {
  element: string;
  foreground: string;
  background: string;
  large_text?: boolean;
  kind?: "text" | "ui";
}

export interface PairResult extends PairInput {
  ratio: number | null;
  required: number;
  passAA: boolean;
  passAAA: boolean;
  suggestion?: string;
}

export interface Issue {
  category?: string;
  severity?: "high" | "medium" | "low";
  description?: string;
  fix?: string;
}

export const AUDIT_PROMPT = `You are an accessibility specialist (WCAG 2.2). Audit this design and reply with ONLY valid JSON, no fences:
{
  "pairs": [ { "element": "primary button label", "foreground": "#hex", "background": "#hex", "large_text": false, "kind": "text" } ],
  "issues": [ { "category": "contrast|tap-target|semantics|focus|text-size|color-only|alt-text|motion", "severity": "high|medium|low", "description": "", "fix": "" } ]
}
Rules:
- List every distinct foreground/background color pair (body text, headings, buttons, links, placeholders, icons, borders of inputs).
- Estimate hex values as precisely as you can.
- large_text is true only for text of 24px+ or 18.66px+ bold. Use kind "ui" for icons and component borders.
- Also report non-contrast issues you can see: small tap targets, tiny text, color-only meaning, missing labels or alt text, weak focus cues.`;

export function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex(rgb: [number, number, number]): string {
  return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance(rgb: [number, number, number]): number {
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

export function contrastRatio(fg: string, bg: string): number | null {
  const a = hexToRgb(fg);
  const b = hexToRgb(bg);
  if (!a || !b) return null;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Nudge the foreground toward black or white until it reaches the required ratio. */
export function suggestFix(fg: string, bg: string, required: number): string | undefined {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  if (!f || !b) return undefined;
  const target: [number, number, number] =
    contrastRatio("#000000", bg)! >= contrastRatio("#ffffff", bg)! ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const mixed = f.map((v, i) => v + (target[i] - v) * t) as [number, number, number];
    const hex = toHex(mixed);
    if ((contrastRatio(hex, bg) ?? 0) >= required) return hex;
  }
  return toHex(target);
}

export function evaluatePairs(pairs: PairInput[]): PairResult[] {
  return pairs.map((p) => {
    const ratio = contrastRatio(p.foreground, p.background);
    const isUi = p.kind === "ui";
    const required = isUi || p.large_text ? 3 : 4.5;
    const aaa = isUi ? 3 : p.large_text ? 4.5 : 7;
    const passAA = ratio !== null && ratio >= required;
    return {
      ...p,
      ratio,
      required,
      passAA,
      passAAA: ratio !== null && ratio >= aaa,
      suggestion: !passAA && ratio !== null ? suggestFix(p.foreground, p.background, required) : undefined,
    };
  });
}

export function extractJson(raw: string): any {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function formatReport(results: PairResult[], issues: Issue[] = []): string {
  const failing = results.filter((r) => !r.passAA).length;
  let score = 100 - Math.min(40, failing * 8);
  for (const i of issues) score -= i.severity === "high" ? 10 : i.severity === "medium" ? 5 : 2;
  score = Math.max(0, score);

  const lines = [`## Accessibility report`, `Score: ${score}/100 (${failing} of ${results.length} color pairs fail WCAG AA)`, ""];
  if (results.length) {
    lines.push("| Element | Colors | Ratio | Needs | AA | Fix |", "|---|---|---|---|---|---|");
    for (const r of results) {
      lines.push(
        `| ${r.element} | ${r.foreground} on ${r.background} | ${r.ratio ? r.ratio.toFixed(2) : "?"} | ${r.required}:1 | ${r.passAA ? "pass" : "FAIL"} | ${r.suggestion ? `use ${r.suggestion}` : "-"} |`
      );
    }
    lines.push("");
  }
  if (issues.length) {
    lines.push("### Other issues");
    for (const i of issues) lines.push(`- [${i.severity ?? "info"}] ${i.category ?? "general"}: ${i.description ?? ""}${i.fix ? ` Fix: ${i.fix}` : ""}`);
  }
  return lines.join("\n");
}
