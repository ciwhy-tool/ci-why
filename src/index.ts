#!/usr/bin/env node

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import Anthropic from "@anthropic-ai/sdk";
import { version } from "../package.json";

// Load ~/.config/ci-why/.env first, then local .env (local takes precedence).
// Neither overrides a key already set in the shell environment.
const userEnvPath = path.join(os.homedir(), ".config", "ci-why", ".env");
dotenv.config({ path: userEnvPath });
dotenv.config();

const c = {
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function chunkLog(text: string): string {
  const lines = text.split("\n");

  const errorPattern = /error|failed|exception|fatal|panic|traceback/i;
  const errorLines: string[] = [];
  for (const line of lines) {
    if (errorPattern.test(line)) errorLines.push(line);
  }

  const tail = lines.slice(-200);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of [...errorLines, ...tail]) {
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }

  return result.join("\n");
}

async function readInput(): Promise<string> {
  const args = process.argv.slice(2);

  if (args.length > 0 && !args[0].startsWith("-")) {
    const filePath = path.resolve(args[0]);
    if (!fs.existsSync(filePath)) {
      console.error(c.red(`Error: file not found: ${filePath}`));
      process.exit(1);
    }
    return fs.readFileSync(filePath, "utf8");
  }

  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function analyzeLog(log: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(c.red("Error: ANTHROPIC_API_KEY is not set."));
    console.error("Get your free key at console.anthropic.com then run:");
    console.error("  export ANTHROPIC_API_KEY=your-key-here");
    console.error("Or run: ci-why setup");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are a CI/CD build failure analyst. Given a build log, respond ONLY in this exact format — no extra commentary:

WHY: <one clear sentence explaining the root cause of the failure>
FAILING LINE: <the exact line, command, or file reference that caused it>
SUGGESTED FIX: <one actionable step the developer can take to fix it>`;

  process.stderr.write(c.dim("Analyzing build log…\n\n"));

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Here is the CI build log to analyze:\n\n${log}`,
      },
    ],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  displayResult(text);
}

function displayResult(text: string): void {
  const whyMatch     = text.match(/WHY:\s*(.+?)(?=\nFAILING LINE:|$)/s);
  const failingMatch = text.match(/FAILING LINE:\s*(.+?)(?=\nSUGGESTED FIX:|$)/s);
  const fixMatch     = text.match(/SUGGESTED FIX:\s*(.+?)$/s);

  const divider = c.dim("─".repeat(50));

  console.log(divider);

  if (whyMatch) {
    console.log(c.bold(c.red("  WHY")));
    console.log(`  ${whyMatch[1].trim()}\n`);
  }

  if (failingMatch) {
    console.log(c.bold(c.yellow("  FAILING LINE")));
    console.log(`  ${failingMatch[1].trim()}\n`);
  }

  if (fixMatch) {
    console.log(c.bold(c.green("  SUGGESTED FIX")));
    console.log(`  ${fixMatch[1].trim()}\n`);
  }

  console.log(divider);

  if (!whyMatch && !failingMatch && !fixMatch) {
    console.log(text);
  }
}

// ─── Setup wizard ─────────────────────────────────────────────────────────────

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptForKey(): Promise<string> {
  while (true) {
    const key = await promptLine("Paste your API key here: ");
    if (key.startsWith("sk-ant-")) return key;
    console.error(c.red("Invalid key — Anthropic keys start with sk-ant-. Try again.\n"));
  }
}

function saveKey(apiKey: string): void {
  const configDir = path.join(os.homedir(), ".config", "ci-why");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, ".env");
  fs.writeFileSync(configPath, `ANTHROPIC_API_KEY=${apiKey}\n`, "utf8");
  console.log(c.green(`\nKey saved to ${configPath}`));
}

function printShellInstructions(apiKey: string): void {
  console.log("\nTo make this permanent in your shell:\n");
  if (process.platform === "win32") {
    console.log("  Windows — set it in System Environment Variables:");
    console.log("  1. Open the Start menu and search for 'Environment Variables'");
    console.log("  2. Click 'Edit the system environment variables'");
    console.log("  3. Click 'Environment Variables…' then 'New' under User variables");
    console.log(`  4. Name: ANTHROPIC_API_KEY   Value: ${apiKey}`);
    console.log("  5. Click OK and restart your terminal");
  } else {
    console.log("  macOS / Linux — add this line to ~/.bashrc or ~/.zshrc:");
    console.log(`\n    export ANTHROPIC_API_KEY=${apiKey}\n`);
    console.log("  Then reload your shell:");
    console.log("    source ~/.bashrc   # or source ~/.zshrc");
  }
}

async function testKey(apiKey: string): Promise<void> {
  process.stdout.write(c.dim("\nTesting your API key… "));
  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    console.log(c.green("OK"));
    console.log(c.bold("\nSetup complete! Try: cat build.log | ci-why"));
  } catch {
    console.log(c.red("FAILED"));
    console.error(c.red("\nThat key didn't work — double check it at console.anthropic.com"));
    process.exit(1);
  }
}

async function setup(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(c.green("API key already configured. You're good to go!"));
    process.exit(0);
  }

  console.log(c.bold("Welcome to ci-why setup!"));
  console.log("You need a free Anthropic API key to use ci-why.");
  console.log("Get yours at: console.anthropic.com\n");

  const apiKey = await promptForKey();
  saveKey(apiKey);
  printShellInstructions(apiKey);
  await testKey(apiKey);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "setup") {
    await setup();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(version);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`ci-why v${version} — explain CI build failures in plain English`);
    console.log("");
    console.log("First time? Run: ci-why setup");
    console.log("");
    console.log("Usage:");
    console.log("  cat build.log | ci-why       # pipe a log through stdin");
    console.log("  ci-why ./build.log           # analyze a log file");
    console.log("");
    console.log("Commands:");
    console.log("  ci-why setup        Configure your Anthropic API key");
    console.log("");
    console.log("Options:");
    console.log("  --help, -h      Show this help message");
    console.log("  --version, -v   Print the version number");
    console.log("");
    console.log("Environment:");
    console.log("  ANTHROPIC_API_KEY   Required. Get yours at console.anthropic.com");
    process.exit(0);
  }

  const rawLog = await readInput();

  if (!rawLog.trim()) {
    console.error(c.red("Error: no log content provided."));
    console.error("Pass a file path or pipe a log via stdin.");
    process.exit(1);
  }

  const cleanLog = stripAnsi(rawLog);
  const lineCount = cleanLog.split("\n").filter((l) => l.trim()).length;

  if (lineCount < 10) {
    console.error(c.red("Error: Log seems too short to analyse. Make sure you're piping a real CI log."));
    process.exit(1);
  }

  const chunkedLog = chunkLog(cleanLog);
  await analyzeLog(chunkedLog);
}

main().catch((err: Error) => {
  console.error(c.red(`Error: ${err.message}`));
  process.exit(1);
});
