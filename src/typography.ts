export const RATIOS: Record<string, number> = {
  "minor-second": 1.067,
  "major-second": 1.125,
  "minor-third": 1.2,
  "major-third": 1.25,
  "perfect-fourth": 1.333,
  "augmented-fourth": 1.414,
  "perfect-fifth": 1.5,
  golden: 1.618,
};

const NAMES = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl"];

export interface ScaleOptions {
  base: number;
  ratio: number;
  stepsDown: number;
  stepsUp: number;
  fluid: boolean;
  minViewport: number;
  maxViewport: number;
}

export interface ScaleRow {
  name: string;
  step: number;
  px: number;
  rem: number;
  lineHeight: number;
  value: string;
}

const r4 = (n: number) => +n.toFixed(4);

function lineHeight(step: number): number {
  if (step < 0) return 1.5;
  if (step === 0) return 1.6;
  if (step >= 5) return 1.1;
  if (step >= 3) return 1.2;
  return 1.3;
}

export function typeScale(o: ScaleOptions): ScaleRow[] {
  const rows: ScaleRow[] = [];
  const ratioMin = 1 + (o.ratio - 1) * 0.8;
  for (let step = -o.stepsDown; step <= o.stepsUp; step++) {
    const px = o.base * Math.pow(o.ratio, step);
    let value = `${r4(px / 16)}rem`;
    if (o.fluid) {
      const a = o.base * Math.pow(ratioMin, step);
      const b = (o.base + 2) * Math.pow(o.ratio, step);
      const slope = (b - a) / (o.maxViewport - o.minViewport);
      const intercept = a - slope * o.minViewport;
      const lo = r4(Math.min(a, b) / 16);
      const hi = r4(Math.max(a, b) / 16);
      value = `clamp(${lo}rem, ${r4(intercept / 16)}rem + ${r4(slope * 100)}vw, ${hi}rem)`;
    }
    rows.push({ name: NAMES[step + 2], step, px: r4(px), rem: r4(px / 16), lineHeight: lineHeight(step), value });
  }
  return rows;
}

export function typeScaleLines(rows: ScaleRow[]): string[] {
  return [
    ...rows.map((r) => `  --text-${r.name}: ${r.value};`),
    ...rows.map((r) => `  --leading-${r.name}: ${r.lineHeight};`),
  ];
}

export function typeScaleToCss(rows: ScaleRow[]): string {
  return [":root {", ...typeScaleLines(rows), "}"].join("\n");
}
