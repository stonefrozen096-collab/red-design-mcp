import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { AGENTS, AGENT_TARGETS, AGENTS_MD_END, AGENTS_MD_START, renderAgent, renderAgentsMdBlock, type AgentTarget, type AgentTargetOrMd } from "./agents.js";
import { listModels, resolveProvider } from "./vision.js";
import { ALL_TOOLS, parseToolset, unknownEntries, wantsGateway } from "./toolsets.js";

const NAME = "red";
const PKG = "red-design-mcp";
const isWin = platform() === "win32";

const launcher = isWin
  ? { command: "cmd", args: ["/c", "npx", "-y", PKG] }
  : { command: "npx", args: ["-y", PKG] };

export type Client = "claude-code" | "codex" | "cursor" | "claude-desktop";
const ALL: Client[] = ["claude-code", "codex", "cursor", "claude-desktop"];

function claudeDesktopPath(): string {
  const h = homedir();
  if (platform() === "darwin") return join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (isWin) return join(process.env.APPDATA ?? join(h, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(h, ".config", "Claude", "claude_desktop_config.json");
}

function paths() {
  const h = homedir();
  return {
    cursor: join(h, ".cursor", "mcp.json"),
    codex: join(h, ".codex", "config.toml"),
    "claude-desktop": claudeDesktopPath(),
  };
}

function hasBinary(bin: string): boolean {
  return spawnSync(isWin ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
}

export function detect(): Client[] {
  const p = paths();
  const found: Client[] = [];
  if (hasBinary("claude")) found.push("claude-code");
  if (hasBinary("codex") || existsSync(dirname(p.codex))) found.push("codex");
  if (existsSync(dirname(p.cursor))) found.push("cursor");
  if (existsSync(dirname(p["claude-desktop"]))) found.push("claude-desktop");
  return found;
}

function backup(file: string): void {
  if (existsSync(file)) copyFileSync(file, file + ".bak");
}

function installJson(file: string): string {
  let cfg: any = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw) {
      try {
        cfg = JSON.parse(raw);
      } catch {
        throw new Error(`${file} is not valid JSON. Fix it or add the server manually (run with --print).`);
      }
    }
  }
  cfg.mcpServers ??= {};
  if (cfg.mcpServers[NAME]) return "already installed";
  backup(file);
  mkdirSync(dirname(file), { recursive: true });
  cfg.mcpServers[NAME] = launcher;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return `added to ${file}`;
}

function installCodex(file: string): string {
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.includes(`[mcp_servers.${NAME}]`)) return "already installed";
  backup(file);
  mkdirSync(dirname(file), { recursive: true });
  const block = `\n[mcp_servers.${NAME}]\ncommand = "${launcher.command}"\nargs = [${launcher.args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
  writeFileSync(file, current + block);
  return `added to ${file}`;
}

function installClaudeCode(): string {
  const r = spawnSync("claude", ["mcp", "add", "--scope", "user", NAME, "--", launcher.command, ...launcher.args], {
    encoding: "utf8",
    shell: isWin,
  });
  const out = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
  if (r.status === 0) return "added with `claude mcp add` (user scope)";
  if (/already exists/i.test(out)) return "already installed";
  throw new Error(out || "`claude mcp add` failed");
}

export function installClient(client: Client): string {
  const p = paths();
  switch (client) {
    case "claude-code": return installClaudeCode();
    case "codex": return installCodex(p.codex);
    case "cursor": return installJson(p.cursor);
    case "claude-desktop": return installJson(p["claude-desktop"]);
  }
}

export const AGENT_LABELS: Record<AgentTargetOrMd, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  "agents-md": "AGENTS.md (Windsurf, Zed, OpenCode and others)",
};

export function agentsDirFor(target: AgentTarget, project: boolean): string {
  const base = project ? process.cwd() : homedir();
  switch (target) {
    case "claude": return join(base, ".claude", "agents");
    case "cursor": return join(base, ".cursor", "agents");
    case "codex": return join(base, ".codex", "agents");
    case "gemini": return join(base, ".gemini", "agents");
    case "copilot": return project ? join(base, ".github", "agents") : join(base, ".copilot", "agents");
  }
}

/** Tools that look installed on this machine (user level). */
export function detectAgentTargets(): AgentTarget[] {
  const h = homedir();
  const found: AgentTarget[] = [];
  if (hasBinary("claude") || existsSync(join(h, ".claude"))) found.push("claude");
  if (existsSync(join(h, ".cursor"))) found.push("cursor");
  if (hasBinary("codex") || existsSync(join(h, ".codex"))) found.push("codex");
  if (hasBinary("gemini") || existsSync(join(h, ".gemini"))) found.push("gemini");
  if (existsSync(join(h, ".copilot"))) found.push("copilot");
  return found;
}

export function installAgents(target: AgentTarget, dir: string, force: boolean, only?: string[]): string[] {
  mkdirSync(dir, { recursive: true });
  const list = only?.length ? AGENTS.filter((a) => only.includes(a.name)) : AGENTS;
  return list.map((a) => {
    const { file, content } = renderAgent(a, target);
    const path = join(dir, file);
    if (existsSync(path) && !force) return `skip ${a.name}: already exists (use --force to overwrite)`;
    backup(path);
    writeFileSync(path, content);
    return `ok   ${a.name}`;
  });
}

/** Add or refresh the managed red-design-mcp block in AGENTS.md without touching anything else. */
export function installAgentsMd(file: string): string {
  const block = renderAgentsMdBlock();
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const start = current.indexOf(AGENTS_MD_START);
  const end = current.indexOf(AGENTS_MD_END);
  let next: string;
  if (start !== -1 && end > start) next = current.slice(0, start) + block + current.slice(end + AGENTS_MD_END.length);
  else next = current ? `${current.replace(/\s+$/, "")}\n\n${block}\n` : `${block}\n`;
  if (next === current) return "already up to date";
  backup(file);
  writeFileSync(file, next);
  return start !== -1 ? `updated ${file}` : `added to ${file}`;
}

const SNIPPET = JSON.stringify({ mcpServers: { [NAME]: launcher } }, null, 2);

const HELP = `red-design-mcp: recreate and reimagine any design (MCP server)

Usage:
  npx red-design-mcp install            Auto-detect and install into your AI tools
  npx red-design-mcp install --client codex,cursor
  npx red-design-mcp install --all      Install into every supported client
  npx red-design-mcp install --print    Only print the config snippets
  npx red-design-mcp doctor             Check setup and mode (add --check to confirm your model exists)
  npx red-design-mcp agents             Install 13 design agents into the AI tools it detects
  npx red-design-mcp agents --target claude,cursor,codex,gemini,copilot,agents-md
  npx red-design-mcp agents --all       Every supported tool (AGENTS.md goes in the current folder)
  npx red-design-mcp agents --project   Install into this project instead of your home folder
  npx red-design-mcp agents --only red-design-lead,red-css-polisher    Install only some agents
  npx red-design-mcp agents --list      List the agents; add --force to overwrite existing files
  npx red-design-mcp                    Start the MCP server (used by clients)

Clients: ${ALL.join(", ")}

Tool profiles (set RED_TOOLS in your client's env to load fewer tools):
  all (default) | core | vision | web | color | system | components | quality
  Combine with commas, exclude with a dash: RED_TOOLS=core,web   RED_TOOLS=all,-capture_url
  auto = let your AI discover tools itself (find_tools + run_tool): RED_TOOLS=auto   RED_TOOLS=core,auto

Modes:
  Host mode (default): no API key, your AI tool does the visual analysis.
  API mode: set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY,
            or RED_BASE_URL (+ RED_MODEL) for any OpenAI-compatible endpoint. RED_PROVIDER picks one if several are set.
`;

function parseClients(args: string[]): Client[] | null {
  const i = args.indexOf("--client");
  if (i === -1 || !args[i + 1]) return null;
  const wanted = args[i + 1].split(",").map((s) => s.trim());
  const bad = wanted.filter((w) => !ALL.includes(w as Client));
  if (bad.length) throw new Error(`Unknown client: ${bad.join(", ")}. Choose from ${ALL.join(", ")}.`);
  return wanted as Client[];
}

export async function runCli(args: string[]): Promise<void> {
  const cmd = args[0];

  if (cmd === "doctor") {
    const prov = resolveProvider();
    const mode = prov
      ? `API mode (${prov.label}, model ${prov.model || "NOT SET: set RED_MODEL"})`
      : "Host mode (no key needed)";
    console.log(`Node: ${process.version}`);
    console.log(`Mode: ${mode}`);
    if (process.env.RED_PROVIDER && !prov) console.log(`Warning: RED_PROVIDER=${process.env.RED_PROVIDER} has no matching key or is not a known provider (anthropic, openai, google, groq, openrouter, custom).`);
    const enabled = ALL_TOOLS.filter(parseToolset(process.env.RED_TOOLS));
    console.log(`Tools: ${enabled.length} of ${ALL_TOOLS.length} loaded directly (RED_TOOLS=${process.env.RED_TOOLS || "all"})`);
    if (wantsGateway(process.env.RED_TOOLS)) {
      const rest = ALL_TOOLS.length - enabled.length;
      if (rest > 0) console.log(`Host-selected: ${rest} more tools reachable through find_tools and run_tool`);
    }
    const bad = unknownEntries(process.env.RED_TOOLS);
    if (bad.length) console.log(`Warning: unknown RED_TOOLS entries: ${bad.join(", ")}`);
    const found = detect();
    console.log(`Detected clients: ${found.length ? found.join(", ") : "none"}`);
    if (args.includes("--check")) {
      if (!prov) console.log("Model check: skipped (host mode, no provider configured)");
      else if (!prov.model) console.log("Model check: set RED_MODEL first");
      else {
        try {
          const ids = await listModels(prov);
          if (ids.includes(prov.model)) console.log(`Model check: "${prov.model}" is available`);
          else {
            const family = prov.model.split(/[-/.]/).filter((t) => t.length > 2)[0] ?? "";
            const near = ids.filter((i) => i.toLowerCase().includes(family.toLowerCase())).sort().reverse().slice(0, 8);
            console.log(`Model check: "${prov.model}" was not found. Set RED_MODEL to one of: ${(near.length ? near : ids.slice(0, 8)).join(", ")}`);
          }
        } catch (err) {
          console.log(`Model check failed: ${(err as Error).message}`);
        }
      }
    }
    return;
  }

  if (cmd === "agents") {
    if (args.includes("--list") || args.includes("--print")) {
      for (const a of AGENTS) console.log(`${a.name} (${a.role})\n  ${a.description}\n`);
      return;
    }
    const flag = (name: string) => {
      const i = args.indexOf(name);
      return i !== -1 && args[i + 1] ? args[i + 1].split(",").map((x) => x.trim()).filter(Boolean) : null;
    };
    const wanted = flag("--target");
    const bad = (wanted ?? []).filter((t) => !(AGENT_TARGETS as readonly string[]).includes(t));
    if (bad.length) {
      console.error(`Unknown target: ${bad.join(", ")}. Choose from ${AGENT_TARGETS.join(", ")}.`);
      process.exitCode = 1;
      return;
    }
    const only = flag("--only");
    const unknownOnly = (only ?? []).filter((n) => !AGENTS.some((a) => a.name === n));
    if (unknownOnly.length) {
      console.error(`Unknown agent: ${unknownOnly.join(", ")}. Run with --list to see names.`);
      process.exitCode = 1;
      return;
    }
    const targets: AgentTargetOrMd[] = args.includes("--all") ? [...AGENT_TARGETS] : ((wanted as AgentTargetOrMd[] | null) ?? detectAgentTargets());
    if (!targets.length) {
      console.log("No supported AI tools detected. Use --target (claude, cursor, codex, gemini, copilot, agents-md) or --all.");
      return;
    }
    const project = args.includes("--project");
    const force = args.includes("--force");
    for (const t of targets) {
      if (t === "agents-md") {
        const file = join(process.cwd(), "AGENTS.md");
        console.log(`${AGENT_LABELS[t]}:\n  ${installAgentsMd(file)}`);
      } else {
        const dir = agentsDirFor(t, project);
        console.log(`${AGENT_LABELS[t]} (${dir}):`);
        for (const line of installAgents(t, dir, force, only ?? undefined)) console.log(`  ${line}`);
      }
    }
    console.log("\nDone. Claude Code, Gemini CLI and Copilot list them in their agent pickers (for example /agents). Cursor offers them as /name. In Codex, ask for an agent by name, for example: use red-design-reviewer.");
    return;
  }

  if (cmd !== "install") {
    console.log(HELP);
    return;
  }

  if (args.includes("--print")) {
    console.log(`Claude Code:\n  claude mcp add --scope user ${NAME} -- ${[launcher.command, ...launcher.args].join(" ")}\n`);
    console.log(`Codex (~/.codex/config.toml):\n  [mcp_servers.${NAME}]\n  command = "${launcher.command}"\n  args = [${launcher.args.map((a) => JSON.stringify(a)).join(", ")}]\n`);
    console.log(`Cursor / Claude Desktop / others (JSON):\n${SNIPPET}`);
    return;
  }

  let targets: Client[];
  try {
    targets = args.includes("--all") ? ALL : (parseClients(args) ?? detect());
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  if (!targets.length) {
    console.log("No supported AI tools detected. Run with --all or --client <name>, or use --print for manual snippets.");
    return;
  }

  let failed = false;
  for (const c of targets) {
    try {
      console.log(`  ok   ${c}: ${installClient(c)}`);
    } catch (err) {
      failed = true;
      console.log(`  fail ${c}: ${(err as Error).message}`);
    }
  }
  console.log("\nDone. Restart your AI tool, then ask it to analyze or recreate a design image.");
  console.log("Tip: run `npx red-design-mcp agents` to add 13 design agents for Claude Code, Cursor, Codex, Gemini CLI and Copilot.");
  if (failed) process.exitCode = 1;
}
