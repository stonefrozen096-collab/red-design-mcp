import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "red-test-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { installClient, installAgents, installAgentsMd, agentsDirFor, detectAgentTargets } = await import("../dist/cli.js");
const { AGENTS } = await import("../dist/agents.js");

test("installer merges into existing JSON config without touching other servers, and is idempotent", () => {
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const file = join(home, ".cursor", "mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  assert.match(installClient("cursor"), /added/);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(cfg.mcpServers.other && cfg.mcpServers.red);
  assert.ok(existsSync(file + ".bak"));
  assert.equal(installClient("cursor"), "already installed");
});

test("installer appends a Codex TOML block once", () => {
  assert.match(installClient("codex"), /added/);
  assert.equal(installClient("codex"), "already installed");
  assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.red\]/);
});

const FORMATS = { claude: ".md", cursor: ".md", gemini: ".md", copilot: ".agent.md", codex: ".toml" };

for (const [target, ext] of Object.entries(FORMATS)) {
  test(`${target} agents install in the right place and format, skip existing files and overwrite with force`, () => {
    const dir = agentsDirFor(target, false);
    assert.ok(dir.startsWith(home), dir);
    assert.ok(installAgents(target, dir, false).every((l) => l.startsWith("ok")));
    const files = readdirSync(dir).filter((f) => !f.endsWith(".bak"));
    assert.equal(files.length, AGENTS.length);
    assert.ok(files.every((f) => f.endsWith(ext)), files.join(","));
    assert.ok(installAgents(target, dir, false).every((l) => l.startsWith("skip")));
    assert.ok(installAgents(target, dir, true).every((l) => l.startsWith("ok")));
  });
}

test("agent locations match each tool's documented folders", () => {
  assert.equal(agentsDirFor("claude", false), join(home, ".claude", "agents"));
  assert.equal(agentsDirFor("cursor", false), join(home, ".cursor", "agents"));
  assert.equal(agentsDirFor("codex", false), join(home, ".codex", "agents"));
  assert.equal(agentsDirFor("gemini", false), join(home, ".gemini", "agents"));
  assert.equal(agentsDirFor("copilot", false), join(home, ".copilot", "agents"));
  assert.equal(agentsDirFor("copilot", true), join(process.cwd(), ".github", "agents"));
  assert.equal(agentsDirFor("claude", true), join(process.cwd(), ".claude", "agents"));
});

test("--only installs just the named agents", () => {
  const dir = join(home, "only-test");
  const out = installAgents("claude", dir, false, ["red-design-lead", "red-css-polisher"]);
  assert.equal(out.length, 2);
  assert.deepEqual(readdirSync(dir).sort(), ["red-css-polisher.md", "red-design-lead.md"]);
});

test("detection finds tools by their folders", () => {
  for (const d of [".claude", ".cursor", ".codex", ".gemini"]) mkdirSync(join(home, d), { recursive: true });
  const found = detectAgentTargets();
  for (const t of ["claude", "cursor", "codex", "gemini"]) assert.ok(found.includes(t), t);
});

test("AGENTS.md block is added once, refreshed in place, and never touches other content", () => {
  const file = join(home, "AGENTS.md");
  writeFileSync(file, "# My project\n\nKeep me.\n");
  assert.match(installAgentsMd(file), /added/);
  assert.equal(installAgentsMd(file), "already up to date");
  let text = readFileSync(file, "utf8");
  assert.equal((text.match(/red-design-mcp:start/g) || []).length, 1);
  assert.ok(text.startsWith("# My project\n\nKeep me."));
  writeFileSync(file, text.replace("## Design work with red-design-mcp", "## OLD TITLE") + "\n## After block\n");
  assert.match(installAgentsMd(file), /updated/);
  text = readFileSync(file, "utf8");
  assert.ok(text.includes("## Design work with red-design-mcp") && !text.includes("OLD TITLE"));
  assert.ok(text.includes("## After block") && text.includes("Keep me."));
  const fresh = join(home, "nested-AGENTS.md");
  assert.match(installAgentsMd(fresh), /added/);
});
