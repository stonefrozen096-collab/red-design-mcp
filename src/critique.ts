export const CRITIQUE_PROMPT = `You are a principal product designer giving a rigorous, constructive design critique. Reply with ONLY valid JSON, no fences:
{
  "summary": "two-sentence overall assessment",
  "scores": { "hierarchy": 0, "spacing": 0, "color": 0, "typography": 0, "consistency": 0, "usability": 0 },
  "strengths": ["..."],
  "issues": [ { "area": "hierarchy|spacing|color|typography|consistency|usability", "severity": "high|medium|low", "problem": "", "fix": "" } ],
  "quick_wins": ["small change with big impact"]
}
Scores are integers from 0 to 10. Be specific and honest; reference concrete elements you can see.`;

const AREAS = ["hierarchy", "spacing", "color", "typography", "consistency", "usability"];

export function formatCritique(d: any): string {
  const scores: Record<string, number> = d.scores ?? {};
  const vals = AREAS.map((a) => Math.max(0, Math.min(10, Math.round(Number(scores[a]) || 0))));
  const overall = Math.round((vals.reduce((s, v) => s + v, 0) / AREAS.length) * 10);
  const lines = ["## Design critique", `Overall: **${overall}/100**`, ""];
  if (d.summary) lines.push(String(d.summary), "");
  AREAS.forEach((a, i) => lines.push(`${a.padEnd(12)} ${"█".repeat(vals[i])}${"░".repeat(10 - vals[i])} ${vals[i]}/10`));
  const code = lines.splice(lines.findIndex((l) => l.startsWith("hierarchy")));
  lines.push("```", ...code, "```");
  if (d.strengths?.length) lines.push("", "### Strengths", ...d.strengths.map((s: string) => `- ${s}`));
  if (d.issues?.length) {
    lines.push("", "### Issues to fix");
    for (const i of d.issues) lines.push(`- [${i.severity ?? "info"}] **${i.area ?? "general"}**: ${i.problem ?? ""}${i.fix ? ` Fix: ${i.fix}` : ""}`);
  }
  if (d.quick_wins?.length) lines.push("", "### Quick wins", ...d.quick_wins.map((s: string) => `- ${s}`));
  return lines.join("\n");
}

export const TARGET_PROMPTS = {
  "ui-generator":
    "Write one detailed prompt that an AI UI generator (v0, Lovable, Bolt and similar) could use to recreate this design. Cover: page purpose, sections in order, layout and grid, every component, exact hex colors, fonts, type sizes, spacing, radii, shadows, interactions and hover states, responsive behavior and the tone of the copy.",
  "image-model":
    "Write one vivid prompt for an image-generation model that captures this design's look: style, composition, color palette (named colors), lighting, materials, mood and level of detail. Keep it under 120 words.",
  "dev-handoff":
    "Write a developer handoff spec in markdown: layout structure, component inventory with states, design tokens (colors, type, spacing, radii, shadows), responsive rules, interactions and accessibility notes.",
} as const;

export type PromptTarget = keyof typeof TARGET_PROMPTS;

export function comparePrompt(goal: "match" | "differentiate"): string {
  return `You are a senior product designer comparing Design A and Design B (in the attached images, the first is A and the second is B; otherwise use the specs given).
Write a concise markdown report with these sections: "Same" (what they share), "Different" (layout, color, typography, spacing, components, tone), "Verdict" (which is stronger and why, in two sentences), and "Top 5 changes" to ${
    goal === "match" ? "make B match A as closely as possible" : "make B clearly distinct from A while keeping its purpose"
  }. Be specific and reference concrete elements.`;
}
