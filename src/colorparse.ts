// Parses the CSS color syntaxes people actually write. Self-contained on purpose (no imports).

export type RGB = [number, number, number];
export interface ParsedColor {
  rgb: RGB;
  alpha: number;
}

export const SUPPORTED_COLOR_FORMATS = "hex (#rgb, #rrggbb, #rrggbbaa), rgb(), hsl(), hwb(), oklch(), oklab() or a CSS color name";

const NAMED: Record<string, string> = {
  aliceblue: "#f0f8ff",
  antiquewhite: "#faebd7",
  aqua: "#00ffff",
  aquamarine: "#7fffd4",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  bisque: "#ffe4c4",
  black: "#000000",
  blanchedalmond: "#ffebcd",
  blue: "#0000ff",
  blueviolet: "#8a2be2",
  brown: "#a52a2a",
  burlywood: "#deb887",
  cadetblue: "#5f9ea0",
  chartreuse: "#7fff00",
  chocolate: "#d2691e",
  coral: "#ff7f50",
  cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc",
  crimson: "#dc143c",
  cyan: "#00ffff",
  darkblue: "#00008b",
  darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9",
  darkgreen: "#006400",
  darkgrey: "#a9a9a9",
  darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f",
  darkorange: "#ff8c00",
  darkorchid: "#9932cc",
  darkred: "#8b0000",
  darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  darkturquoise: "#00ced1",
  darkviolet: "#9400d3",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  dimgray: "#696969",
  dimgrey: "#696969",
  dodgerblue: "#1e90ff",
  firebrick: "#b22222",
  floralwhite: "#fffaf0",
  forestgreen: "#228b22",
  fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc",
  ghostwhite: "#f8f8ff",
  gold: "#ffd700",
  goldenrod: "#daa520",
  gray: "#808080",
  green: "#008000",
  greenyellow: "#adff2f",
  grey: "#808080",
  honeydew: "#f0fff0",
  hotpink: "#ff69b4",
  indianred: "#cd5c5c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd",
  lightblue: "#add8e6",
  lightcoral: "#f08080",
  lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2",
  lightgray: "#d3d3d3",
  lightgreen: "#90ee90",
  lightgrey: "#d3d3d3",
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0",
  lime: "#00ff00",
  limegreen: "#32cd32",
  linen: "#faf0e6",
  magenta: "#ff00ff",
  maroon: "#800000",
  mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  midnightblue: "#191970",
  mintcream: "#f5fffa",
  mistyrose: "#ffe4e1",
  moccasin: "#ffe4b5",
  navajowhite: "#ffdead",
  navy: "#000080",
  oldlace: "#fdf5e6",
  olive: "#808000",
  olivedrab: "#6b8e23",
  orange: "#ffa500",
  orangered: "#ff4500",
  orchid: "#da70d6",
  palegoldenrod: "#eee8aa",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  papayawhip: "#ffefd5",
  peachpuff: "#ffdab9",
  peru: "#cd853f",
  pink: "#ffc0cb",
  plum: "#dda0dd",
  powderblue: "#b0e0e6",
  purple: "#800080",
  rebeccapurple: "#663399",
  red: "#ff0000",
  rosybrown: "#bc8f8f",
  royalblue: "#4169e1",
  saddlebrown: "#8b4513",
  salmon: "#fa8072",
  sandybrown: "#f4a460",
  seagreen: "#2e8b57",
  seashell: "#fff5ee",
  sienna: "#a0522d",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slateblue: "#6a5acd",
  slategray: "#708090",
  slategrey: "#708090",
  snow: "#fffafa",
  springgreen: "#00ff7f",
  steelblue: "#4682b4",
  tan: "#d2b48c",
  teal: "#008080",
  thistle: "#d8bfd8",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  white: "#ffffff",
  whitesmoke: "#f5f5f5",
  yellow: "#ffff00",
  yellowgreen: "#9acd32"
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (rgb: number[]): RGB => rgb.map((v) => Math.round(clamp(v, 0, 255))) as RGB;

function hslToRgb(h0: number, s: number, l: number): number[] {
  const h = ((h0 % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const toSrgb = (c: number) => {
  const v = clamp(c, 0, 1);
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
};

function oklabToRgb(L: number, a: number, b: number): number[] {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** A number, or a percentage of `scale`. "none" counts as 0. */
function num(tok: string | undefined, scale: number): number | null {
  if (tok === undefined) return null;
  if (tok === "none") return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(tok);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] ? (v / 100) * scale : v;
}

function hue(tok: string | undefined): number | null {
  if (tok === undefined) return null;
  if (tok === "none") return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/i.exec(tok);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = (m[2] ?? "deg").toLowerCase();
  return u === "turn" ? v * 360 : u === "grad" ? v * 0.9 : u === "rad" ? (v * 180) / Math.PI : v;
}

function fromFunction(name: string, body: string): ParsedColor | null {
  let main = body;
  let alphaTok: string | undefined;
  const slash = body.indexOf("/");
  if (slash !== -1) {
    main = body.slice(0, slash);
    alphaTok = body.slice(slash + 1).trim();
  }
  const t = main.trim().split(/[\s,]+/).filter(Boolean);
  if (slash === -1 && t.length === 4) alphaTok = t.pop();
  if (t.length !== 3) return null;
  let alpha = 1;
  if (alphaTok !== undefined) {
    const a = num(alphaTok, 1);
    if (a === null) return null;
    alpha = clamp(a, 0, 1);
  }

  let rgb: number[] | null = null;
  if (name === "rgb" || name === "rgba") {
    const v = t.map((x) => num(x, 255));
    if (v.some((x) => x === null)) return null;
    rgb = v as number[];
  } else if (name === "hsl" || name === "hsla") {
    const h = hue(t[0]), s = num(t[1], 1), l = num(t[2], 1);
    if (h === null || s === null || l === null) return null;
    rgb = hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1));
  } else if (name === "hwb") {
    const h = hue(t[0]), w = num(t[1], 1), b = num(t[2], 1);
    if (h === null || w === null || b === null) return null;
    const sum = w + b;
    const [ww, bb] = sum > 1 ? [w / sum, b / sum] : [w, b];
    rgb = hslToRgb(h, 1, 0.5).map((c) => (c / 255) * (1 - ww - bb) * 255 + ww * 255);
  } else if (name === "oklch") {
    const L = num(t[0], 1), C = num(t[1], 0.4), h = hue(t[2]);
    if (L === null || C === null || h === null) return null;
    const rad = (h * Math.PI) / 180;
    rgb = oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad));
  } else if (name === "oklab") {
    const L = num(t[0], 1), a = num(t[1], 0.4), b = num(t[2], 0.4);
    if (L === null || a === null || b === null) return null;
    rgb = oklabToRgb(L, a, b);
  }
  return rgb ? { rgb: round(rgb), alpha } : null;
}

export function parseColor(input: string): ParsedColor | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex && (s.startsWith("#") || hex[1].length === 3 || hex[1].length === 6)) {
    let h = hex[1];
    if (h.length <= 4) h = h.split("").map((c) => c + c).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], alpha: h.length === 8 ? n(6) / 255 : 1 };
  }
  if (s === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  if (NAMED[s]) return parseColor(NAMED[s]);

  const fn = /^(rgba?|hsla?|hwb|oklch|oklab)\(\s*([^()]*?)\s*\)$/.exec(s);
  return fn ? fromFunction(fn[1], fn[2]) : null;
}
