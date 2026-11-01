export interface Tokens {
  colors: Record<string, string>;
  fontFamilies: Record<string, string>;
  fontSizes: Record<string, string>;
  fontWeights: Record<string, string>;
  spacing: Record<string, string>;
  radii: Record<string, string>;
  shadows: Record<string, string>;
}

export const TOKENS_PROMPT = `You are a design-systems engineer. Extract design tokens and reply with ONLY valid JSON, no fences:
{
  "colors": { "primary": "#hex", "background": "#hex", "text": "#hex" },
  "fontFamilies": { "heading": "", "body": "" },
  "fontSizes": { "sm": "14px", "base": "16px", "lg": "20px", "xl": "32px" },
  "fontWeights": { "regular": "400", "bold": "700" },
  "spacing": { "xs": "4px", "sm": "8px", "md": "16px", "lg": "24px", "xl": "40px" },
  "radii": { "sm": "4px", "md": "8px", "lg": "16px" },
  "shadows": { "card": "0 2px 8px rgba(0,0,0,0.12)" }
}
Use semantic, lowercase, kebab-case names. Colors must be hex. Include only tokens that really appear in the design.`;

const EMPTY: Tokens = {
  colors: {}, fontFamilies: {}, fontSizes: {}, fontWeights: {}, spacing: {}, radii: {}, shadows: {},
};

export function parseTokens(raw: string): Tokens {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model did not return JSON tokens.");
  return { ...EMPTY, ...JSON.parse(cleaned.slice(start, end + 1)) };
}

const GROUPS: [keyof Tokens, string][] = [
  ["colors", "color"],
  ["fontFamilies", "font"],
  ["fontSizes", "text"],
  ["fontWeights", "weight"],
  ["spacing", "space"],
  ["radii", "radius"],
  ["shadows", "shadow"],
];

export function toCss(t: Tokens): string {
  const lines = [":root {"];
  for (const [key, prefix] of GROUPS) {
    for (const [name, value] of Object.entries(t[key])) lines.push(`  --${prefix}-${name}: ${value};`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function toTailwind(t: Tokens): string {
  const config = {
    theme: {
      extend: {
        colors: t.colors,
        fontFamily: Object.fromEntries(Object.entries(t.fontFamilies).map(([k, v]) => [k, [v, "sans-serif"]])),
        fontSize: t.fontSizes,
        fontWeight: t.fontWeights,
        spacing: t.spacing,
        borderRadius: t.radii,
        boxShadow: t.shadows,
      },
    },
  };
  return `/** @type {import('tailwindcss').Config} */\nmodule.exports = ${JSON.stringify(config, null, 2)};`;
}

/** W3C Design Tokens Community Group format. */
export function toDtcg(t: Tokens): string {
  const types: Record<string, string> = {
    colors: "color", fontFamilies: "fontFamily", fontSizes: "dimension", fontWeights: "fontWeight",
    spacing: "dimension", radii: "dimension", shadows: "shadow",
  };
  const out: Record<string, any> = {};
  for (const [key] of GROUPS) {
    out[key] = Object.fromEntries(
      Object.entries(t[key]).map(([n, v]) => [n, { $value: v, $type: types[key] }])
    );
  }
  return JSON.stringify(out, null, 2);
}

/** Tokens Studio for Figma format (import via the Tokens Studio plugin). */
export function toFigma(t: Tokens): string {
  const types: Record<string, string> = {
    colors: "color", fontFamilies: "fontFamilies", fontSizes: "fontSizes", fontWeights: "fontWeights",
    spacing: "spacing", radii: "borderRadius", shadows: "boxShadow",
  };
  const group: Record<string, any> = {};
  for (const [key] of GROUPS) {
    group[key] = Object.fromEntries(
      Object.entries(t[key]).map(([n, v]) => [n, { value: v, type: types[key] }])
    );
  }
  return JSON.stringify({ global: group, $metadata: { tokenSetOrder: ["global"] } }, null, 2);
}
