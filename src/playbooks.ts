export type Args = Record<string, string | undefined>;

export interface Playbook {
  name: string;
  title: string;
  description: string;
  args: { name: string; description: string; required?: boolean }[];
  build: (a: Args) => string;
}

const L = (...l: string[]) => l.join("\n");
const isUrl = (v = "") => /^https?:\/\//i.test(v);
const RULE = "Use the red tools for every measurement. Never estimate colors, contrast ratios or scales yourself.";

export const PLAYBOOKS: Playbook[] = [
  {
    name: "redesign",
    title: "Redesign a design or site",
    description: "Reimagine a design or website in a new style, then verify accessibility and originality.",
    args: [
      { name: "source", description: "Image path, or a page URL", required: true },
      { name: "style", description: "Target style, e.g. brutalist, luxury, or your own description" },
      { name: "dial", description: "Inspiration dial 0-100 (default 60)" },
    ],
    build: (a) =>
      L(
        "Redesign " + a.source + (a.style ? " in a " + a.style + " style" : "") + ".",
        RULE,
        "",
        isUrl(a.source)
          ? "1. Call `capture_url` for the page, then `extract_css_tokens` for its exact tokens."
          : "1. Call `analyze_design` on the image, then `extract_tokens`.",
        "2. Call `critique_design` and `audit_accessibility` on the screenshot or image to learn what to keep and what to fix.",
        "3. Call `reimagine` with dial " + (a.dial ?? "60") + (a.style ? ' and style "' + a.style + '"' : "") + ", asking for 3 variations.",
        "4. Choose the strongest variation and justify it in two sentences.",
        "5. Run `lint_css` on its CSS and `check_contrast` on its palette. Fix anything that fails and re-run.",
        "6. Run `originality_check` between the source tokens and the new tokens.",
        "7. Report: the final code, what changed and why, the accessibility results and the originality score."
      ),
  },
  {
    name: "clone-site",
    title: "Recreate a website in your stack",
    description: "Capture a site, extract its tokens and recreate it as clean, accessible code.",
    args: [
      { name: "url", description: "Page URL", required: true },
      { name: "format", description: "html, react or tailwind (default tailwind)" },
    ],
    build: (a) =>
      L(
        "Recreate " + a.url + " as " + (a.format ?? "tailwind") + " code.",
        RULE,
        "",
        "1. Call `extract_css_tokens` for exact colors, fonts, sizes, radii and spacing.",
        "2. Call `capture_url` for desktop, then again with mobile enabled.",
        "3. Call `analyze_design` on the screenshots to get the layout structure.",
        "4. Call `recreate` with the spec and screenshot, format " + (a.format ?? "tailwind") + ", responsive and accessibility fixes on.",
        "5. Run `lint_css` on the result and fix what it finds.",
        "6. Use neutral placeholders for logos and brand artwork. Do not copy trademarked assets or copyrighted text and images.",
        "7. Run `originality_check` against the source tokens and report the score with the code."
      ),
  },
  {
    name: "design-system",
    title: "Build a design system from a brand color",
    description: "Generate a full design system and write it into the project.",
    args: [
      { name: "brand", description: "Brand color as hex", required: true },
      { name: "mood", description: "modern, editorial, luxury, playful, technical, friendly, brutalist, corporate, elegant, minimal, retro or bold" },
      { name: "product", description: "What the product is, to guide choices" },
    ],
    build: (a) =>
      L(
        "Create a design system for brand color " + a.brand + (a.mood ? ", mood " + a.mood : "") + (a.product ? ", for " + a.product : "") + ".",
        RULE,
        "",
        "1. Call `generate_design_system` with the brand color and mood.",
        "2. Call `generate_component_states` and `generate_form_styles` for accessible buttons and inputs.",
        "3. Call `generate_gradient` for a hero gradient and confirm which text color stays readable on it.",
        "4. Call `suggest_font_pairings` if the first pairing does not fit the product.",
        "5. Write the result into the project (for example src/styles/tokens.css and components.css), following its conventions.",
        "6. Run `generate_dark_theme` if the project needs dark mode and add it.",
        "7. Report every file you created and the contrast checks that passed."
      ),
  },
  {
    name: "accessibility-pass",
    title: "Accessibility pass and fixes",
    description: "Audit a design, page or stylesheet, then fix what fails.",
    args: [{ name: "target", description: "Image path, page URL or CSS file path", required: true }],
    build: (a) =>
      L(
        "Run an accessibility pass on " + a.target + " and fix every failure.",
        RULE,
        "",
        isUrl(a.target)
          ? "1. Call `audit_site` for the page, then `capture_url` and `audit_accessibility` on the screenshot."
          : "1. For an image call `audit_accessibility`. For CSS call `lint_css`.",
        "2. Call `contrast_matrix` on the brand colors and `simulate_colorblind` on status colors.",
        "3. List failures by severity with the exact change for each (hex values, sizes).",
        "4. Apply the fixes in the codebase.",
        "5. Re-run the same checks and confirm each one now passes.",
        "6. Report before and after scores."
      ),
  },
  {
    name: "brand-refresh",
    title: "Brand refresh",
    description: "Refresh an existing look while keeping what works.",
    args: [
      { name: "current", description: "Image path or page URL of the current design", required: true },
      { name: "direction", description: "Where to take it, e.g. warmer, more premium, more playful" },
    ],
    build: (a) =>
      L(
        "Refresh the look of " + a.current + (a.direction ? ", direction: " + a.direction : "") + ".",
        RULE,
        "",
        "1. Extract current tokens with " + (isUrl(a.current) ? "`extract_css_tokens`" : "`extract_tokens`") + ".",
        "2. Call `generate_palette` from the current primary color, plus `suggest_font_pairings` for the new direction.",
        "3. Call `reimagine` at dial 35 so the identity stays recognizable.",
        "4. Call `compare_designs` between old and new to list exactly what changed.",
        "5. Call `originality_check` and `audit_accessibility` on the result.",
        "6. Report the new tokens, the changes and the accessibility results."
      ),
  },
  {
    name: "design-review",
    title: "Design review",
    description: "A senior-designer review with prioritized fixes.",
    args: [{ name: "target", description: "Image path or page URL", required: true }],
    build: (a) =>
      L(
        "Review the design at " + a.target + ".",
        RULE,
        "",
        isUrl(a.target)
          ? "1. Call `capture_url` and `audit_site`, then run `critique_design` and `audit_accessibility` on the screenshot."
          : "1. Call `critique_design` and `audit_accessibility` on the image.",
        "2. Combine the results into a verdict (two sentences) and the top 5 fixes in priority order, each with the concrete change.",
        "3. End with what is already working well."
      ),
  },
  {
    name: "polish-css",
    title: "Polish CSS to a high score",
    description: "Lint a stylesheet and iterate until it scores 90 or more.",
    args: [{ name: "target", description: "CSS file path or page URL", required: true }],
    build: (a) =>
      L(
        "Polish the CSS at " + a.target + " until `lint_css` scores 90 or more.",
        RULE,
        "",
        "1. Call `lint_css` and note the score.",
        "2. Fix high severity findings first, then medium, then low. Keep the visual design unchanged unless a fix requires otherwise.",
        "3. Call `extract_css_tokens` and replace repeated literal values with CSS variables or tokens.",
        "4. Re-run `lint_css`. Repeat up to 3 times.",
        "5. Report the score before and after and the changes you made."
      ),
  },
];
