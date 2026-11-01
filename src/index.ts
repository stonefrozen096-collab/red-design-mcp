#!/usr/bin/env node
const args = process.argv.slice(2);
const CLI_COMMANDS = ["install", "doctor", "agents", "help", "--help", "-h"];

if (args[0] && CLI_COMMANDS.includes(args[0])) {
  const { runCli } = await import("./cli.js");
  await runCli(args);
} else {
  const { startServer } = await import("./server.js");
  await startServer();
}
