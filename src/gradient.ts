import { contrastRatio, hexToRgb } from "./a11y.js";
import { normalizeHex, rgbToHex, type RGB } from "./color.js";

const toLin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const toSrgb = (c: number) => {
  const v = Math.max(0, Math.min(1, c));
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
};

export function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex)!.map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function fromOklab(L: number, a: number, b: number): string {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const rgb: RGB = [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
  return rgbToHex(rgb);
}

export function mixOklab(a: string, b: string, t: number): string {
  const x = toOklab(a), y = toOklab(b);
  return fromOklab(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}

export type GradientType = "linear" | "radial" | "conic";

export function generateGradient(input: string[], type: GradientType, angle: number, perSegment: number) {
  const colors = input.map((c) => normalizeHex(c));
  if (colors.some((c) => c === null)) throw new Error("All colors must be valid hex values.");
  const list = colors as string[];
  const pts = type === "conic" ? [...list, list[0]] : list;

  const stops: { color: string; pos: number }[] = [];
  const segs = pts.length - 1;
  for (let i = 0; i < segs; i++) {
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment;
      stops.push({ color: k === 0 ? pts[i] : mixOklab(pts[i], pts[i + 1], t), pos: +(((i + t) / segs) * 100).toFixed(1) });
    }
  }
  stops.push({ color: pts[pts.length - 1], pos: 100 });

  const list2 = stops.map((s) => `${s.color} ${s.pos}%`).join(", ");
  const plain = pts.join(", ");
  let fallback: string, modern: string;
  if (type === "linear") {
    fallback = `linear-gradient(${angle}deg, ${list2})`;
    modern = `linear-gradient(${angle}deg in oklab, ${plain})`;
  } else if (type === "radial") {
    fallback = `radial-gradient(circle at 30% 20%, ${list2})`;
    modern = `radial-gradient(circle at 30% 20% in oklab, ${plain})`;
  } else {
    fallback = `conic-gradient(from ${angle}deg, ${list2})`;
    modern = `conic-gradient(from ${angle}deg in oklab, ${plain})`;
  }

  const min = (label: string) => Math.min(...stops.map((s) => contrastRatio(label, s.color) ?? 0));
  const white = min("#ffffff");
  const black = min("#000000");
  const verdict = (r: number) => (r >= 4.5 ? "passes AA" : r >= 3 ? "large text only" : "fails");
  const text = [
    `White text: lowest ${white.toFixed(2)}:1 across the gradient (${verdict(white)})`,
    `Black text: lowest ${black.toFixed(2)}:1 across the gradient (${verdict(black)})`,
  ];
  return { css: `background: ${fallback};\nbackground: ${modern};`, stops, text };
}
