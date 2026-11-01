import { contrastRatio, hexToRgb, suggestFix } from "./a11y.js";
import { hslToRgb, normalizeHex, rgbToHex, rgbToHsl } from "./color.js";

const ratio = (a: string, b: string) => contrastRatio(a, b) ?? 0;
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function generateFavicon(textIn: string, colorIn: string, shape: "square" | "rounded" | "circle", textColorIn?: string) {
  const color = normalizeHex(colorIn);
  if (!color) throw new Error(`"${colorIn}" is not a valid hex color.`);
  const text = [...textIn.trim()].slice(0, 2).join("").toUpperCase();
  if (!text) throw new Error("Provide 1 or 2 characters for the monogram.");
  let fg = textColorIn ? normalizeHex(textColorIn) : null;
  if (textColorIn && !fg) throw new Error(`"${textColorIn}" is not a valid hex color.`);
  if (!fg) fg = ratio("#ffffff", color) >= ratio("#111111", color) ? "#ffffff" : "#111111";
  const size = [...text].length === 1 ? 38 : 30;
  const shapeEl =
    shape === "circle"
      ? `<circle cx="32" cy="32" r="32" fill="${color}"/>`
      : `<rect width="64" height="64" rx="${shape === "rounded" ? 14 : 0}" fill="${color}"/>`;
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    `  ${shapeEl}`,
    `  <text x="32" y="32" dy=".35em" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', Arial, sans-serif" font-size="${size}" font-weight="700" fill="${fg}">${escapeXml(text)}</text>`,
    "</svg>",
  ].join("\n");
  const html = [
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    `<meta name="theme-color" content="${color}">`,
  ].join("\n");
  return { svg, html, ratio: ratio(fg, color), fg };
}

const fromHsl = (h: number, s: number, l: number) => rgbToHex(hslToRgb(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l))));
const ensure = (fg: string, bg: string, need: number) => (ratio(fg, bg) >= need ? fg : suggestFix(fg, bg, need) ?? fg);

export function generateFormStyles(brandInput: string, errorInput = "#dc2626"): { css: string; checks: string[] } {
  const brand = normalizeHex(brandInput);
  const errorBase = normalizeHex(errorInput);
  if (!brand) throw new Error(`"${brandInput}" is not a valid hex color.`);
  if (!errorBase) throw new Error(`"${errorInput}" is not a valid hex color.`);

  const [h, s] = rgbToHsl(hexToRgb(brand)!);
  const ink = fromHsl(h, 0.2, 0.12);
  const muted = ensure("#6b7280", "#ffffff", 4.5);
  const border = ensure("#9ca3af", "#ffffff", 3);
  const borderHover = ensure(border, "#ffffff", 4.5);
  const ring = ensure(brand, "#ffffff", 3);
  const error = ensure(errorBase, "#ffffff", 4.5);

  const checks: string[] = [];
  const check = (label: string, fg: string, bg: string, need: number) => {
    const r = ratio(fg, bg);
    checks.push(`${r >= need ? "✓" : "✗"} ${label}: ${r.toFixed(2)}:1 (needs ${need}:1)`);
  };
  check("Label text", ink, "#ffffff", 4.5);
  check("Placeholder and help text", muted, "#ffffff", 4.5);
  check("Input border (UI component)", border, "#ffffff", 3);
  check("Focus ring (UI component)", ring, "#ffffff", 3);
  check("Error text", error, "#ffffff", 4.5);
  check("Error border (UI component)", error, "#ffffff", 3);
  void s;

  const css = [
    ".field { display: grid; gap: 6px; }",
    `.field label { color: ${ink}; font-weight: 600; font-size: 0.875rem; }`,
    ".input {",
    "  min-height: 44px; padding: 0 0.75rem; border-radius: 8px;",
    `  border: 1px solid ${border}; background: #ffffff; color: ${ink}; font: inherit;`,
    "  transition: border-color 150ms ease;",
    "}",
    `.input::placeholder { color: ${muted}; opacity: 1; }`,
    `.input:hover { border-color: ${borderHover}; }`,
    `.input:focus-visible { outline: 3px solid ${ring}; outline-offset: 1px; border-color: ${ring}; }`,
    `.input[aria-invalid="true"] { border-color: ${error}; }`,
    `.input[aria-invalid="true"]:focus-visible { outline-color: ${error}; }`,
    ".input:disabled { background: #f3f4f6; border-color: #d1d5db; color: #6b7280; cursor: not-allowed; }",
    `.help { color: ${muted}; font-size: 0.8125rem; }`,
    `.error-text { color: ${error}; font-size: 0.8125rem; font-weight: 500; }`,
    `input[type="checkbox"], input[type="radio"] { width: 20px; height: 20px; accent-color: ${ring}; }`,
  ].join("\n");
  return { css, checks };
}
