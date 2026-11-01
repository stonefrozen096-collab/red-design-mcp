import { contrastRatio, hexToRgb, suggestFix } from "./a11y.js";
import { hslToRgb, normalizeHex, rgbToHex, rgbToHsl } from "./color.js";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const fromHsl = (h: number, s: number, l: number) => rgbToHex(hslToRgb(h, clamp01(s), clamp01(l)));
const hslOf = (hex: string) => rgbToHsl(hexToRgb(hex)!);
const ratio = (a: string, b: string) => contrastRatio(a, b) ?? 0;

/** Pick a label color that reaches 4.5:1, darkening the background only when it must. */
function solid(bgInput: string): { bg: string; label: string } {
  let bg = bgInput;
  if (ratio("#ffffff", bg) >= 4.5) return { bg, label: "#ffffff" };
  if (ratio("#111111", bg) >= 4.5) return { bg, label: "#111111" };
  const [h, s, l0] = hslOf(bg);
  for (let l = l0; l > 0; l -= 0.01) {
    bg = fromHsl(h, s, l);
    if (ratio("#ffffff", bg) >= 4.5) break;
  }
  return { bg, label: "#ffffff" };
}

/** Shift lightness by `delta`, backing off until the label still passes 4.5:1. */
function shifted(bg: string, label: string, delta: number): string {
  const [h, s, l] = hslOf(bg);
  for (let d = delta; Math.abs(d) > 0.005; d *= 0.8) {
    const c = fromHsl(h, s, l - d);
    if (ratio(label, c) >= 4.5) return c;
  }
  return bg;
}

export const VARIANTS = ["primary", "secondary", "ghost", "danger"] as const;
export type Variant = (typeof VARIANTS)[number];

export function generateComponentStates(brandInput: string, variants: Variant[]): { css: string; checks: string[] } {
  const brand = normalizeHex(brandInput);
  if (!brand) throw new Error(`"${brandInput}" is not a valid hex color.`);
  const checks: string[] = [];
  const check = (label: string, fg: string, bg: string, need = 4.5) => {
    const r = ratio(fg, bg);
    checks.push(`${r >= need ? "✓" : "✗"} ${label}: ${r.toFixed(2)}:1 (needs ${need}:1)`);
  };

  const ringBase = ratio(brand, "#ffffff") >= 3 ? brand : suggestFix(brand, "#ffffff", 3) ?? brand;
  const css: string[] = [
    ".btn {",
    `  --btn-ring: ${ringBase};`,
    "  display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem;",
    "  min-height: 44px; padding: 0 1.25rem; border: 1px solid transparent; border-radius: 8px;",
    "  font: inherit; font-weight: 600; cursor: pointer;",
    "  transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;",
    "}",
    ".btn:focus-visible { outline: 3px solid var(--btn-ring); outline-offset: 2px; }",
    '.btn:disabled, .btn[aria-disabled="true"] { cursor: not-allowed; }',
  ];
  check("Focus ring on page background (UI)", ringBase, "#ffffff", 3);

  const [h, s] = hslOf(brand);
  const disabledBg = fromHsl(h, s * 0.15, 0.88);
  const disabledFg = fromHsl(h, s * 0.15, 0.42);
  const disabledBlock = (name: string) => [
    `.btn-${name}:disabled, .btn-${name}[aria-disabled="true"] { background: ${disabledBg}; color: ${disabledFg}; border-color: transparent; }`,
  ];

  const solidVariant = (name: string, base: string) => {
    const { bg, label } = solid(base);
    const hover = shifted(bg, label, 0.06);
    const active = shifted(bg, label, 0.12);
    css.push(
      "",
      `.btn-${name} { background: ${bg}; color: ${label}; border-color: ${bg}; }`,
      `.btn-${name}:hover { background: ${hover}; border-color: ${hover}; }`,
      `.btn-${name}:active { background: ${active}; border-color: ${active}; }`,
      ...disabledBlock(name)
    );
    check(`${name}: label on default`, label, bg);
    check(`${name}: label on hover`, label, hover);
    check(`${name}: label on active`, label, active);
  };

  const quietVariant = (name: string, bordered: boolean) => {
    const text = ratio(brand, "#ffffff") >= 4.5 ? brand : suggestFix(brand, "#ffffff", 4.5) ?? brand;
    const [th, ts] = hslOf(text);
    const tint = fromHsl(th, Math.min(ts, 0.9), 0.95);
    const tintActive = fromHsl(th, Math.min(ts, 0.9), 0.9);
    const hoverText = ratio(text, tintActive) >= 4.5 ? text : suggestFix(text, tintActive, 4.5) ?? text;
    css.push(
      "",
      `.btn-${name} { background: transparent; color: ${text}; border-color: ${bordered ? text : "transparent"}; }`,
      `.btn-${name}:hover { background: ${tint}; color: ${hoverText}; }`,
      `.btn-${name}:active { background: ${tintActive}; color: ${hoverText}; }`,
      `.btn-${name}:disabled, .btn-${name}[aria-disabled="true"] { background: transparent; color: ${disabledFg}; border-color: ${bordered ? disabledBg : "transparent"}; }`
    );
    check(`${name}: text on page`, text, "#ffffff");
    check(`${name}: text on hover`, hoverText, tint);
    check(`${name}: text on active`, hoverText, tintActive);
  };

  for (const v of variants) {
    if (v === "primary") solidVariant("primary", brand);
    else if (v === "danger") solidVariant("danger", "#dc2626");
    else if (v === "secondary") quietVariant("secondary", true);
    else quietVariant("ghost", false);
  }
  checks.push(`i Disabled buttons are exempt from WCAG contrast; shown at ${ratio(disabledFg, disabledBg).toFixed(1)}:1 for legibility.`);
  return { css: css.join("\n"), checks };
}
