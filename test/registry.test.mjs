import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALL_TOOLS, GROUPS, parseToolset, unknownEntries, wantsGateway } from "../dist/toolsets.js";
import { PLAYBOOKS } from "../dist/playbooks.js";
import { AGENTS, AGENT_TARGETS, AGENTS_MD_END, AGENTS_MD_START, renderAgent, renderAgentsMdBlock } from "../dist/agents.js";
import { describeParams, findToolsText, rankTools, runTool } from "../dist/gateway.js";

const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const registered = [...server.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]).filter((n) => !["find_tools", "run_tool"].includes(n));

test("ALL_TOOLS matches the tools the server registers", () => {
  assert.deepEqual([...registered].sort(), [...ALL_TOOLS].sort());
  assert.equal(new Set(ALL_TOOLS).size, ALL_TOOLS.length);
});

test("every tool is in a group and every group member exists", () => {
  const grouped = new Set(Object.values(GROUPS).flat());
  assert.deepEqual(ALL_TOOLS.filter((t) => !grouped.has(t)), []);
  assert.deepEqual([...grouped].filter((t) => !ALL_TOOLS.includes(t)), []);
});

test("RED_TOOLS parsing", () => {
  const count = (s) => ALL_TOOLS.filter(parseToolset(s)).length;
  assert.equal(count(undefined), ALL_TOOLS.length);
  assert.equal(count("all"), ALL_TOOLS.length);
  assert.equal(count("core"), GROUPS.core.length);
  assert.equal(count("all,-capture_url"), ALL_TOOLS.length - 1);
  assert.equal(count("auto"), 0);
  assert.equal(count("core,auto"), GROUPS.core.length);
  assert.equal(wantsGateway("core,auto"), true);
  assert.equal(wantsGateway("core"), false);
  assert.deepEqual(unknownEntries("core,typo,auto,-nothing"), ["typo", "nothing"]);
});

const refs = (t) => [...t.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
const KNOWN = [...ALL_TOOLS, "find_tools", "run_tool"];

test("playbooks only reference real tools", () => {
  for (const p of PLAYBOOKS) {
    for (const args of [{ source: "https://x.com", url: "https://x.com", current: "https://x.com", target: "https://x.com", brand: "#e11d48" }, { source: "./a.png", url: "https://x.com", current: "./a.png", target: "./a.css", brand: "#e11d48" }]) {
      assert.deepEqual(refs(p.build(args)).filter((t) => !ALL_TOOLS.includes(t)), [], p.name);
    }
  }
});

test("agents: roster is consistent and only references real tools", () => {
  assert.equal(new Set(AGENTS.map((a) => a.name)).size, AGENTS.length);
  assert.equal(AGENTS.filter((a) => a.role === "router").length, 1);
  assert.ok(AGENTS.length >= 13);
  const lead = AGENTS.find((a) => a.role === "router");
  for (const a of AGENTS) {
    assert.match(a.name, /^[a-z][a-z0-9_-]*$/, a.name);
    assert.match(a.description, /Use /, `${a.name} description should say when to use it`);
    assert.ok(!/: |\s#/.test(a.description), `${a.name} description must be YAML-safe`);
    assert.ok(a.description.length < 260, `${a.name} description too long`);
    assert.deepEqual(a.tools.filter((t) => !KNOWN.includes(t)), [], `${a.name} tools`);
    assert.deepEqual(refs(a.body.join("\n")).filter((t) => !KNOWN.includes(t)), [], `${a.name} body`);
    if (a.role === "specialist") assert.ok(lead.body.join("\n").includes(a.name), `router must route to ${a.name}`);
  }
});

test("agents render correctly for every tool format", () => {
  for (const a of AGENTS) {
    for (const target of ["claude", "cursor", "gemini", "copilot"]) {
      const { file, content } = renderAgent(a, target);
      assert.ok(file === `${a.name}.${target === "copilot" ? "agent.md" : "md"}`, file);
      const lines = content.split("\n");
      assert.equal(lines[0], "---");
      const end = lines.indexOf("---", 1);
      assert.ok(end > 2, `${a.name} ${target} frontmatter closes`);
      const fm = lines.slice(1, end).join("\n");
      assert.match(fm, new RegExp(`^name: ${a.name}$`, "m"));
      assert.match(fm, /^description: .+$/m);
      assert.ok(!/^tools: [A-Z]/m.test(fm), "must not restrict tools to Claude-only names");
      if (target === "cursor") assert.match(fm, new RegExp(`^readonly: ${a.readonly}$`, "m"));
      if (target === "gemini") assert.match(fm, /tools:\n  - "\*"/);
    }
    const { file, content } = renderAgent(a, "codex");
    assert.equal(file, `${a.name}.toml`);
    const body = content.split('developer_instructions = """\n')[1];
    assert.ok(body && body.endsWith('\n"""\n'), `${a.name} toml instructions block`);
    const inner = body.slice(0, -'\n"""\n'.length);
    assert.ok(!inner.includes('"""') && !inner.includes("\\"), `${a.name} toml body must be TOML-safe`);
    assert.equal(JSON.parse(content.match(/^name = (.+)$/m)[1]), a.name);
    assert.equal(JSON.parse(content.match(/^description = (.+)$/m)[1]), a.description);
    assert.equal(content.includes('sandbox_mode = "read-only"'), a.readonly);
  }
  assert.ok(AGENT_TARGETS.includes("agents-md"));
});

test("AGENTS.md block lists every specialist and is delimited", () => {
  const block = renderAgentsMdBlock();
  assert.ok(block.startsWith(AGENTS_MD_START) && block.endsWith(AGENTS_MD_END));
  for (const a of AGENTS) assert.ok(block.includes(a.name), a.name);
});

const entries = [...server.matchAll(/registerTool\(\s*"([a-z_]+)",\s*\{\s*title:\s*"((?:[^"\\]|\\.)*)",\s*description:\s*(?:\n\s*)?"((?:[^"\\]|\\.)*)"/g)]
  .filter((m) => ALL_TOOLS.includes(m[1]))
  .map((m) => ({ name: m[1], config: { title: m[2], description: m[3] }, handler: async (a) => ({ content: [{ type: "text", text: JSON.stringify(a) }] }) }));

test("gateway finds the right tool for common tasks", () => {
  assert.equal(entries.length, ALL_TOOLS.length);
  const top = (q) => rankTools(entries, q, 3).map((r) => r.entry.name);
  assert.ok(top("check my website's accessibility").includes("audit_site"));
  assert.equal(top("turn this screenshot into react code")[0], "recreate");
  assert.equal(top("pick fonts that feel luxurious")[0], "suggest_font_pairings");
  assert.equal(top("add dark mode to my theme")[0], "generate_dark_theme");
  assert.equal(top("create a favicon for my brand")[0], "generate_favicon");
  assert.match(findToolsText(entries, ""), /core:/);
});

test("gateway describes parameters from Zod-shaped schemas", () => {
  const s = (typeName, extra = {}) => ({ _def: { typeName, ...extra } });
  const lines = describeParams({
    url: { _def: { typeName: "ZodOptional", innerType: s("ZodString") }, description: "Page URL" },
    format: { _def: { typeName: "ZodDefault", defaultValue: () => "css", innerType: s("ZodEnum", { values: ["css", "json"] }) } },
  });
  assert.match(lines[0], /url \(string, optional\): Page URL/);
  assert.match(lines[1], /css \| json.*default "css"/);
});

test("run_tool validates, runs and suggests near matches", async () => {
  const ok = (shape, args) => ({ ok: true, data: args });
  const bad = () => ({ ok: false, error: "nope" });
  const ran = await runTool(entries, "check_contrast", { x: 1 }, ok);
  assert.match(ran.content[0].text, /"x":1/);
  assert.equal((await runTool(entries, "lint_cs", {}, ok)).isError, true);
  assert.match((await runTool(entries, "lint_cs", {}, ok)).content[0].text, /lint_css/);
  assert.equal((await runTool(entries, "lint_css", {}, bad)).isError, true);
});
