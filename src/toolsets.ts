export const GROUPS: Record<string, string[]> = {
  core: ["analyze_design", "recreate", "reimagine", "extract_tokens", "critique_design", "audit_accessibility", "audit_site", "check_contrast", "generate_design_system"],
  vision: ["analyze_design", "recreate", "reimagine", "extract_tokens", "critique_design", "audit_accessibility", "design_to_prompt", "compare_designs"],
  web: ["capture_url", "extract_css_tokens", "lint_css", "audit_site"],
  color: ["generate_palette", "simulate_colorblind", "check_contrast", "contrast_matrix", "generate_gradient", "generate_chart_palette"],
  system: ["generate_design_system", "generate_type_scale", "generate_shadows", "generate_spacing_scale", "generate_dark_theme", "generate_motion_tokens", "generate_layout_system", "suggest_font_pairings", "convert_tokens", "extract_tokens"],
  components: ["generate_component_states", "generate_form_styles", "generate_favicon"],
  quality: ["audit_accessibility", "check_contrast", "contrast_matrix", "simulate_colorblind", "lint_css", "audit_site", "originality_check", "critique_design"],
};

export const ALL_TOOLS = [
  "analyze_design", "recreate", "reimagine", "extract_tokens", "convert_tokens", "audit_accessibility", "check_contrast",
  "generate_palette", "simulate_colorblind", "generate_type_scale", "originality_check", "critique_design", "design_to_prompt",
  "generate_design_system", "suggest_font_pairings", "generate_shadows", "generate_spacing_scale", "generate_dark_theme",
  "contrast_matrix", "compare_designs", "extract_css_tokens", "lint_css", "generate_component_states", "generate_gradient",
  "generate_motion_tokens", "generate_layout_system", "capture_url", "audit_site", "generate_form_styles", "generate_favicon",
  "generate_chart_palette",
];

/**
 * RED_TOOLS controls which tools load. Comma-separated groups or tool names; prefix with - to exclude.
 * Examples: "core", "core,web", "all,-capture_url". Default: all.
 * Add "auto" to let the host model discover the rest on demand (find_tools and run_tool):
 * "auto" alone exposes only those two; "core,auto" pins the core tools and leaves the rest discoverable.
 */
export function parseToolset(spec?: string): (name: string) => boolean {
  const items = (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const include = new Set<string>();
  const exclude = new Set<string>();
  let all = !items.some((i) => !i.startsWith("-"));
  for (const item of items) {
    const neg = item.startsWith("-");
    const key = neg ? item.slice(1) : item;
    if (key === "all") {
      if (!neg) all = true;
      continue;
    }
    if (key === "auto") continue;
    for (const name of GROUPS[key] ?? [key]) (neg ? exclude : include).add(name);
  }
  return (name) => !exclude.has(name) && (all || include.has(name));
}

export function wantsGateway(spec?: string): boolean {
  return (spec ?? "").split(",").map((s) => s.trim()).includes("auto");
}

export function unknownEntries(spec?: string): string[] {
  return (spec ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^-/, ""))
    .filter((k) => k && k !== "all" && k !== "auto" && !GROUPS[k] && !ALL_TOOLS.includes(k));
}
