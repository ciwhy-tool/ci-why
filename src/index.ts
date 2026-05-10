#!/usr/bin/env node

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as https from "https";
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
  subCommand:   string | undefined;
  filePath:     string | undefined;
  jsonMode:     boolean;
  format:       LogFormat;
  help:         boolean;
  version:      boolean;
  showId:       string | undefined;
  clearHistory: boolean;
  noNotify:     boolean;
  dryRun:       boolean;
  since:        string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command:      string | undefined;
  let subCommand:   string | undefined;
  let filePath:     string | undefined;
  let jsonMode      = false;
  let format: LogFormat = "auto";
  let help          = false;
  let ver           = false;
  let showId:       string | undefined;
  let clearHistory  = false;
  let noNotify      = false;
  let dryRun        = false;
  let since:        string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json")                          { jsonMode = true; }
    else if (arg === "--help"  || arg === "-h")    { help = true; }
    else if (arg === "--version" || arg === "-v")  { ver = true; }
    else if (arg === "--format" && argv[i + 1])    { format = argv[++i] as LogFormat; }
    else if (arg === "--show"   && argv[i + 1])    { showId = argv[++i]; }
    else if (arg === "--clear")                    { clearHistory = true; }
    else if (arg === "--no-notify")                { noNotify = true; }
    else if (arg === "--dry-run")                  { dryRun = true; }
    else if (arg === "--since"  && argv[i + 1])    { since = argv[++i]; }
    else if (!arg.startsWith("-")) {
      if (!command) {
        if (["setup", "history", "notify", "fix", "flaky"].includes(arg)) command = arg;
        else filePath = arg;
      } else if (!subCommand && !filePath) {
        if (command === "notify" && (arg === "setup" || arg === "test" || arg === "clear")) {
          subCommand = arg;
        } else {
          filePath = arg;
        }
      }
    }
  }

  return { command, subCommand, filePath, jsonMode, format, help, version: ver, showId, clearHistory, noNotify, dryRun, since };
}

// ─── Config file helpers ──────────────────────────────────────────────────────

const CONFIG_DIR  = path.join(os.homedir(), ".config", "ci-why");
const CONFIG_PATH = path.join(CONFIG_DIR, ".env");

function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(CONFIG_PATH, "utf8").split("\n")) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) result[match[1].trim()] = match[2].trim();
  }
  return result;
}

function writeEnvFile(entries: Record<string, string>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const content = Object.entries(entries).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  fs.writeFileSync(CONFIG_PATH, content, "utf8");
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

const HISTORY_PATH = path.join(CONFIG_DIR, "history.json");
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
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
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

// ─── Flaky test detection ─────────────────────────────────────────────────────

interface FlakySummary {
  failingLine:   string;
  failureCount:  number;
  uniqueReasons: number;
  lastSeen:      string;
  confidence:    "HIGH" | "MEDIUM" | "LOW";
}

function detectFlakyTests(history: HistoryEntry[], since?: Date): FlakySummary[] {
  const filtered = since
    ? history.filter((e) => new Date(e.date) >= since)
    : history;

  const grouped = new Map<string, HistoryEntry[]>();
  for (const entry of filtered) {
    if (!entry.failingLine) continue;
    if (!grouped.has(entry.failingLine)) grouped.set(entry.failingLine, []);
    grouped.get(entry.failingLine)!.push(entry);
  }

  const results: FlakySummary[] = [];
  for (const [failingLine, entries] of grouped) {
    if (entries.length < 2) continue;

    const uniqueReasons = new Set(entries.map((e) => e.why)).size;
    const lastSeen      = [...entries].sort((a, b) => b.date.localeCompare(a.date))[0].date;

    let confidence: "HIGH" | "MEDIUM" | "LOW";
    if (uniqueReasons > 1 && entries.length >= 4) confidence = "HIGH";
    else if (uniqueReasons > 1)                   confidence = "MEDIUM";
    else                                           confidence = "LOW";

    results.push({ failingLine, failureCount: entries.length, uniqueReasons, lastSeen, confidence });
  }

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  results.sort((a, b) =>
    order[a.confidence] !== order[b.confidence]
      ? order[a.confidence] - order[b.confidence]
      : b.failureCount - a.failureCount,
  );

  return results;
}

function displayFlakyReport(summaries: FlakySummary[]): void {
  const divider = c.dim("─".repeat(50));
  console.log(divider);
  console.log(c.bold("  FLAKY TEST REPORT"));
  console.log(divider);

  if (summaries.length === 0) {
    console.log(c.dim("  No flaky tests detected."));
    console.log(divider);
    return;
  }

  for (const s of summaries) {
    const reasonText = s.uniqueReasons === 1
      ? "1 failure reason"
      : `${s.uniqueReasons} different failure reasons`;
    const confStr =
      s.confidence === "HIGH"   ? c.red(c.bold("HIGH")) :
      s.confidence === "MEDIUM" ? c.yellow("MEDIUM")    : c.dim("LOW");

    console.log(`${c.yellow("⚠")}  ${s.failingLine}`);
    console.log(`   Failed ${s.failureCount} times — ${reasonText}`);
    console.log(`   Last seen: ${s.lastSeen.slice(0, 10)}`);
    console.log(`   Confidence: ${confStr}`);
    console.log();
  }

  console.log(divider);
  const noun = summaries.length === 1 ? "flaky test" : "flaky tests";
  console.log(`${c.yellow(`${summaries.length} ${noun} detected`)}. Run ci-why history to see full details.`);
}

function warnIfHighConfidenceFlaky(): void {
  const history = loadHistory();
  const high = detectFlakyTests(history).filter((s) => s.confidence === "HIGH");
  if (high.length > 0) {
    const noun = high.length === 1 ? "high-confidence flaky test" : "high-confidence flaky tests";
    console.log(c.yellow(`\n⚠  WARNING: ci-why detected ${high.length} ${noun}. Run ci-why flaky for the full report.`));
  }
}

// ─── Slack ────────────────────────────────────────────────────────────────────

function buildSlackMessage(
  why: string,
  failingLine: string,
  suggestedFix: string,
  fmt: string,
): object {
  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "ci-why: build failure detected", emoji: false },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*WHY*\n${why}` },
          { type: "mrkdwn", text: `*FAILING LINE*\n\`${failingLine}\`` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*SUGGESTED FIX*\n${suggestedFix}` },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `Format: ${fmt} · ${new Date().toISOString()}` },
        ],
      },
    ],
  };
}

function postToSlack(webhookUrl: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(webhookUrl);
    const req  = https.request(
      {
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   "POST",
        headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new Error(`Slack webhook returned HTTP ${res.statusCode}`));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function notifySetup(): Promise<void> {
  console.log(c.bold("Slack notification setup"));
  console.log("You need an incoming webhook URL from Slack.");
  console.log("To create one:");
  console.log("  1. Go to api.slack.com/apps → Create New App → From scratch");
  console.log("  2. In your app settings, go to Incoming Webhooks and turn it on");
  console.log("  3. Click 'Add New Webhook to Workspace', choose a channel, click Allow");
  console.log("  4. Copy the webhook URL below\n");

  const webhookUrl = await promptLine("Paste your Slack webhook URL: ");
  if (!webhookUrl.startsWith("https://hooks.slack.com/")) {
    console.error(c.red("Invalid webhook URL — it should start with https://hooks.slack.com/"));
    process.exit(1);
  }

  const entries = readEnvFile();
  entries["SLACK_WEBHOOK_URL"] = webhookUrl;
  writeEnvFile(entries);

  console.log(c.green("\nSlack notifications configured! ci-why will now post to Slack on every failure."));
  console.log(c.dim("Test it with: ci-why notify test"));
}

async function notifyTest(): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error(c.red("No Slack webhook configured. Run: ci-why notify setup"));
    process.exit(1);
  }
  process.stdout.write(c.dim("Sending test notification… "));
  try {
    await postToSlack(webhookUrl, buildSlackMessage(
      "This is a test message from ci-why",
      "ci-why notify test",
      "If you see this in Slack, notifications are working correctly!",
      "test",
    ));
    console.log(c.green("OK"));
  } catch (err) {
    console.log(c.red("FAILED"));
    console.error(c.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

async function notifyClear(): Promise<void> {
  const entries = readEnvFile();
  if (!entries["SLACK_WEBHOOK_URL"]) {
    console.log(c.dim("No Slack webhook configured."));
    return;
  }
  const answer = await promptLine("Remove Slack webhook? (y/n) ");
  if (answer.toLowerCase() === "y") {
    delete entries["SLACK_WEBHOOK_URL"];
    writeEnvFile(entries);
    console.log(c.green("Slack webhook removed."));
  } else {
    console.log(c.dim("Cancelled."));
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

const ANALYSIS_SYSTEM_PROMPT = `You are a CI/CD build failure analyst. Given a build log, respond ONLY in this exact format — no extra commentary:

WHY: <one clear sentence explaining the root cause of the failure>
FAILING LINE: <the exact line, command, or file reference that caused it>
SUGGESTED FIX: <one actionable step the developer can take to fix it>`;

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

async function analyzeLog(
  log: string,
  linesAnalyzed: number,
  jsonMode: boolean,
  resolvedFormat: string,
  noNotify: boolean,
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

  if (!jsonMode) process.stderr.write(c.dim("Analyzing build log…\n\n"));

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Here is the CI build log to analyze:\n\n${log}` }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const parsed = parseResponse(text);

  addToHistory({
    id: generateId(),
    date: new Date().toISOString(),
    format: resolvedFormat,
    ...parsed,
    linesAnalyzed,
  });

  if (jsonMode) {
    const result: AnalysisResult = { ...parsed, linesAnalyzed, model: MODEL };
    console.log(JSON.stringify(result, null, 2));
  } else {
    displayResult(text);
    warnIfHighConfidenceFlaky();
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!noNotify && webhookUrl) {
    try {
      await postToSlack(webhookUrl, buildSlackMessage(
        parsed.why, parsed.failingLine, parsed.suggestedFix, resolvedFormat,
      ));
    } catch (err) {
      process.stderr.write(c.dim(`⚠  Slack notification failed: ${(err as Error).message}\n`));
    }
  }
}

// ─── Fix command ──────────────────────────────────────────────────────────────

const PATCH_SYSTEM_PROMPT = `You are a code patch generator. Given a CI build error and the contents of the failing source file, produce a minimal fix.

Respond in EXACTLY this format — no extra text before or after:

FILE: <relative file path>
LINE: <line number of the primary change>
DISPLAY:
--- a/<file path>
+++ b/<file path>
@@ -<n>,<count> +<n>,<count> @@
 <context line>
-<old line>
+<new line>
 <context line>
APPLY_OLD:
<exact text to find in the file — must match verbatim including whitespace>
APPLY_NEW:
<exact replacement text>`;

interface PatchResult {
  file:     string;
  line:     string;
  display:  string;
  applyOld: string;
  applyNew: string;
}

function parsePatchResponse(text: string): PatchResult | null {
  const file     = text.match(/^FILE:\s*(.+)$/m)?.[1]?.trim();
  const line     = text.match(/^LINE:\s*(.+)$/m)?.[1]?.trim();
  const display  = text.match(/DISPLAY:\n([\s\S]+?)(?=\nAPPLY_OLD:)/)?.[1]?.trim();
  const applyOld = text.match(/APPLY_OLD:\n([\s\S]+?)(?=\nAPPLY_NEW:)/)?.[1];
  const applyNew = text.match(/APPLY_NEW:\n([\s\S]+?)$/)?.[1];
  if (!file || !display) return null;
  return { file, line: line ?? "?", display, applyOld: applyOld ?? "", applyNew: applyNew ?? "" };
}

function extractFilePath(text: string): string | undefined {
  const match = text.match(/([./][\w./\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h))/i);
  return match?.[1];
}

function displayPatch(patch: PatchResult): void {
  const divider = c.dim("─".repeat(50));
  console.log(divider);
  console.log(c.bold("  SUGGESTED PATCH"));
  console.log(c.dim(`  ${patch.file}  line ${patch.line}`));
  console.log(divider);
  for (const ln of patch.display.split("\n")) {
    if (ln.startsWith("-") && !ln.startsWith("---"))      console.log(c.red(ln));
    else if (ln.startsWith("+") && !ln.startsWith("+++")) console.log(c.green(ln));
    else                                                   console.log(c.dim(ln));
  }
  console.log(divider);
}

function savePatchFile(display: string, id: string): string {
  const filename = `ci-why-fix-${id}.patch`;
  fs.writeFileSync(path.join(process.cwd(), filename), display + "\n", "utf8");
  return filename;
}

async function fixCommand(
  log: string,
  linesAnalyzed: number,
  resolvedFormat: string,
  dryRun: boolean,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(c.red("Error: ANTHROPIC_API_KEY is not set."));
    console.error("Run: ci-why setup");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  process.stderr.write(c.dim("Analyzing build log…\n\n"));

  const analysisResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Here is the CI build log to analyze:\n\n${log}` }],
  });

  const analysisText = analysisResponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = parseResponse(analysisText);
  displayResult(analysisText);

  const id = generateId();
  addToHistory({ id, date: new Date().toISOString(), format: resolvedFormat, ...parsed, linesAnalyzed });
  warnIfHighConfidenceFlaky();

  const filePath = extractFilePath(parsed.failingLine) ?? extractFilePath(parsed.why);
  if (!filePath || !fs.existsSync(path.resolve(filePath))) {
    console.log(c.dim("\nCould not locate the source file to patch."));
    console.log("Here is the suggested fix to apply manually:\n");
    console.log(`  ${parsed.suggestedFix}`);
    return;
  }

  process.stderr.write(c.dim("\nGenerating patch…\n\n"));
  const fileContent = fs.readFileSync(path.resolve(filePath), "utf8");

  const patchResponse = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: PATCH_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: `Build error analysis:\n${analysisText}\n\nFile: ${filePath}\n\`\`\`\n${fileContent}\n\`\`\``,
    }],
  });

  const patchText = patchResponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const patch = parsePatchResponse(patchText);
  if (!patch) {
    console.log(c.dim("\nCould not generate a patch."));
    console.log("Here is the suggested fix to apply manually:\n");
    console.log(`  ${parsed.suggestedFix}`);
    return;
  }

  displayPatch(patch);

  if (dryRun) return;

  const answer = await promptLine("Apply this patch? (y/n) ");
  if (answer.toLowerCase() === "y") {
    const original = fs.readFileSync(path.resolve(filePath), "utf8");
    if (patch.applyOld && original.includes(patch.applyOld)) {
      fs.writeFileSync(path.resolve(filePath), original.replace(patch.applyOld, patch.applyNew), "utf8");
      console.log(c.green("Patch applied. Run your tests to verify the fix."));
    } else {
      console.log(c.red("Could not apply the patch automatically — the expected code was not found."));
      const patchFile = savePatchFile(patch.display, id);
      console.log(c.dim(`Saved as ${patchFile}`));
    }
  } else {
    const patchFile = savePatchFile(patch.display, id);
    console.log(c.dim(`${patchFile} saved to current directory.`));
  }
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
  const entries = readEnvFile();
  entries["ANTHROPIC_API_KEY"] = apiKey;
  writeEnvFile(entries);
  console.log(c.green(`\nKey saved to ${CONFIG_PATH}`));
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

  if (args.command === "notify") {
    if (args.subCommand === "setup") { await notifySetup(); process.exit(0); }
    if (args.subCommand === "test")  { await notifyTest();  process.exit(0); }
    if (args.subCommand === "clear") { await notifyClear(); process.exit(0); }
    console.error(c.red("Usage: ci-why notify <setup|test|clear>"));
    process.exit(1);
  }

  if (args.command === "history") {
    if (args.clearHistory) { await clearHistoryWithConfirm(); process.exit(0); }
    if (args.showId)       { showHistoryEntry(args.showId); process.exit(0); }
    if (args.jsonMode)     { console.log(JSON.stringify(loadHistory(), null, 2)); process.exit(0); }
    showHistoryTable();
    process.exit(0);
  }

  if (args.command === "flaky") {
    let since: Date | undefined;
    if (args.since) {
      since = new Date(args.since);
      if (isNaN(since.getTime())) {
        console.error(c.red(`Invalid date: "${args.since}". Use ISO format, e.g. 2026-05-01`));
        process.exit(1);
      }
    }
    const summaries = detectFlakyTests(loadHistory(), since);
    if (args.jsonMode) {
      console.log(JSON.stringify(summaries, null, 2));
    } else {
      displayFlakyReport(summaries);
    }
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
    console.log("  ci-why fix ./build.log              # analyze and suggest a code patch");
    console.log("  ci-why fix --dry-run ./build.log    # show patch without applying it");
    console.log("  ci-why --json ./build.log            # output results as JSON");
    console.log("  ci-why --format pytest ./build.log  # specify log format");
    console.log("  ci-why --no-notify ./build.log      # skip Slack notification");
    console.log("");
    console.log("Commands:");
    console.log("  ci-why setup                Configure your Anthropic API key");
    console.log("  ci-why fix                  Analyse and suggest a code patch");
    console.log("  ci-why fix --dry-run        Show patch without applying it");
    console.log("  ci-why flaky                Show flaky test report");
    console.log("  ci-why flaky --json         Output flaky report as JSON");
    console.log("  ci-why flaky --since <date> Only consider failures after date (e.g. 2026-05-01)");
    console.log("  ci-why history              Show last 10 analyzed failures");
    console.log("  ci-why history --show <id>  Show full details of a past failure");
    console.log("  ci-why history --clear      Clear all history");
    console.log("  ci-why history --json       Dump full history as JSON");
    console.log("  ci-why notify setup         Configure Slack webhook");
    console.log("  ci-why notify test          Send a test Slack notification");
    console.log("  ci-why notify clear         Remove saved Slack webhook");
    console.log("");
    console.log("Options:");
    console.log("  --json              Output results as JSON instead of coloured text");
    console.log("  --format <fmt>      Log format: auto (default), jest, pytest, go, rust, maven");
    console.log("  --no-notify         Skip Slack notification for this run");
    console.log("  --dry-run           Show patch without applying or saving it");
    console.log("  --since <date>      Filter history by date (ISO format)");
    console.log("  --help,    -h       Show this help message");
    console.log("  --version, -v       Print the version number");
    console.log("");
    console.log("Environment:");
    console.log("  ANTHROPIC_API_KEY   Required. Get yours at console.anthropic.com");
    console.log("  SLACK_WEBHOOK_URL   Optional. Set via: ci-why notify setup");
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

  if (args.command === "fix") {
    await fixCommand(chunkedLog, linesAnalyzed, resolvedFormat, args.dryRun);
  } else {
    await analyzeLog(chunkedLog, linesAnalyzed, args.jsonMode, resolvedFormat, args.noNotify);
  }
}

main().catch((err: Error) => {
  console.error(c.red(`Error: ${err.message}`));
  process.exit(1);
});
