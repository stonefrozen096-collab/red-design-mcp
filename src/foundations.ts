export type MotionStyle = "snappy" | "balanced" | "relaxed";

const DURATIONS: [string, number][] = [["instant", 80], ["fast", 140], ["base", 220], ["slow", 340], ["slower", 520]];
const EASINGS: [string, string][] = [
  ["standard", "cubic-bezier(0.2, 0, 0, 1)"],
  ["enter", "cubic-bezier(0, 0, 0, 1)"],
  ["exit", "cubic-bezier(0.3, 0, 1, 1)"],
  ["spring", "cubic-bezier(0.34, 1.56, 0.64, 1)"],
];
const SCALE: Record<MotionStyle, number> = { snappy: 0.75, balanced: 1, relaxed: 1.4 };

const dur = (style: MotionStyle) => DURATIONS.map(([n, ms]) => [n, Math.round((ms * SCALE[style]) / 10) * 10] as const);

export function motionLines(style: MotionStyle): string[] {
  return [
    ...dur(style).map(([n, ms]) => `  --duration-${n}: ${ms}ms;`),
    ...EASINGS.map(([n, v]) => `  --ease-${n}: ${v};`),
  ];
}

export function motionCss(style: MotionStyle): string {
  return [
    ":root {",
    ...motionLines(style),
    "}",
    "",
    "/* Respect users who prefer less motion */",
    "@media (prefers-reduced-motion: reduce) {",
    "  :root {",
    ...dur(style).map(([n]) => `    --duration-${n}: 0.01ms;`),
    "  }",
    "}",
    "",
    "/* Usage: transition: transform var(--duration-base) var(--ease-standard); */",
  ].join("\n");
}

const BREAKPOINTS: Record<string, Record<string, number>> = {
  tailwind: { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 },
  bootstrap: { sm: 576, md: 768, lg: 992, xl: 1200, xxl: 1400 },
  material: { sm: 600, md: 905, lg: 1240, xl: 1440 },
};
export const PRESETS = Object.keys(BREAKPOINTS);

export function layoutCss(o: { columns: number; gutter: number; maxWidth: number; preset: string; spanAt: string }): string {
  const bps = BREAKPOINTS[o.preset];
  if (!bps) throw new Error(`Unknown preset "${o.preset}". Use: ${PRESETS.join(", ")}.`);
  const at = bps[o.spanAt] ?? bps.md ?? Object.values(bps)[1];
  const cols = Array.from({ length: o.columns }, (_, i) => `  .col-${i + 1} { grid-column: span ${i + 1}; }`);
  return [
    "/* Breakpoints (media queries cannot read CSS variables, so these are reference values) */",
    ":root {",
    `  --gutter: ${o.gutter}px;`,
    `  --container-max: ${o.maxWidth}px;`,
    ...Object.entries(bps).map(([k, v]) => `  --bp-${k}: ${v}px;`),
    "}",
    "",
    ".container { width: 100%; max-width: var(--container-max); margin-inline: auto; padding-inline: clamp(16px, 4vw, var(--gutter)); }",
    `.grid { display: grid; grid-template-columns: repeat(${o.columns}, minmax(0, 1fr)); gap: var(--gutter); }`,
    '.grid > [class*="col-"] { grid-column: 1 / -1; }',
    "",
    `/* Columns activate from ${at}px; below that everything stacks */`,
    `@media (min-width: ${at}px) {`,
    ...cols,
    "}",
  ].join("\n");
}
