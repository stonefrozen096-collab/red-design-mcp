import { contrastRatio } from "./a11y.js";
import { VISIONS, deltaE, normalizeHex, simulate } from "./color.js";
import { fromOklab, toOklab } from "./gradient.js";

// Okabe-Ito colorblind-safe palette, ordered so the first few colors are the most distinct.
const CATEGORICAL = ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#f0e442", "#000000"];

export type ChartKind = "categorical" | "sequential" | "diverging";

/** Light to dark ramp with steadily falling OKLab lightness. */
export function sequential(baseInput: string, n: number): string[] {
  const base = normalizeHex(baseInput);
  if (!base) throw new Error(`"${baseInput}" is not a valid hex color.`);
  const [, a, b] = toOklab(base);
  const chroma = Math.max(Math.hypot(a, b), 0.09);
  const hue = Math.atan2(b, a);
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const L = 0.96 - t * 0.7;
    const c = chroma * Math.sin(Math.PI * (0.12 + 0.76 * t));
    return fromOklab(L, c * Math.cos(hue), c * Math.sin(hue));
  });
}

export function diverging(lowInput: string, highInput: string, n: number): string[] {
  const half = (n - 1) / 2;
  const left = sequential(lowInput, half + 1).slice(1).reverse();
  const right = sequential(highInput, half + 1).slice(1);
  return [...left, "#f3f3f3", ...right];
}

export interface ChartPalette {
  kind: ChartKind;
  colors: string[];
  notes: string[];
}

export function generateChartPalette(kind: ChartKind, n: number, base?: string, low?: string, high?: string): ChartPalette {
  const notes: string[] = [];
  let colors: string[];

  if (kind === "categorical") {
    if (n > CATEGORICAL.length) throw new Error(`Categorical palettes above ${CATEGORICAL.length} colors are hard to tell apart. Group smaller categories, or use up to ${CATEGORICAL.length}.`);
    colors = CATEGORICAL.slice(0, n);
    for (const type of VISIONS.filter((v) => v !== "achromatopsia")) {
      let min = Infinity;
      for (let i = 0; i < colors.length; i++)
        for (let j = i + 1; j < colors.length; j++)
          min = Math.min(min, deltaE(simulate(colors[i], type)!, simulate(colors[j], type)!) ?? Infinity);
      if (colors.length > 1) notes.push(`${type}: closest pair ΔE ${min.toFixed(0)} (${min >= 15 ? "clearly distinct" : min >= 10 ? "distinct, but add direct labels" : "risky, use labels or patterns"})`);
    }
  } else if (kind === "sequential") {
    colors = sequential(base ?? "#2563eb", n);
    const ls = colors.map((c) => toOklab(c)[0]);
    notes.push(ls.every((l, i) => i === 0 || l < ls[i - 1]) ? "Lightness falls steadily, so order reads correctly in grayscale and for color-blind viewers." : "Lightness is not strictly monotonic at the gamut edge; try a less saturated base.");
  } else {
    if (n % 2 === 0) throw new Error("Diverging palettes need an odd number of colors so there is a neutral midpoint.");
    colors = diverging(low ?? "#2563eb", high ?? "#d55e00", n);
    notes.push("The neutral midpoint marks the center value. Keep the two ends in different hues.");
  }

  const worst = Math.min(...colors.map((c) => Math.max(contrastRatio("#ffffff", c) ?? 0, contrastRatio("#000000", c) ?? 0)));
  notes.push(`Every color supports a readable label in white or black (lowest best-case contrast ${worst.toFixed(1)}:1).`);
  return { kind, colors, notes };
}
