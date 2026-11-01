import { GROUPS } from "./toolsets.js";

export interface ToolEntry {
  name: string;
  config: any;
  handler: (args: any, extra: any) => any;
}

/* ------------------------------ Parameter descriptions ------------------------------ */

function unwrap(schema: any): { inner: any; required: boolean; def?: unknown; description?: string } {
  let cur = schema;
  let required = true;
  let def: unknown;
  let description: string | undefined = schema?.description;
  for (let i = 0; i < 5 && cur?._def; i++) {
    const t = cur._def.typeName;
    if (t === "ZodOptional") {
      required = false;
      cur = cur._def.innerType;
    } else if (t === "ZodDefault") {
      required = false;
      try {
        def = cur._def.defaultValue();
      } catch {
        /* no default */
      }
      cur = cur._def.innerType;
    } else break;
    description ??= cur?.description;
  }
  return { inner: cur, required, def, description };
}

function typeOf(s: any): { type: string; options?: string[] } {
  try {
    switch (s?._def?.typeName) {
      case "ZodString": return { type: "string" };
      case "ZodNumber": return { type: "number" };
      case "ZodBoolean": return { type: "boolean" };
      case "ZodEnum": return { type: "one of", options: [...(s._def.values as string[])] };
      case "ZodArray": return { type: `array of ${typeOf(s._def.type).type}` };
      case "ZodRecord": return { type: "object" };
      case "ZodUnion": {
        const opts = (s._def.options as any[]).map(typeOf);
        const enums = opts.flatMap((o) => o.options ?? []);
        return enums.length ? { type: "one of (or a number)", options: enums } : { type: opts.map((o) => o.type).join(" | ") };
      }
      case "ZodObject": {
        const fields = Object.entries(s._def.shape() as Record<string, any>).map(([k, v]) => {
          const u = unwrap(v);
          return `${k}${u.required ? "" : "?"}: ${typeOf(u.inner).type}`;
        });
        return { type: `{ ${fields.join(", ")} }` };
      }
      default: return { type: "any" };
    }
  } catch {
    return { type: "any" };
  }
}

export function describeParams(shape: Record<string, any> | undefined): string[] {
  const lines: string[] = [];
  for (const [name, field] of Object.entries(shape ?? {})) {
    const u = unwrap(field);
    const t = typeOf(u.inner);
    const bits = [t.type + (t.options ? `: ${t.options.join(" | ")}` : ""), u.required ? "required" : "optional"];
    if (u.def !== undefined) bits.push(`default ${JSON.stringify(u.def)}`);
    lines.push(`  - ${name} (${bits.join(", ")})${u.description ? `: ${u.description}` : ""}`);
  }
  return lines.length ? lines : ["  (no parameters)"];
}

export const formatParams = (e: ToolEntry) => describeParams(e.config?.inputSchema).join("\n");

/* ---------------------------------- Ranking ---------------------------------- */

const STOP = new Set("the an and or to for of my me i it in on with from this that is are be can you how what do does get give want need please just some all any so then also".split(" "));

const stem = (w: string) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

const SYNONYMS: Record<string, string[]> = {
  accessible: ["accessibility", "contrast", "wcag"], accessibility: ["contrast", "wcag", "audit"], a11y: ["accessibility", "contrast"], wcag: ["accessibility", "contrast"],
  website: ["url", "site", "css"], webpage: ["url", "site"], page: ["url", "site"], site: ["url", "website"], url: ["website", "site"], web: ["url", "site"],
  screenshot: ["image"], mockup: ["image", "design"], picture: ["image"], photo: ["image"], image: ["design"],
  colour: ["color"], swatch: ["palette", "color"],
  font: ["typography", "pairing"], typeface: ["typography", "font"], typography: ["font", "type"], text: ["type", "font"],
  code: ["recreate", "html", "react"], implement: ["recreate"], clone: ["recreate", "site"], rebuild: ["recreate"], convert: ["recreate", "tokens"], html: ["recreate"], react: ["recreate"], tailwind: ["recreate", "tokens"],
  compare: ["compare", "difference"], diff: ["compare"], difference: ["compare"],
  chart: ["chart", "palette", "dataviz"], graph: ["chart"], plot: ["chart"], dataviz: ["chart"], visualization: ["chart"],
  button: ["component", "state"], form: ["form", "input"], input: ["form"],
  shadow: ["shadow", "elevation"], elevation: ["shadow"], depth: ["shadow"],
  spacing: ["spacing", "space"], margin: ["spacing"], padding: ["spacing"],
  animation: ["motion"], transition: ["motion"], motion: ["animation", "duration"], easing: ["motion"],
  layout: ["layout", "grid", "column"], grid: ["layout"], responsive: ["layout", "breakpoint"], breakpoint: ["layout"],
  icon: ["favicon"], logo: ["favicon"], favicon: ["icon"],
  gradient: ["gradient"], dark: ["dark", "theme"], night: ["dark", "theme"], theme: ["dark", "theme"],
  lint: ["lint", "css", "quality"], stylesheet: ["css", "lint"], css: ["lint", "tokens"],
  token: ["tokens", "extract"], variable: ["tokens"],
  review: ["critique"], critique: ["review", "score"], feedback: ["critique"], score: ["audit"],
  prompt: ["prompt", "v0"], v0: ["prompt"], lovable: ["prompt"],
  original: ["originality"], copy: ["originality"], similar: ["originality", "compare"], plagiarism: ["originality"],
  colorblind: ["colorblind", "simulate"], blindness: ["colorblind"], deuteranopia: ["colorblind"], protanopia: ["colorblind"],
  redesign: ["reimagine"], restyle: ["reimagine"], reimagine: ["reimagine", "style"], style: ["reimagine"], remix: ["reimagine"], variation: ["reimagine"],
  analyze: ["analyze", "spec"], inspect: ["analyze"], describe: ["analyze"],
  system: ["design", "system"], starter: ["system"], scale: ["scale"], ratio: ["type", "scale"],
};

function expand(tokens: string[]): string[] {
  const out = new Set(tokens);
  for (const t of tokens) for (const s of SYNONYMS[t] ?? []) out.add(stem(s));
  return [...out];
}

function groupsOf(name: string): string[] {
  return Object.entries(GROUPS).filter(([, tools]) => tools.includes(name)).map(([g]) => g);
}

export function rankTools(entries: ToolEntry[], task: string, limit = 5): { entry: ToolEntry; score: number }[] {
  const q = expand(words(task));
  if (!q.length) return [];
  const scored = entries.map((entry) => {
    const nameW = new Set(words(entry.name.replace(/_/g, " ")));
    const titleW = new Set(words(entry.config?.title ?? ""));
    const descW = new Set(words(entry.config?.description ?? ""));
    const groupW = new Set(groupsOf(entry.name).flatMap((g) => words(g)));
    let score = 0;
    for (const t of q) {
      if (nameW.has(t)) score += 4;
      if (titleW.has(t)) score += 3;
      if (groupW.has(t)) score += 2;
      if (descW.has(t)) score += 1;
    }
    return { entry, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ---------------------------------- Output ---------------------------------- */

const firstSentence = (d = "") => (d.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? d).trim();

export function overview(entries: ToolEntry[]): string {
  const names = new Set(entries.map((e) => e.name));
  const lines = ["Available red design tools by area:"];
  for (const [group, tools] of Object.entries(GROUPS)) {
    const here = tools.filter((t) => names.has(t));
    if (here.length) lines.push(`- ${group}: ${here.join(", ")}`);
  }
  const grouped = new Set(Object.values(GROUPS).flat());
  const rest = [...names].filter((n) => !grouped.has(n));
  if (rest.length) lines.push(`- other: ${rest.join(", ")}`);
  lines.push("", "Call find_tools again with a short description of your task to see exact parameters, then run_tool.");
  return lines.join("\n");
}

export function findToolsText(entries: ToolEntry[], task: string, limit = 5): string {
  if (!task.trim()) return overview(entries);
  const ranked = rankTools(entries, task, limit);
  if (!ranked.length) return `No close match for "${task}".\n\n${overview(entries)}`;
  const out = [`Best matches for "${task}":`, ""];
  ranked.forEach((r, i) => {
    out.push(`${i + 1}. ${r.entry.name}: ${firstSentence(r.entry.config?.description)}`, "   Parameters:", formatParams(r.entry).replace(/^/gm, "   ").replace(/^ {3}  /gm, "     "), "");
  });
  out.push('To use one, call run_tool with {"name": "<tool>", "args": { ... }}.');
  return out.join("\n");
}

/* ---------------------------------- Running ---------------------------------- */

export type Validate = (shape: any, args: unknown) => { ok: true; data: any } | { ok: false; error: string };

const errorResult = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

export async function runTool(entries: ToolEntry[], name: string, args: unknown, validate: Validate) {
  const entry = entries.find((e) => e.name === name);
  if (!entry) {
    const near = rankTools(entries, name.replace(/_/g, " "), 3).map((r) => r.entry.name);
    return errorResult(`Unknown tool "${name}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Use find_tools to search.`);
  }
  const v = validate(entry.config?.inputSchema ?? {}, args ?? {});
  if (!v.ok) return errorResult(`Invalid args for ${name}: ${v.error}\n\nParameters:\n${formatParams(entry)}`);
  return entry.handler(v.data, {});
}
