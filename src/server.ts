import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askVision, hasApiKey, loadImage, resolveProvider, type LoadedImage } from "./vision.js";

import { TOKENS_PROMPT, parseTokens, toCss, toDtcg, toFigma, toTailwind } from "./tokens.js";
import { AUDIT_PROMPT, evaluatePairs, extractJson, formatReport } from "./a11y.js";
import { generatePalette, paletteToCss, paletteToTailwind, formatColorblindReport } from "./color.js";
import { RATIOS, typeScale, typeScaleToCss } from "./typography.js";
import { originalityReport } from "./originality.js";
import { CRITIQUE_PROMPT, TARGET_PROMPTS, comparePrompt, formatCritique, type PromptTarget } from "./critique.js";
import { extractCssTokens } from "./cssparse.js";
import { generateChartPalette } from "./dataviz.js";
import { parseToolset, unknownEntries, wantsGateway } from "./toolsets.js";
import { findToolsText, runTool, type ToolEntry } from "./gateway.js";
import { auditCss } from "./siteaudit.js";
import { generateFavicon, generateFormStyles } from "./ui.js";
import { registerPrompts } from "./prompts.js";
import { assertHttp, collectCss } from "./web.js";
import { lintCss } from "./lint.js";
import { VARIANTS, generateComponentStates } from "./states.js";
import { generateGradient } from "./gradient.js";
import { layoutCss, motionCss } from "./foundations.js";
import { MOODS, formatContrastMatrix, formatPairings, generateDarkTheme, generateDesignSystem, generateShadows, generateSpacing } from "./system.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
const server = new McpServer({ name: "red-design-mcp", version: pkg.version });

// RED_TOOLS limits which tools load (groups or names, "-name" excludes). Default: all.
// Add "auto" to let the host model discover the remaining tools with find_tools and run_tool.
const toolEnabled = parseToolset(process.env.RED_TOOLS);
const registry: ToolEntry[] = [];
const registerTool = server.registerTool.bind(server) as (...args: any[]) => unknown;
(server as any).registerTool = (name: string, config: any, handler: any) => {
  registry.push({ name, config, handler });
  return toolEnabled(name) ? registerTool(name, config, handler) : undefined;
};

/**
 * Host mode: with no API key configured, return the image(s) plus instructions so the
 * host model (Claude Code, Codex, ...) does the visual work itself. No second key needed.
 */
function hostMode(images: LoadedImage[], instructions: string) {
  return {
    content: [
      ...images.map((i) => ({ type: "image" as const, data: i.base64, mimeType: i.mediaType })),
      {
        type: "text" as const,
        text: `No model provider is configured, so you (the host model) do the visual work. Look at the attached image(s) and follow these instructions exactly.\n\n${instructions}`,
      },
    ],
  };
}

const ANALYZE_PROMPT = `You are a senior UI/UX designer. Analyze this design and reply with ONLY valid JSON:
{
  "summary": "one-line description",
  "layout": { "type": "grid|flex|stack|freeform", "sections": [ { "name": "", "role": "", "children": [] } ] },
  "colors": { "background": "", "surface": "", "primary": "", "secondary": "", "text": "", "accent": "" },
  "typography": { "families": [], "scale": [ { "role": "h1", "size": "", "weight": "" } ] },
  "spacing": { "base": "", "notes": "" },
  "shape": { "radius": "", "shadows": "", "borders": "" },
  "components": [ { "type": "", "variant": "", "notes": "" } ],
  "style_keywords": [],
  "accessibility_issues": []
}
Use hex values for colors. Be specific and measurable.`;

server.registerTool(
  "analyze_design",
  {
    title: "Analyze Design",
    description:
      "Analyze a design image (local file path or URL) and return a structured JSON spec: layout, colors, typography, spacing, components and style keywords.",
    inputSchema: {
      image: z.string().describe("Local file path or http(s) URL of the design image"),
    },
  },
  async ({ image }) => {
    try {
      const img = await loadImage(image);
      if (!hasApiKey()) return hostMode([img], ANALYZE_PROMPT);
      const text = await askVision(img, ANALYZE_PROMPT);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `analyze_design failed: ${(err as Error).message}` }],
      };
    }
  }
);

const FORMATS = {
  html: "a single self-contained HTML file with inline CSS (and minimal JS only if needed)",
  react: "a single React functional component (default export) using CSS modules-free inline <style> or plain CSS classes",
  tailwind: "a single HTML file using Tailwind utility classes via the Tailwind CDN script",
} as const;

server.registerTool(
  "recreate",
  {
    title: "Recreate Design",
    description:
      "Recreate a design as production-quality code. Provide an image (path or URL), a JSON spec from analyze_design, or both. Returns code only.",
    inputSchema: {
      image: z.string().optional().describe("Local file path or http(s) URL of the design image"),
      spec: z.string().optional().describe("JSON spec returned by analyze_design"),
      format: z.enum(["html", "react", "tailwind"]).default("html").describe("Output code format"),
      responsive: z.boolean().default(true).describe("Make the result mobile, tablet and desktop friendly"),
      fix_accessibility: z.boolean().default(true).describe("Fix contrast, tap-target and semantic issues"),
    },
  },
  async ({ image, spec, format, responsive, fix_accessibility }) => {
    try {
      if (!image && !spec) throw new Error("Provide an image, a spec, or both.");
      const img = image ? await loadImage(image) : null;

      const prompt = `You are a senior front-end engineer and designer. Recreate the design as ${FORMATS[format]}.
${spec ? `Use this design spec as the source of truth:\n${spec}\n` : ""}${img ? "Match the attached image closely: layout, colors, typography, spacing, radius and shadows.\n" : ""}Rules:
- ${responsive ? "Fully responsive (mobile-first, works from 360px to wide desktop)." : "Desktop layout is fine."}
- ${fix_accessibility ? "Fix accessibility: WCAG AA contrast, semantic HTML, alt text, visible focus states, 44px tap targets." : "Keep the original look even if contrast is imperfect."}
- Use CSS variables for colors and spacing so it is easy to retheme.
- Never use remote images; use CSS gradients, inline SVG or placeholders.
- Do not copy logos or trademarked artwork; use neutral placeholders.
- Reply with ONLY the code in one fenced block, no explanation.`;

      if (!hasApiKey()) return hostMode(img ? [img] : [], prompt);
      const text = await askVision(img, prompt);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `recreate failed: ${(err as Error).message}` }],
      };
    }
  }
);

const STYLES = [
  "minimal", "brutalist", "glassmorphism", "neumorphism", "retro-futuristic",
  "editorial", "playful", "luxury", "dark-mode", "high-contrast",
] as const;

function dialGuidance(dial: number): string {
  if (dial <= 20) return "Stay very faithful: keep layout and structure, only refresh surface details (colors, type, polish).";
  if (dial <= 50) return "Moderate reinterpretation: keep the content hierarchy but rework visual language, spacing rhythm and components.";
  if (dial <= 80) return "Bold reinterpretation: keep the purpose and content, but rethink layout, composition and visual style significantly.";
  return "Wild reinterpretation: keep only the purpose and content. Invent a fresh layout, metaphor and visual identity that surprises.";
}

const DIRECTIONS = [
  "Direction A: lead with typography and whitespace.",
  "Direction B: lead with color, shape and bold visual rhythm.",
  "Direction C: lead with unconventional layout and interaction details.",
];

server.registerTool(
  "reimagine",
  {
    title: "Reimagine Design",
    description:
      "Reimagine a design in a new style as code. Control how far it departs from the original with the inspiration dial (0 = faithful, 100 = wild), optionally remix with a second design, and get up to 3 variations.",
    inputSchema: {
      image: z.string().optional().describe("Local file path or http(s) URL of the source design"),
      spec: z.string().optional().describe("JSON spec from analyze_design for the source design"),
      style: z.string().default("minimal").describe(`Target style. Presets: ${STYLES.join(", ")}. Any custom description also works.`),
      dial: z.number().min(0).max(100).default(50).describe("Inspiration dial: 0 faithful ... 100 wild"),
      remix_with: z.string().optional().describe("Optional second design (path or URL): take its mood and style, keep the first design's structure"),
      variations: z.number().int().min(1).max(3).default(1).describe("How many distinct variations to generate"),
      format: z.enum(["html", "react", "tailwind"]).default("html").describe("Output code format"),
    },
  },
  async ({ image, spec, style, dial, remix_with, variations, format }) => {
    try {
      if (!image && !spec) throw new Error("Provide an image, a spec, or both.");
      const img = image ? await loadImage(image) : null;

      const hosted = !hasApiKey();
      const remixImg = remix_with ? await loadImage(remix_with) : null;
      let remixSpec = "";
      if (remixImg && !hosted) remixSpec = await askVision(remixImg, ANALYZE_PROMPT);
      const remixNote = hosted && remixImg ? "The LAST attached image is the remix design: take its mood, palette and visual language and apply them to the first design's structure and content.\n" : "";

      const build = (direction: string) => `You are an award-winning designer and front-end engineer. Reimagine the design as ${FORMATS[format]}.
${spec ? `Source design spec:\n${spec}\n` : ""}${img ? "The attached image is the source design.\n" : ""}${remixNote}${remixSpec ? `Remix: take the mood, palette and visual language from this second design and apply them to the source's structure and content:\n${remixSpec}\n` : ""}Target style: ${style}.
Inspiration dial: ${dial}/100. ${dialGuidance(dial)}
${direction}
Rules:
- Keep the original purpose and content meaning; change the look and feel as the dial allows.
- Responsive, accessible (WCAG AA contrast, semantic HTML, visible focus), CSS variables for theming.
- No remote images; use CSS, inline SVG or placeholders. Do not copy logos or trademarked artwork.
- Start with one line "Concept: ..." (max 20 words), then ONE fenced code block. Nothing else.`;

      const dirs = DIRECTIONS.slice(0, variations);
      if (hosted) {
        const many = variations > 1 ? `Produce ${variations} distinct variations, each under a "## Variation n" heading. ${dirs.join(" ")}` : dirs[0];
        return hostMode([...(img ? [img] : []), ...(remixImg ? [remixImg] : [])], build(many));
      }
      const results = await Promise.all(dirs.map((d) => askVision(img, build(d))));
      const text = results.map((r, i) => (variations > 1 ? `## Variation ${i + 1}\n${r}` : r)).join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `reimagine failed: ${(err as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "extract_tokens",
  {
    title: "Extract Design Tokens",
    description:
      "Extract design tokens (colors, fonts, spacing, radii, shadows) from a design and export them as CSS variables, a Tailwind config, W3C design tokens JSON, or Figma (Tokens Studio) JSON.",
    inputSchema: {
      image: z.string().optional().describe("Local file path or http(s) URL of the design image"),
      spec: z.string().optional().describe("JSON spec from analyze_design"),
      format: z.enum(["css", "tailwind", "json", "figma"]).default("css").describe("Export format. 'figma' = Tokens Studio JSON, 'json' = W3C design tokens"),
    },
  },
  async ({ image, spec, format }) => {
    try {
      if (!image && !spec) throw new Error("Provide an image, a spec, or both.");
      const img = image ? await loadImage(image) : null;
      const prompt = `${TOKENS_PROMPT}${spec ? `\n\nDesign spec to use:\n${spec}` : ""}`;
      if (!hasApiKey()) {
        return hostMode(
          img ? [img] : [],
          `${prompt}\n\nThen call the convert_tokens tool with that JSON and format "${format}" to get the final export.`
        );
      }
      const tokens = parseTokens(await askVision(img, prompt));
      const convert = { css: toCss, tailwind: toTailwind, json: toDtcg, figma: toFigma }[format];
      return { content: [{ type: "text", text: convert(tokens) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `extract_tokens failed: ${(err as Error).message}` }],
      };
    }
  }
);

server.registerTool(
  "convert_tokens",
  {
    title: "Convert Design Tokens",
    description: "Convert a design-tokens JSON object (colors, fontFamilies, fontSizes, fontWeights, spacing, radii, shadows) into CSS variables, a Tailwind config, W3C tokens JSON, or Figma (Tokens Studio) JSON. Deterministic, no API key needed.",
    inputSchema: {
      tokens: z.string().describe("Tokens JSON string"),
      format: z.enum(["css", "tailwind", "json", "figma"]).default("css"),
    },
  },
  async ({ tokens, format }) => {
    try {
      const convert = { css: toCss, tailwind: toTailwind, json: toDtcg, figma: toFigma }[format];
      return { content: [{ type: "text", text: convert(parseTokens(tokens)) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `convert_tokens failed: ${(err as Error).message}` }] };
    }
  }
);

server.registerTool(
  "check_contrast",
  {
    title: "Check Contrast",
    description: "Compute exact WCAG contrast ratios for color pairs and suggest the closest passing color for failures. Deterministic, no API key needed.",
    inputSchema: {
      pairs: z.array(z.object({
        element: z.string().describe("What the pair is, e.g. 'body text'"),
        foreground: z.string().describe("Hex color"),
        background: z.string().describe("Hex color"),
        large_text: z.boolean().default(false),
        kind: z.enum(["text", "ui"]).default("text"),
      })),
    },
  },
  async ({ pairs }) => ({ content: [{ type: "text", text: formatReport(evaluatePairs(pairs)) }] })
);

server.registerTool(
  "audit_accessibility",
  {
    title: "Audit Accessibility",
    description: "Audit a design image against WCAG 2.2: exact contrast ratios with suggested fixes, plus tap targets, text size, focus, labels and color-only meaning. Returns a scored report.",
    inputSchema: {
      image: z.string().describe("Local file path or http(s) URL of the design image"),
    },
  },
  async ({ image }) => {
    try {
      const img = await loadImage(image);
      if (!hasApiKey()) {
        return hostMode([img], `${AUDIT_PROMPT}\n\nAfter you have the JSON, call the check_contrast tool with the "pairs" array to get exact WCAG ratios and fixes, then present the report together with the "issues".`);
      }
      const data = extractJson(await askVision(img, AUDIT_PROMPT));
      return { content: [{ type: "text", text: formatReport(evaluatePairs(data.pairs ?? []), data.issues ?? []) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `audit_accessibility failed: ${(err as Error).message}` }] };
    }
  }
);

/* ------------------------------ Deterministic tools ------------------------------ */

const fail = (tool: string, err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `${tool} failed: ${(err as Error).message}` }],
});

server.registerTool(
  "generate_palette",
  {
    title: "Generate Color Palette",
    description:
      "Generate a complete, accessible color system from one base color: a 50-950 primary scale, harmony accents, tinted neutrals, semantic colors (success, warning, danger, info) and the best label color on each primary step and each semantic color. Deterministic, no API key needed.",
    inputSchema: {
      base: z.string().describe("Base brand color as hex, e.g. #e11d48"),
      harmony: z
        .enum(["monochromatic", "analogous", "complementary", "split-complementary", "triadic", "tetradic"])
        .default("analogous"),
      format: z.enum(["json", "css", "tailwind"]).default("json"),
    },
  },
  async ({ base, harmony, format }) => {
    try {
      const p = generatePalette(base, harmony);
      const out = format === "css" ? paletteToCss(p) : format === "tailwind" ? paletteToTailwind(p) : JSON.stringify(p, null, 2);
      return { content: [{ type: "text", text: out }] };
    } catch (err) {
      return fail("generate_palette", err);
    }
  }
);

server.registerTool(
  "simulate_colorblind",
  {
    title: "Simulate Color Blindness",
    description:
      "Simulate protanopia, deuteranopia, tritanopia and achromatopsia for a list of colors and flag pairs that look different normally but become hard to tell apart (like red vs green status badges). Deterministic, no API key needed.",
    inputSchema: {
      colors: z
        .array(z.object({ name: z.string().optional().describe("Label, e.g. 'error badge'"), hex: z.string() }))
        .min(1),
    },
  },
  async ({ colors }) => {
    try {
      const named = colors.map((c: { name?: string; hex: string }) => ({ name: c.name ?? c.hex, hex: c.hex }));
      return { content: [{ type: "text", text: formatColorblindReport(named) }] };
    } catch (err) {
      return fail("simulate_colorblind", err);
    }
  }
);

server.registerTool(
  "generate_type_scale",
  {
    title: "Generate Type Scale",
    description:
      "Generate a modular typography scale with matching line heights, optionally fluid (CSS clamp) so text scales smoothly between a mobile and desktop viewport. Deterministic, no API key needed.",
    inputSchema: {
      base: z.number().min(10).max(32).default(16).describe("Base font size in px"),
      ratio: z
        .union([z.enum(["minor-second", "major-second", "minor-third", "major-third", "perfect-fourth", "augmented-fourth", "perfect-fifth", "golden"]), z.number().min(1.05).max(2)])
        .default("major-third"),
      steps_down: z.number().int().min(0).max(2).default(2),
      steps_up: z.number().int().min(1).max(8).default(6),
      fluid: z.boolean().default(false),
      min_viewport: z.number().default(360),
      max_viewport: z.number().default(1280),
      format: z.enum(["css", "json"]).default("css"),
    },
  },
  async ({ base, ratio, steps_down, steps_up, fluid, min_viewport, max_viewport, format }) => {
    try {
      const r = typeof ratio === "number" ? ratio : RATIOS[ratio];
      const rows = typeScale({ base, ratio: r, stepsDown: steps_down, stepsUp: steps_up, fluid, minViewport: min_viewport, maxViewport: max_viewport });
      return { content: [{ type: "text", text: format === "json" ? JSON.stringify(rows, null, 2) : typeScaleToCss(rows) }] };
    } catch (err) {
      return fail("generate_type_scale", err);
    }
  }
);

server.registerTool(
  "originality_check",
  {
    title: "Originality Check",
    description:
      "Compare two designs (the source and your recreation or reimagination) and score how similar their palette, typography, shape and spacing are, with tips to differentiate. Pass the JSON from extract_tokens or analyze_design for each. Deterministic, no API key needed.",
    inputSchema: {
      source: z.string().describe("Tokens or spec JSON of the original design"),
      candidate: z.string().describe("Tokens or spec JSON of the new design"),
    },
  },
  async ({ source, candidate }) => {
    try {
      return { content: [{ type: "text", text: originalityReport(source, candidate) }] };
    } catch (err) {
      return fail("originality_check", err);
    }
  }
);

/* ---------------------------------- Vision tools --------------------------------- */

server.registerTool(
  "critique_design",
  {
    title: "Critique Design",
    description:
      "Get a rigorous senior-designer critique of a design: scores for hierarchy, spacing, color, typography, consistency and usability, plus strengths, prioritized issues with fixes, and quick wins.",
    inputSchema: {
      image: z.string().describe("Local file path or http(s) URL of the design image"),
    },
  },
  async ({ image }) => {
    try {
      const img = await loadImage(image);
      if (!hasApiKey()) {
        return hostMode(
          [img],
          `${CRITIQUE_PROMPT}\n\nPresent the result as a readable markdown report instead of raw JSON: an overall score out of 100, a bar per category, strengths, prioritized issues with fixes, and quick wins.`
        );
      }
      const data = extractJson(await askVision(img, CRITIQUE_PROMPT));
      return { content: [{ type: "text", text: formatCritique(data) }] };
    } catch (err) {
      return fail("critique_design", err);
    }
  }
);

server.registerTool(
  "design_to_prompt",
  {
    title: "Design to Prompt",
    description:
      "Turn a design image into a ready-to-paste prompt for an AI UI generator (v0, Lovable, Bolt), an image model, or a developer handoff spec.",
    inputSchema: {
      image: z.string().describe("Local file path or http(s) URL of the design image"),
      target: z.enum(["ui-generator", "image-model", "dev-handoff"]).default("ui-generator"),
    },
  },
  async ({ image, target }) => {
    try {
      const img = await loadImage(image);
      const prompt = `${TARGET_PROMPTS[target as PromptTarget]}\nDo not name brands, artists or trademarked characters. Reply with only the result.`;
      if (!hasApiKey()) return hostMode([img], prompt);
      return { content: [{ type: "text", text: await askVision(img, prompt) }] };
    } catch (err) {
      return fail("design_to_prompt", err);
    }
  }
);

/* ------------------------------ Design system toolkit ------------------------------ */

server.registerTool(
  "generate_design_system",
  {
    title: "Generate Design System",
    description:
      "One call, a complete starter design system from a brand color and a mood: color scales, light and dark semantic themes, font pairing, fluid type scale, spacing, radii, layered shadows, base styles, and verified contrast checks. Deterministic, no API key needed.",
    inputSchema: {
      brand: z.string().describe("Brand color as hex, e.g. #e11d48"),
      mood: z.enum(MOODS).default("modern").describe("Drives the font pairing"),
      harmony: z.enum(["monochromatic", "analogous", "complementary", "split-complementary", "triadic", "tetradic"]).default("analogous"),
      base_font_size: z.number().min(12).max(24).default(16),
      type_ratio: z.enum(["minor-second", "major-second", "minor-third", "major-third", "perfect-fourth", "augmented-fourth", "perfect-fifth", "golden"]).default("major-third"),
      spacing_base: z.number().min(2).max(16).default(4),
      shadow_style: z.enum(["soft", "crisp"]).default("soft"),
      radius: z.enum(["sharp", "soft", "round"]).default("soft"),
      format: z.enum(["css", "json"]).default("css"),
    },
  },
  async ({ brand, mood, harmony, base_font_size, type_ratio, spacing_base, shadow_style, radius, format }) => {
    try {
      const ds = generateDesignSystem({
        brand, mood, harmony,
        baseFontSize: base_font_size,
        typeRatio: RATIOS[type_ratio],
        spacingBase: spacing_base,
        shadowStyle: shadow_style,
        radius,
      });
      if (format === "json") return { content: [{ type: "text", text: JSON.stringify(ds.json, null, 2) }] };
      const fence = "`".repeat(3);
      return {
        content: [{ type: "text", text: `## Design system\n${ds.summary}\n\n${fence}css\n${ds.css}\n${fence}\n\n### Contrast checks\n${ds.checks.join("\n")}` }],
      };
    } catch (err) {
      return fail("generate_design_system", err);
    }
  }
);

server.registerTool(
  "suggest_font_pairings",
  {
    title: "Suggest Font Pairings",
    description: "Curated Google Fonts pairings for a mood, with the @import and CSS font stacks (with safe fallbacks) ready to paste. Deterministic, no API key needed.",
    inputSchema: {
      mood: z.enum(MOODS),
      count: z.number().int().min(1).max(5).default(3),
    },
  },
  async ({ mood, count }) => ({ content: [{ type: "text", text: formatPairings(mood, count) }] })
);

server.registerTool(
  "generate_shadows",
  {
    title: "Generate Shadow Scale",
    description: "Layered elevation shadows (xs to 2xl) in a soft or crisp style, tinted to a base color. Deterministic, no API key needed.",
    inputSchema: {
      color: z.string().default("#0f172a").describe("Shadow tint as hex"),
      style: z.enum(["soft", "crisp"]).default("soft"),
      levels: z.number().int().min(1).max(6).default(5),
      format: z.enum(["css", "json"]).default("css"),
    },
  },
  async ({ color, style, levels, format }) => {
    try {
      const list = generateShadows(color, style, levels);
      const text = format === "json" ? JSON.stringify(list, null, 2) : [":root {", ...list.map((s) => `  --shadow-${s.name}: ${s.value};`), "}"].join("\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return fail("generate_shadows", err);
    }
  }
);

server.registerTool(
  "generate_spacing_scale",
  {
    title: "Generate Spacing Scale",
    description: "A consistent spacing scale from a base unit (4 or 8 are common), in rem or px. Deterministic, no API key needed.",
    inputSchema: {
      base: z.number().min(2).max(16).default(4),
      unit: z.enum(["px", "rem"]).default("rem"),
      format: z.enum(["css", "json"]).default("css"),
    },
  },
  async ({ base, unit, format }) => {
    const list = generateSpacing(base, unit);
    const text = format === "json" ? JSON.stringify(list, null, 2) : [":root {", ...list.map((s) => `  --space-${s.key}: ${s.value};`), "}"].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

server.registerTool(
  "generate_dark_theme",
  {
    title: "Generate Dark Theme",
    description: "Turn a light design's tokens JSON into a dark theme (data-theme and prefers-color-scheme), re-checking text and accent contrast against the new background and fixing failures. Deterministic, no API key needed.",
    inputSchema: {
      tokens: z.string().describe("Tokens JSON with a `colors` object (from extract_tokens or your own)"),
    },
  },
  async ({ tokens }) => {
    try {
      return { content: [{ type: "text", text: generateDarkTheme(tokens) }] };
    } catch (err) {
      return fail("generate_dark_theme", err);
    }
  }
);

server.registerTool(
  "contrast_matrix",
  {
    title: "Contrast Matrix",
    description: "Check every text-on-background combination across a set of colors at once, with AA/AAA labels and the best accessible combos. Deterministic, no API key needed.",
    inputSchema: {
      colors: z.array(z.object({ name: z.string().optional(), hex: z.string() })).min(2).max(12),
    },
  },
  async ({ colors }) => {
    try {
      return { content: [{ type: "text", text: formatContrastMatrix(colors) }] };
    } catch (err) {
      return fail("contrast_matrix", err);
    }
  }
);

server.registerTool(
  "compare_designs",
  {
    title: "Compare Designs",
    description: "Compare two design images: what is the same, what differs, a verdict, and the top 5 changes to either match the first design or differentiate from it.",
    inputSchema: {
      image_a: z.string().describe("Path or URL of design A (the reference)"),
      image_b: z.string().describe("Path or URL of design B"),
      goal: z.enum(["match", "differentiate"]).default("match"),
    },
  },
  async ({ image_a, image_b, goal }) => {
    try {
      const [a, b] = await Promise.all([loadImage(image_a), loadImage(image_b)]);
      if (!hasApiKey()) return hostMode([a, b], comparePrompt(goal));
      const [sa, sb] = await Promise.all([askVision(a, ANALYZE_PROMPT), askVision(b, ANALYZE_PROMPT)]);
      const out = await askVision(null, `${comparePrompt(goal)}\n\nDesign A spec:\n${sa}\n\nDesign B spec:\n${sb}`);
      return { content: [{ type: "text", text: out }] };
    } catch (err) {
      return fail("compare_designs", err);
    }
  }
);

/* --------------------------- Web, lint and UI-state tools --------------------------- */

const fenceOf = (lang: string, body: string) => `${"`".repeat(3)}${lang}\n${body}\n${"`".repeat(3)}`;

server.registerTool(
  "extract_css_tokens",
  {
    title: "Extract Tokens from CSS or a Website",
    description:
      "Read a live website's stylesheets (or CSS you paste) and extract design tokens: colors, fonts, font sizes, radii, spacing and shadows. No screenshot or API key needed. Best on sites with real stylesheets; for pages styled by JavaScript, use capture_url with the vision tools.",
    inputSchema: {
      url: z.string().optional().describe("Page URL (http or https)"),
      css: z.string().optional().describe("CSS text to analyze instead of a URL"),
      format: z.enum(["json", "css", "tailwind", "w3c", "figma"]).default("json"),
    },
  },
  async ({ url, css, format }) => {
    try {
      if (!url && !css) throw new Error("Provide a url or css.");
      let source = css ?? "";
      let note = "";
      if (!css && url) {
        const got = await collectCss(url);
        source = got.css;
        note = `Read ${got.sheets} stylesheet(s) from ${url}. `;
      }
      const { tokens, stats } = extractCssTokens(source);
      const summary = `${note}Found ${stats.rules} rules, ${stats.distinctColors} distinct colors, ${stats.fontFamilies} font families and ${stats.fontSizes} font sizes.`;
      const out =
        format === "css" ? fenceOf("css", toCss(tokens))
        : format === "tailwind" ? fenceOf("js", toTailwind(tokens))
        : format === "w3c" ? fenceOf("json", toDtcg(tokens))
        : format === "figma" ? fenceOf("json", toFigma(tokens))
        : fenceOf("json", JSON.stringify(tokens, null, 2));
      return { content: [{ type: "text", text: `${summary}\n\n${out}` }] };
    } catch (err) {
      return fail("extract_css_tokens", err);
    }
  }
);

server.registerTool(
  "lint_css",
  {
    title: "Lint CSS for Design Quality",
    description:
      "Lint CSS (pasted or from a URL) for design-system problems: low text contrast, removed focus outlines, tiny text, too many colors, font sizes or families, off-grid spacing, missing reduced-motion support, and colors that drift from your tokens. Returns a score. Deterministic, no API key needed.",
    inputSchema: {
      css: z.string().optional().describe("CSS text"),
      url: z.string().optional().describe("Page URL to read stylesheets from"),
      tokens: z.string().optional().describe("Optional tokens JSON to check color drift against"),
    },
  },
  async ({ css, url, tokens }) => {
    try {
      if (!css && !url) throw new Error("Provide css or a url.");
      const source = css ?? (await collectCss(url as string)).css;
      return { content: [{ type: "text", text: lintCss(source, tokens) }] };
    } catch (err) {
      return fail("lint_css", err);
    }
  }
);

server.registerTool(
  "generate_component_states",
  {
    title: "Generate Button States",
    description:
      "Generate complete, accessible button CSS from one brand color: default, hover, active, focus-visible and disabled for primary, secondary, ghost and danger variants, with every state's contrast verified. Deterministic, no API key needed.",
    inputSchema: {
      brand: z.string().describe("Brand color as hex"),
      variants: z.array(z.enum(VARIANTS)).min(1).default([...VARIANTS]),
    },
  },
  async ({ brand, variants }) => {
    try {
      const r = generateComponentStates(brand, variants);
      return { content: [{ type: "text", text: `${fenceOf("css", r.css)}\n\n### Contrast checks\n${r.checks.join("\n")}` }] };
    } catch (err) {
      return fail("generate_component_states", err);
    }
  }
);

server.registerTool(
  "generate_gradient",
  {
    title: "Generate Smooth Gradient",
    description:
      "Build a smooth gradient from 2 to 5 colors, interpolated in OKLab so the middle never turns muddy. Returns CSS with a fallback plus a modern `in oklab` version, and tells you whether white or black text stays readable across the whole gradient. Deterministic, no API key needed.",
    inputSchema: {
      colors: z.array(z.string()).min(2).max(5),
      type: z.enum(["linear", "radial", "conic"]).default("linear"),
      angle: z.number().min(0).max(360).default(135),
      smoothness: z.number().int().min(1).max(8).default(3).describe("Extra stops between colors"),
    },
  },
  async ({ colors, type, angle, smoothness }) => {
    try {
      const g = generateGradient(colors, type, angle, smoothness);
      return { content: [{ type: "text", text: `${fenceOf("css", g.css)}\n\n### Text over this gradient\n${g.text.join("\n")}` }] };
    } catch (err) {
      return fail("generate_gradient", err);
    }
  }
);

server.registerTool(
  "generate_motion_tokens",
  {
    title: "Generate Motion Tokens",
    description: "Duration and easing tokens (instant to slower; standard, enter, exit, spring) in a snappy, balanced or relaxed feel, with an automatic prefers-reduced-motion override. Deterministic, no API key needed.",
    inputSchema: { style: z.enum(["snappy", "balanced", "relaxed"]).default("balanced") },
  },
  async ({ style }) => ({ content: [{ type: "text", text: fenceOf("css", motionCss(style)) }] })
);

server.registerTool(
  "generate_layout_system",
  {
    title: "Generate Layout System",
    description: "A responsive container and column grid in plain CSS (mobile-first, stacks below the chosen breakpoint) using Tailwind, Bootstrap or Material breakpoints. Deterministic, no API key needed.",
    inputSchema: {
      columns: z.number().int().min(1).max(24).default(12),
      gutter: z.number().min(0).max(80).default(24),
      max_width: z.number().min(320).max(2400).default(1200),
      preset: z.enum(["tailwind", "bootstrap", "material"]).default("tailwind"),
      columns_from: z.string().default("md").describe("Breakpoint name where columns start, e.g. md"),
    },
  },
  async ({ columns, gutter, max_width, preset, columns_from }) => {
    try {
      return { content: [{ type: "text", text: fenceOf("css", layoutCss({ columns, gutter, maxWidth: max_width, preset, spanAt: columns_from })) }] };
    } catch (err) {
      return fail("generate_layout_system", err);
    }
  }
);

server.registerTool(
  "capture_url",
  {
    title: "Capture Website Screenshot",
    description:
      "Take a screenshot of a web page and return it as an image. It is also saved to a file whose path you can pass to analyze_design, recreate, reimagine and the other vision tools. Needs Google Chrome installed, or Chromium via `npx playwright-core install chromium`.",
    inputSchema: {
      url: z.string().describe("Page URL (http or https)"),
      width: z.number().int().min(320).max(2560).default(1440),
      height: z.number().int().min(480).max(2000).default(900),
      full_page: z.boolean().default(false),
      mobile: z.boolean().default(false).describe("Emulate a 390px-wide phone"),
    },
  },
  async ({ url, width, height, full_page, mobile }) => {
    let browser: any;
    try {
      const target = assertHttp(url);
      const spec = "playwright-core";
      const pw: any = await import(spec).catch(() => null);
      if (!pw) throw new Error("playwright-core is not installed. Run: npm install -g playwright-core (or reinstall red-design-mcp with optional dependencies).");
      const chromium = pw.chromium ?? pw.default?.chromium;
      try {
        browser = await chromium.launch({ channel: "chrome" });
      } catch {
        try {
          browser = await chromium.launch();
        } catch {
          throw new Error("No browser found. Install Google Chrome, or run: npx playwright-core install chromium");
        }
      }
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : width, height: mobile ? 844 : height },
        deviceScaleFactor: mobile ? 2 : 1,
        isMobile: mobile,
      });
      await page.goto(target.href, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(800);
      const buf: Buffer = await page.screenshot({ type: "jpeg", quality: 80, fullPage: full_page });
      const dir = join(tmpdir(), "red-design-mcp");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `capture-${Date.now()}.jpg`);
      await writeFile(file, buf);
      return {
        content: [
          { type: "image" as const, data: buf.toString("base64"), mimeType: "image/jpeg" },
          { type: "text" as const, text: `Saved to ${file}. Pass this path to analyze_design, recreate, reimagine, critique_design or audit_accessibility.` },
        ],
      };
    } catch (err) {
      return fail("capture_url", err);
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }
);

server.registerTool(
  "audit_site",
  {
    title: "Audit Site",
    description:
      "An autonomous design audit of a live website (or pasted CSS) in one call: extracts the design language, lints quality, checks palette contrast, finds color-blind risks, analyzes the type scale, and ends with a scored list of the top fixes. Deterministic, no API key needed.",
    inputSchema: {
      url: z.string().optional().describe("Page URL (http or https)"),
      css: z.string().optional().describe("CSS text to audit instead of a URL"),
    },
  },
  async ({ url, css }) => {
    try {
      if (!url && !css) throw new Error("Provide a url or css.");
      const source = css ?? (await collectCss(url as string)).css;
      return { content: [{ type: "text", text: auditCss(source, css ? "pasted CSS" : (url as string)) }] };
    } catch (err) {
      return fail("audit_site", err);
    }
  }
);

server.registerTool(
  "generate_form_styles",
  {
    title: "Generate Form Styles",
    description:
      "Accessible form CSS from one brand color: labels, inputs, placeholders, hover, focus-visible, error and disabled states, help and error text, and checkbox/radio accents, with every contrast requirement verified. Deterministic, no API key needed.",
    inputSchema: {
      brand: z.string().describe("Brand color as hex"),
      error: z.string().default("#dc2626").describe("Error color as hex"),
    },
  },
  async ({ brand, error }) => {
    try {
      const r = generateFormStyles(brand, error);
      return { content: [{ type: "text", text: `${fenceOf("css", r.css)}\n\n### Contrast checks\n${r.checks.join("\n")}` }] };
    } catch (err) {
      return fail("generate_form_styles", err);
    }
  }
);

server.registerTool(
  "generate_favicon",
  {
    title: "Generate Favicon",
    description:
      "Create a crisp SVG monogram favicon (1 or 2 letters) on a square, rounded or circle shape in your brand color, with the letter color chosen for readable contrast, plus the HTML tags to use it. Deterministic, no API key needed.",
    inputSchema: {
      text: z.string().min(1).max(2).describe("1 or 2 characters"),
      color: z.string().describe("Background color as hex"),
      shape: z.enum(["square", "rounded", "circle"]).default("rounded"),
      text_color: z.string().optional().describe("Optional letter color as hex"),
    },
  },
  async ({ text, color, shape, text_color }) => {
    try {
      const f = generateFavicon(text, color, shape, text_color);
      return {
        content: [
          {
            type: "text",
            text: `Save as favicon.svg:\n${fenceOf("svg", f.svg)}\n\nAdd to <head>:\n${fenceOf("html", f.html)}\n\nLetter contrast: ${f.ratio.toFixed(2)}:1. For PNG sizes (apple-touch-icon, 192/512), export this SVG with any converter.`,
          },
        ],
      };
    } catch (err) {
      return fail("generate_favicon", err);
    }
  }
);

server.registerTool(
  "generate_chart_palette",
  {
    title: "Generate Chart Palette",
    description:
      "Data-visualization colors that stay readable for everyone: a colorblind-safe categorical palette (up to 8), a sequential ramp from one color with steadily falling lightness, or a diverging palette with a neutral midpoint. Includes verification notes. Deterministic, no API key needed.",
    inputSchema: {
      kind: z.enum(["categorical", "sequential", "diverging"]).default("categorical"),
      count: z.number().int().min(2).max(11).default(6),
      base: z.string().optional().describe("Sequential only: base color as hex"),
      low: z.string().optional().describe("Diverging only: color for the low end"),
      high: z.string().optional().describe("Diverging only: color for the high end"),
      format: z.enum(["json", "css"]).default("json"),
    },
  },
  async ({ kind, count, base, low, high, format }) => {
    try {
      const p = generateChartPalette(kind, count, base, low, high);
      const prefix = kind === "categorical" ? "chart" : kind === "sequential" ? "seq" : "div";
      const body =
        format === "css"
          ? fenceOf("css", [":root {", ...p.colors.map((c, i) => `  --${prefix}-${i + 1}: ${c};`), "}"].join("\n"))
          : fenceOf("json", JSON.stringify(p.colors));
      return { content: [{ type: "text", text: `${body}\n\n${p.notes.map((n) => `- ${n}`).join("\n")}` }] };
    } catch (err) {
      return fail("generate_chart_palette", err);
    }
  }
);

function registerGateway(hidden: ToolEntry[]): void {
  const validate = (shape: any, args: unknown) => {
    const r = z.object(shape).safeParse(args);
    return r.success
      ? { ok: true as const, data: r.data }
      : { ok: false as const, error: r.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
  };
  const toObject = (a: unknown): unknown => {
    if (typeof a !== "string") return a;
    try {
      return JSON.parse(a);
    } catch {
      return {};
    }
  };

  registerTool(
    "find_tools",
    {
      title: "Find red design tools",
      description:
        "Describe what you want to do in plain words (for example: check a website's accessibility, build a color palette, turn a screenshot into code) and get the best-matching red design tools with their parameters. Call this first, then use run_tool. Call with no task to list every area.",
      inputSchema: {
        task: z.string().default("").describe("What you want to do"),
        limit: z.number().int().min(1).max(10).default(5),
      },
    },
    async ({ task, limit }: { task: string; limit: number }) => ({
      content: [{ type: "text" as const, text: findToolsText(hidden, task, limit) }],
    })
  );

  registerTool(
    "run_tool",
    {
      title: "Run a red design tool",
      description: "Run a red design tool by name with an args object. Get names and parameters from find_tools.",
      inputSchema: {
        name: z.string().describe("Tool name from find_tools"),
        args: z.union([z.record(z.any()), z.string()]).default({}).describe("Arguments object for that tool"),
      },
    },
    async ({ name, args }: { name: string; args: unknown }) => runTool(hidden, name, toObject(args), validate)
  );
}

export async function startServer(): Promise<void> {
  if (wantsGateway(process.env.RED_TOOLS)) {
    const hidden = registry.filter((e) => !toolEnabled(e.name));
    if (hidden.length) registerGateway(hidden);
  }
  registerPrompts(server);
  await server.connect(new StdioServerTransport());
  const bad = unknownEntries(process.env.RED_TOOLS);
  if (bad.length) console.error(`red-design-mcp: unknown RED_TOOLS entries ignored: ${bad.join(", ")}`);
  console.error(`red-design-mcp ${pkg.version} running on stdio (${resolveProvider() ? `API mode: ${resolveProvider()!.label}` : "host mode, no key needed"}, tools: ${process.env.RED_TOOLS || "all"})`);
}
