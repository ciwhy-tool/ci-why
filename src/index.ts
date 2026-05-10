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

// ─── Argument parsing ─────────────────────────────────────────────────────────

type LogFormat = "auto" | "jest" | "pytest" | "go" | "rust" | "maven";

interface ParsedArgs {
  command:      string | undefined;
  filePath:     string | undefined;
  jsonMode:     boolean;
  format:       LogFormat;
  help:         boolean;
  version:      boolean;
  showId:       string | undefined;
  clearHistory: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command:      string | undefined;
  let filePath:     string | undefined;
  let jsonMode      = false;
  let format: LogFormat = "auto";
  let help          = false;
  let ver           = false;
  let showId:       string | undefined;
  let clearHistory  = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json")                          { jsonMode = true; }
    else if (arg === "--help"  || arg === "-h")    { help = true; }
    else if (arg === "--version" || arg === "-v")  { ver = true; }
    else if (arg === "--format" && argv[i + 1])    { format = argv[++i] as LogFormat; }
    else if (arg === "--show"   && argv[i + 1])    { showId = argv[++i]; }
    else if (arg === "--clear")                    { clearHistory = true; }
    else if (!arg.startsWith("-")) {
      if (!command && !filePath) {
        if (arg === "setup" || arg === "history") command = arg;
        else filePath = arg;
      }
    }
  }

  return { command, filePath, jsonMode, format, help, version: ver, showId, clearHistory };
}

// ─── History ──────────────────────────────────────────────────────────────────

interface HistoryEntry {
  id:            string;
  date:          string;
  format:        string;
  why:           string;
  failingLine:   string;
  suggestedFix:  string;
  linesAnalyzed: number;
}

const HISTORY_PATH = path.join(os.homedir(), ".config", "ci-why", "history.json");
const MAX_HISTORY  = 100;

function loadHistory(): HistoryEntry[] {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) as HistoryEntry[];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries, null, 2), "utf8");
}

function addToHistory(entry: HistoryEntry): HistoryEntry[] {
  const history = loadHistory();
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  saveHistory(history);
  return history;
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const mon = d.toLocaleString("en-US", { month: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  const hh  = String(d.getHours()).padStart(2, "0");
  const mm  = String(d.getMinutes()).padStart(2, "0");
  return `${mon} ${day} ${hh}:${mm}`;
}

function showHistoryTable(): void {
  const history = loadHistory();
  if (history.length === 0) {
    console.log(c.dim("  No history yet."));
    return;
  }
  const entries = history.slice(0, 10);
  console.log(c.bold(`  ${"ID".padEnd(8)} ${"DATE".padEnd(13)} ${"FORMAT".padEnd(8)} WHY`));
  console.log(c.dim("  " + "─".repeat(72)));
  for (const entry of entries) {
    const why = entry.why.length > 44 ? entry.why.slice(0, 41) + "…" : entry.why;
    console.log(`  ${c.dim(entry.id.padEnd(8))} ${formatDate(entry.date).padEnd(13)} ${entry.format.padEnd(8)} ${why}`);
  }
  if (history.length > 10) {
    console.log(c.dim(`\n  (${history.length - 10} more — use: ci-why history --json)`));
  }
}

function showHistoryEntry(id: string): void {
  const history = loadHistory();
  const entry   = history.find((e) => e.id === id);
  if (!entry) {
    console.error(c.red(`Error: no history entry with id "${id}"`));
    process.exit(1);
  }
  const divider = c.dim("─".repeat(50));
  console.log(divider);
  console.log(c.dim(`  ${entry.date}  ·  ${entry.format}  ·  ${entry.linesAnalyzed} lines analyzed`));
  console.log();
  console.log(c.bold(c.red("  WHY")));            console.log(`  ${entry.why}\n`);
  console.log(c.bold(c.yellow("  FAILING LINE"))); console.log(`  ${entry.failingLine}\n`);
  console.log(c.bold(c.green("  SUGGESTED FIX"))); console.log(`  ${entry.suggestedFix}\n`);
  console.log(divider);
}

async function clearHistoryWithConfirm(): Promise<void> {
  const history = loadHistory();
  if (history.length === 0) {
    console.log(c.dim("  History is already empty."));
    return;
  }
  const answer = await promptLine(`Clear ${history.length} history entries? (y/n) `);
  if (answer.toLowerCase() === "y") {
    saveHistory([]);
    console.log(c.green("  History cleared."));
  } else {
    console.log(c.dim("  Cancelled."));
  }
}

// ─── Log format detection & chunking ─────────────────────────────────────────

const FORMAT_PATTERNS: Record<Exclude<LogFormat, "auto">, RegExp> = {
  jest:   /error|failed|exception|fatal|panic|●|✕/i,
  pytest: /FAILED|AssertionError|traceback|\bE\s+\w/i,
  go:     /FAIL|panic:|--- FAIL/i,
  rust:   /error\[E\d+\]|panicked|^FAILED|^error:/i,
  maven:  /BUILD FAILURE|BUILD FAILED|\[ERROR\]|\[FATAL\]|Exception/i,
};

function detectFormat(text: string): Exclude<LogFormat, "auto"> {
  if (/error\[E\d+\]|thread '.*' panicked/.test(text))        return "rust";
  if (/^--- FAIL:|^panic:/m.test(text))                        return "go";
  if (/^FAILED .+::|AssertionError|^={20,}/m.test(text))      return "pytest";
  if (/BUILD FAILURE|BUILD FAILED|\[ERROR\]|\[FATAL\]/.test(text)) return "maven";
  return "jest";
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function chunkLog(text: string, format: Exclude<LogFormat, "auto">): string {
  const lines   = text.split("\n");
  const pattern = FORMAT_PATTERNS[format];

  const signalLines: string[] = [];
  for (const line of lines) {
    if (pattern.test(line)) signalLines.push(line);
  }

  const tail = lines.slice(-200);

  const seen   = new Set<string>();
  const result: string[] = [];
  for (const line of [...signalLines, ...tail]) {
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }

  return result.join("\n");
}

// ─── Input ────────────────────────────────────────────────────────────────────

async function readInput(filePath?: string): Promise<string> {
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      console.error(c.red(`Error: file not found: ${resolved}`));
      process.exit(1);
    }
    return fs.readFileSync(resolved, "utf8");
  }

  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end",  () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

const MODEL = "claude-haiku-4-5-20251001";

interface AnalysisResult {
  why:           string;
  failingLine:   string;
  suggestedFix:  string;
  linesAnalyzed: number;
  model:         string;
}

function parseResponse(text: string): Omit<AnalysisResult, "linesAnalyzed" | "model"> {
  const why          = text.match(/WHY:\s*(.+?)(?=\nFAILING LINE:|$)/s)?.[1]?.trim() ?? "";
  const failingLine  = text.match(/FAILING LINE:\s*(.+?)(?=\nSUGGESTED FIX:|$)/s)?.[1]?.trim() ?? "";
  const suggestedFix = text.match(/SUGGESTED FIX:\s*(.+?)$/s)?.[1]?.trim() ?? "";
  return { why, failingLine, suggestedFix };
}

async function analyzeLog(
  log: string,
  linesAnalyzed: number,
  jsonMode: boolean,
  resolvedFormat: string,
): Promise<void> {
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

  if (!jsonMode) process.stderr.write(c.dim("Analyzing build log…\n\n"));

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: `Here is the CI build log to analyze:\n\n${log}` }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const parsed = parseResponse(text);

  // Save to history
  const entry: HistoryEntry = {
    id: generateId(),
    date: new Date().toISOString(),
    format: resolvedFormat,
    ...parsed,
    linesAnalyzed,
  };
  const history = addToHistory(entry);

  if (jsonMode) {
    const result: AnalysisResult = { ...parsed, linesAnalyzed, model: MODEL };
    console.log(JSON.stringify(result, null, 2));
  } else {
    displayResult(text);

    // Flaky test warning
    if (parsed.failingLine) {
      const count = history.filter((e) => e.failingLine === parsed.failingLine).length;
      if (count >= 3) {
        console.log(c.yellow(`⚠  This line has failed ${count} times recently — this may be a flaky test.`));
      }
    }
  }
}

function displayResult(text: string): void {
  const { why, failingLine, suggestedFix } = parseResponse(text);
  const divider = c.dim("─".repeat(50));

  console.log(divider);

  if (why)          { console.log(c.bold(c.red("  WHY")));            console.log(`  ${why}\n`); }
  if (failingLine)  { console.log(c.bold(c.yellow("  FAILING LINE"))); console.log(`  ${failingLine}\n`); }
  if (suggestedFix) { console.log(c.bold(c.green("  SUGGESTED FIX"))); console.log(`  ${suggestedFix}\n`); }

  console.log(divider);

  if (!why && !failingLine && !suggestedFix) console.log(text);
}

// ─── Setup wizard ─────────────────────────────────────────────────────────────

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
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
  const configDir  = path.join(os.homedir(), ".config", "ci-why");
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
      model: MODEL,
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
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "setup") { await setup(); process.exit(0); }

  if (args.command === "history") {
    if (args.clearHistory) { await clearHistoryWithConfirm(); process.exit(0); }
    if (args.showId)       { showHistoryEntry(args.showId); process.exit(0); }
    if (args.jsonMode)     { console.log(JSON.stringify(loadHistory(), null, 2)); process.exit(0); }
    showHistoryTable();
    process.exit(0);
  }

  if (args.version) { console.log(version); process.exit(0); }

  if (args.help) {
    console.log(`ci-why v${version} — explain CI build failures in plain English`);
    console.log("");
    console.log("First time? Run: ci-why setup");
    console.log("");
    console.log("Usage:");
    console.log("  cat build.log | ci-why              # pipe a log through stdin");
    console.log("  ci-why ./build.log                  # analyze a log file");
    console.log("  ci-why --json ./build.log            # output results as JSON");
    console.log("  ci-why --format pytest ./build.log  # specify log format");
    console.log("");
    console.log("Commands:");
    console.log("  ci-why setup                Configure your Anthropic API key");
    console.log("  ci-why history              Show last 10 analyzed failures");
    console.log("  ci-why history --show <id>  Show full details of a past failure");
    console.log("  ci-why history --clear      Clear all history");
    console.log("  ci-why history --json       Dump full history as JSON");
    console.log("");
    console.log("Options:");
    console.log("  --json              Output results as JSON instead of coloured text");
    console.log("  --format <fmt>      Log format: auto (default), jest, pytest, go, rust, maven");
    console.log("  --help,    -h       Show this help message");
    console.log("  --version, -v       Print the version number");
    console.log("");
    console.log("Environment:");
    console.log("  ANTHROPIC_API_KEY   Required. Get yours at console.anthropic.com");
    process.exit(0);
  }

  const rawLog = await readInput(args.filePath);

  if (!rawLog.trim()) {
    console.error(c.red("Error: no log content provided."));
    console.error("Pass a file path or pipe a log via stdin.");
    process.exit(1);
  }

  const cleanLog  = stripAnsi(rawLog);
  const lineCount = cleanLog.split("\n").filter((l) => l.trim()).length;

  if (lineCount < 10) {
    console.error(c.red("Error: Log seems too short to analyse. Make sure you're piping a real CI log."));
    process.exit(1);
  }

  const resolvedFormat = args.format === "auto" ? detectFormat(cleanLog) : args.format;
  const chunkedLog     = chunkLog(cleanLog, resolvedFormat);
  const linesAnalyzed  = chunkedLog.split("\n").filter((l) => l.trim()).length;

  await analyzeLog(chunkedLog, linesAnalyzed, args.jsonMode, resolvedFormat);
}

main().catch((err: Error) => {
  console.error(c.red(`Error: ${err.message}`));
  process.exit(1);
});
