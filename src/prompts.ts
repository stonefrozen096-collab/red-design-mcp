import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PLAYBOOKS } from "./playbooks.js";

/** Expose the agent playbooks as MCP prompts (slash commands in clients that support them). */
export function registerPrompts(server: McpServer): void {
  for (const p of PLAYBOOKS) {
    const argsSchema: Record<string, z.ZodTypeAny> = {};
    for (const a of p.args) {
      const base = z.string().describe(a.description);
      argsSchema[a.name] = a.required ? base : base.optional();
    }
    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema },
      (args: any) => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: p.build(args as Record<string, string | undefined>) } }],
      })
    );
  }
}
