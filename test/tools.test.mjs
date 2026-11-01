import test from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, evaluatePairs } from "../dist/a11y.js";
import { generatePalette, simulate, deltaE } from "../dist/color.js";
import { typeScale, RATIOS } from "../dist/typography.js";
import { generateDesignSystem } from "../dist/system.js";
import { extractCssTokens } from "../dist/cssparse.js";
import { lintCss } from "../dist/lint.js";
import { generateComponentStates } from "../dist/states.js";
import { generateFormStyles } from "../dist/ui.js";
import { generateGradient, toOklab, fromOklab } from "../dist/gradient.js";
import { generateChartPalette } from "../dist/dataviz.js";
import { originalityReport } from "../dist/originality.js";

test("contrast math matches WCAG and fixes pass", () => {
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 0.01);
  const [r] = evaluatePairs([{ element: "body", foreground: "#777777", background: "#ffffff" }]);
  assert.equal(r.passAA, false);
  assert.ok(contrastRatio(r.suggestion, "#ffffff") >= 4.5);
});

test("palette has 11 steps, keeps the base color and rejects bad input", () => {
  const p = generatePalette("#e11d48", "triadic");
  assert.equal(Object.keys(p.primary).length, 11);
  assert.ok(Object.values(p.primary).includes("#e11d48"));
  assert.equal(Object.keys(p.accents).length, 2);
  assert.throws(() => generatePalette("nope", "triadic"));
});

test("color blindness simulation keeps white white and distance is zero for equal colors", () => {
  assert.equal(simulate("#ffffff", "deuteranopia"), "#ffffff");
  assert.equal(deltaE("#336699", "#336699"), 0);
});

test("type scale follows the ratio and supports fluid clamp()", () => {
  const rows = typeScale({ base: 16, ratio: RATIOS["major-third"], stepsDown: 2, stepsUp: 4, fluid: false, minViewport: 360, maxViewport: 1280 });
  assert.equal(rows.find((r) => r.name === "base").px, 16);
  assert.equal(rows.find((r) => r.name === "lg").px, 20);
  const fluid = typeScale({ base: 16, ratio: 1.25, stepsDown: 0, stepsUp: 2, fluid: true, minViewport: 360, maxViewport: 1280 });
  assert.match(fluid[1].value, /^clamp\(/);
});

test("design system passes its own contrast checks for several brands", () => {
  for (const brand of ["#e11d48", "#2563eb", "#facc15", "#16a34a"]) {
    const ds = generateDesignSystem({ brand, mood: "modern", harmony: "analogous", baseFontSize: 16, typeRatio: 1.25, spacingBase: 4, shadowStyle: "soft", radius: "soft" });
    assert.deepEqual(ds.checks.filter((c) => c.startsWith("✗")), [], brand);
    assert.match(ds.css, /prefers-color-scheme: dark/);
    assert.equal((ds.css.match(/\{/g) || []).length, (ds.css.match(/\}/g) || []).length);
  }
});

test("button and form states pass contrast for several brands", () => {
  for (const brand of ["#e11d48", "#facc15", "#2563eb"]) {
    assert.deepEqual(generateComponentStates(brand, ["primary", "secondary", "ghost", "danger"]).checks.filter((c) => c.startsWith("✗")), [], brand);
    assert.deepEqual(generateFormStyles(brand).checks.filter((c) => c.startsWith("✗")), [], brand);
  }
});

const SAMPLE = `
:root { --primary:#e11d48; --bg:#ffffff; }
body { font-family: "Inter", sans-serif; color:#111827; background:#fff; font-size:16px }
.btn { background:#e11d48; color:#fff; border-radius:8px; padding:10px 18px; outline:none }
.card { background:#fafafa; color:#9ca3af; font-size: 11px }
`;

test("CSS token extraction and linting find real problems", () => {
  const { tokens } = extractCssTokens(SAMPLE);
  assert.equal(tokens.colors.primary, "#e11d48");
  assert.equal(tokens.fontFamilies.body, "Inter");
  const report = lintCss(SAMPLE);
  assert.match(report, /Low text contrast/);
  assert.match(report, /focus outline/);
  assert.match(report, /below 12px/);
  assert.match(lintCss("a{color:#111;background:#fff} a:focus-visible{outline:2px solid #00f}"), /100\/100/);
});

test("gradient interpolation round-trips and reports text contrast", () => {
  assert.equal(fromOklab(...toOklab("#e11d48")), "#e11d48");
  const g = generateGradient(["#e11d48", "#0ea5e9"], "linear", 135, 3);
  assert.match(g.css, /in oklab/);
  assert.equal(g.text.length, 2);
  assert.throws(() => generateGradient(["#e11d48", "zzz"], "linear", 90, 2));
});

test("chart palettes behave", () => {
  assert.equal(generateChartPalette("categorical", 6).colors.length, 6);
  assert.throws(() => generateChartPalette("categorical", 9));
  assert.throws(() => generateChartPalette("diverging", 6));
  const seq = generateChartPalette("sequential", 7, "#2563eb").colors.map((c) => toOklab(c)[0]);
  assert.ok(seq.every((l, i) => i === 0 || l < seq[i - 1]));
});

test("originality check scores identical designs high and different designs low", () => {
  const a = JSON.stringify({ colors: { primary: "#e11d48", bg: "#ffffff" }, fontFamilies: { body: "Inter" }, radii: { md: "8px" } });
  const b = JSON.stringify({ colors: { primary: "#0ea5e9", bg: "#0b1220" }, fontFamilies: { body: "Lora" }, radii: { md: "0px" } });
  assert.match(originalityReport(a, a), /100%/);
  assert.match(originalityReport(a, b), /Distinct/);
});
