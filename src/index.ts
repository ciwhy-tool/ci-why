#!/usr/bin/env node

import * as dotenv from "dotenv";
import * as fs from "fs";
import * as http from "http";
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
  model:        string | undefined;
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
  let model:        string | undefined;

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
    else if (arg === "--model"  && argv[i + 1])    { model = argv[++i]; }
    else if (!arg.startsWith("-")) {
      if (!command) {
        if (["setup", "history", "notify", "fix", "flaky", "models"].includes(arg)) command = arg;
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

  return { command, subCommand, filePath, jsonMode, format, help, version: ver, showId, clearHistory, noNotify, dryRun, since, model };
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
  if (history.length === 0) { console.log(c.dim("  No history yet.")); return; }
  const entries = history.slice(0, 10);
  console.log(c.bold(`  ${"ID".padEnd(8)} ${"DATE".padEnd(13)} ${"FORMAT".padEnd(8)} WHY`));
  console.log(c.dim("  " + "─".repeat(72)));
  for (const entry of entries) {
    const why = entry.why.length > 44 ? entry.why.slice(0, 41) + "…" : entry.why;
    console.log(`  ${c.dim(entry.id.padEnd(8))} ${formatDate(entry.date).padEnd(13)} ${entry.format.padEnd(8)} ${why}`);
  }
  if (history.length > 10) console.log(c.dim(`\n  (${history.length - 10} more — use: ci-why history --json)`));
}

function showHistoryEntry(id: string): void {
  const history = loadHistory();
  const entry   = history.find((e) => e.id === id);
  if (!entry) { console.error(c.red(`Error: no history entry with id "${id}"`)); process.exit(1); }
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
  if (history.length === 0) { console.log(c.dim("  History is already empty.")); return; }
  const answer = await promptLine(`Clear ${history.length} history entries? (y/n) `);
  if (answer.toLowerCase() === "y") { saveHistory([]); console.log(c.green("  History cleared.")); }
  else console.log(c.dim("  Cancelled."));
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
  const filtered = since ? history.filter((e) => new Date(e.date) >= since) : history;
  const grouped  = new Map<string, HistoryEntry[]>();
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
    const confidence: "HIGH" | "MEDIUM" | "LOW" =
      uniqueReasons > 1 && entries.length >= 4 ? "HIGH" :
      uniqueReasons > 1                         ? "MEDIUM" : "LOW";
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
  if (summaries.length === 0) { console.log(c.dim("  No flaky tests detected.")); console.log(divider); return; }
  for (const s of summaries) {
    const reasonText = s.uniqueReasons === 1 ? "1 failure reason" : `${s.uniqueReasons} different failure reasons`;
    const confStr    = s.confidence === "HIGH" ? c.red(c.bold("HIGH")) : s.confidence === "MEDIUM" ? c.yellow("MEDIUM") : c.dim("LOW");
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
  const high = detectFlakyTests(loadHistory()).filter((s) => s.confidence === "HIGH");
  if (high.length > 0) {
    const noun = high.length === 1 ? "high-confidence flaky test" : "high-confidence flaky tests";
    console.log(c.yellow(`\n⚠  WARNING: ci-why detected ${high.length} ${noun}. Run ci-why flaky for the full report.`));
  }
}

// ─── Model providers ──────────────────────────────────────────────────────────

interface ModelSpec {
  provider: "anthropic" | "ollama" | "openai";
  model:    string;
}

const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  "claude-haiku":  "claude-haiku-4-5-20251001",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-opus":   "claude-opus-4-7",
};

const DEFAULT_MODEL_SPEC = "anthropic:claude-haiku-4-5-20251001";

function parseModelSpec(s: string): ModelSpec {
  const colon = s.indexOf(":");
  if (colon === -1) {
    return { provider: "anthropic", model: ANTHROPIC_MODEL_MAP[s] ?? s };
  }
  const provider  = s.slice(0, colon) as ModelSpec["provider"];
  const modelName = s.slice(colon + 1);
  const model     = provider === "anthropic" ? (ANTHROPIC_MODEL_MAP[modelName] ?? modelName) : modelName;
  return { provider, model };
}

function httpPost(hostname: string, port: number, urlPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path: urlPath, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else resolve(data);
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsPost(hostname: string, urlPath: string, headers: Record<string, string>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: urlPath, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else resolve(data);
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function callAnthropic(model: string, systemPrompt: string, userContent: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(c.red("Error: ANTHROPIC_API_KEY is not set."));
    console.error("Get your free key at console.anthropic.com, then run:");
    console.error("  export ANTHROPIC_API_KEY=your-key-here");
    console.error("Or run: ci-why setup");
    process.exit(1);
  }
  const client   = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system:     systemPrompt,
    messages:   [{ role: "user", content: userContent }],
  });
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

async function callOllama(model: string, systemPrompt: string, userContent: string): Promise<string> {
  const body = JSON.stringify({
    model,
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
    stream: false,
  });
  let raw: string;
  try {
    raw = await httpPost("localhost", 11434, "/api/chat", body);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      console.error(c.red("Ollama is not running. Start it with:"));
      console.error("  ollama serve");
      console.error(`Then pull a model: ollama pull ${model}`);
      process.exit(1);
    }
    throw err;
  }
  return (JSON.parse(raw) as { message?: { content?: string } }).message?.content ?? "";
}

async function callOpenAI(model: string, systemPrompt: string, userContent: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(c.red("OPENAI_API_KEY is not set. Get one at platform.openai.com"));
    console.error("Then run:  export OPENAI_API_KEY=your-key-here");
    process.exit(1);
  }
  const body = JSON.stringify({
    model,
    messages:   [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
    max_tokens: 1024,
  });
  const raw = await httpsPost("api.openai.com", "/v1/chat/completions", {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${apiKey}`,
  }, body);
  const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  return parsed.choices?.[0]?.message?.content ?? "";
}

async function callModel(spec: ModelSpec, systemPrompt: string, userContent: string): Promise<string> {
  switch (spec.provider) {
    case "anthropic": return callAnthropic(spec.model, systemPrompt, userContent);
    case "ollama":    return callOllama(spec.model, systemPrompt, userContent);
    case "openai":    return callOpenAI(spec.model, systemPrompt, userContent);
    default:
      console.error(c.red(`Unknown provider: "${(spec as ModelSpec).provider}". Use anthropic, ollama, or openai.`));
      process.exit(1);
  }
}

async function getOllamaModels(): Promise<string[]> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "localhost", port: 11434, path: "/api/tags", method: "GET" }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as { models?: Array<{ name: string }> };
          resolve((parsed.models ?? []).map((m) => m.name));
        } catch { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.end();
  });
}

async function showModels(): Promise<void> {
  console.log(c.bold("  Anthropic") + c.dim("  (cloud · requires ANTHROPIC_API_KEY)"));
  for (const [short, full] of Object.entries(ANTHROPIC_MODEL_MAP)) {
    const tag = short === "claude-haiku" ? c.dim(" (default)") : "";
    console.log(`  anthropic:${short.padEnd(16)} ${c.dim(full)}${tag}`);
  }
  console.log();

  console.log(c.bold("  OpenAI") + c.dim("  (cloud · requires OPENAI_API_KEY)"));
  for (const m of ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"]) {
    console.log(`  openai:${m}`);
  }
  console.log();

  console.log(c.bold("  Ollama") + c.dim("  (local · free · requires ollama installed)"));
  const ollamaModels = await getOllamaModels();
  if (ollamaModels.length === 0) {
    console.log(c.dim("  Ollama is not running or no models pulled."));
    console.log(c.dim("  Start with: ollama serve"));
    console.log(c.dim("  Pull a model: ollama pull llama3"));
  } else {
    for (const m of ollamaModels) console.log(`  ollama:${m}`);
  }
  console.log();
  console.log(c.dim("Usage: ci-why --model anthropic:claude-sonnet ./build.log"));
  console.log(c.dim("       ci-why --model ollama:llama3 ./build.log"));
  console.log(c.dim("       ci-why --model openai:gpt-4o ./build.log"));
}

// ─── Slack ────────────────────────────────────────────────────────────────────

function buildSlackMessage(why: string, failingLine: string, suggestedFix: string, fmt: string): object {
  return {
    blocks: [
      { type: "header", text: { type: "plain_text", text: "ci-why: build failure detected", emoji: false } },
      { type: "section", fields: [{ type: "mrkdwn", text: `*WHY*\n${why}` }, { type: "mrkdwn", text: `*FAILING LINE*\n\`${failingLine}\`` }] },
      { type: "section", text: { type: "mrkdwn", text: `*SUGGESTED FIX*\n${suggestedFix}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Format: ${fmt} · ${new Date().toISOString()}` }] },
    ],
  };
}

function postToSlack(webhookUrl: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(webhookUrl);
    const req  = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { res.resume(); if (res.statusCode === 200) resolve(); else reject(new Error(`Slack webhook returned HTTP ${res.statusCode}`)); },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function notifySetup(): Promise<void> {
  console.log(c.bold("Slack notification setup"));
  console.log("  1. Go to api.slack.com/apps → Create New App → From scratch");
  console.log("  2. Incoming Webhooks → turn on → Add New Webhook to Workspace");
  console.log("  3. Choose a channel, click Allow, copy the webhook URL\n");
  const webhookUrl = await promptLine("Paste your Slack webhook URL: ");
  if (!webhookUrl.startsWith("https://hooks.slack.com/")) {
    console.error(c.red("Invalid webhook URL — must start with https://hooks.slack.com/")); process.exit(1);
  }
  const entries = readEnvFile();
  entries["SLACK_WEBHOOK_URL"] = webhookUrl;
  writeEnvFile(entries);
  console.log(c.green("\nSlack notifications configured!"));
  console.log(c.dim("Test it with: ci-why notify test"));
}

async function notifyTest(): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) { console.error(c.red("No Slack webhook configured. Run: ci-why notify setup")); process.exit(1); }
  process.stdout.write(c.dim("Sending test notification… "));
  try {
    await postToSlack(webhookUrl, buildSlackMessage("This is a test message from ci-why", "ci-why notify test", "If you see this in Slack, notifications are working!", "test"));
    console.log(c.green("OK"));
  } catch (err) { console.log(c.red("FAILED")); console.error(c.red(`Error: ${(err as Error).message}`)); process.exit(1); }
}

async function notifyClear(): Promise<void> {
  const entries = readEnvFile();
  if (!entries["SLACK_WEBHOOK_URL"]) { console.log(c.dim("No Slack webhook configured.")); return; }
  const answer = await promptLine("Remove Slack webhook? (y/n) ");
  if (answer.toLowerCase() === "y") { delete entries["SLACK_WEBHOOK_URL"]; writeEnvFile(entries); console.log(c.green("Slack webhook removed.")); }
  else console.log(c.dim("Cancelled."));
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
  if (/error\[E\d+\]|thread '.*' panicked/.test(text))            return "rust";
  if (/^--- FAIL:|^panic:/m.test(text))                            return "go";
  if (/^FAILED .+::|AssertionError|^={20,}/m.test(text))          return "pytest";
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
  for (const line of lines) { if (pattern.test(line)) signalLines.push(line); }
  const tail = lines.slice(-200);
  const seen = new Set<string>(); const result: string[] = [];
  for (const line of [...signalLines, ...tail]) { if (!seen.has(line)) { seen.add(line); result.push(line); } }
  return result.join("\n");
}

// ─── Input ────────────────────────────────────────────────────────────────────

async function readInput(filePath?: string): Promise<string> {
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) { console.error(c.red(`Error: file not found: ${resolved}`)); process.exit(1); }
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
  modelSpec: ModelSpec,
): Promise<void> {
  if (!jsonMode) process.stderr.write(c.dim(`Analyzing build log with ${modelSpec.provider}:${modelSpec.model}…\n\n`));

  const text   = await callModel(modelSpec, ANALYSIS_SYSTEM_PROMPT, `Here is the CI build log to analyze:\n\n${log}`);
  const parsed = parseResponse(text);

  addToHistory({ id: generateId(), date: new Date().toISOString(), format: resolvedFormat, ...parsed, linesAnalyzed });

  if (jsonMode) {
    const result: AnalysisResult = { ...parsed, linesAnalyzed, model: `${modelSpec.provider}:${modelSpec.model}` };
    console.log(JSON.stringify(result, null, 2));
  } else {
    displayResult(text);
    warnIfHighConfidenceFlaky();
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!noNotify && webhookUrl) {
    try { await postToSlack(webhookUrl, buildSlackMessage(parsed.why, parsed.failingLine, parsed.suggestedFix, resolvedFormat)); }
    catch (err) { process.stderr.write(c.dim(`⚠  Slack notification failed: ${(err as Error).message}\n`)); }
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

interface PatchResult { file: string; line: string; display: string; applyOld: string; applyNew: string; }

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
  return text.match(/([./][\w./\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h))/i)?.[1];
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
  modelSpec: ModelSpec,
): Promise<void> {
  process.stderr.write(c.dim(`Analyzing build log with ${modelSpec.provider}:${modelSpec.model}…\n\n`));

  const analysisText = await callModel(modelSpec, ANALYSIS_SYSTEM_PROMPT, `Here is the CI build log to analyze:\n\n${log}`);
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
  const patchText   = await callModel(
    modelSpec,
    PATCH_SYSTEM_PROMPT,
    `Build error analysis:\n${analysisText}\n\nFile: ${filePath}\n\`\`\`\n${fileContent}\n\`\`\``,
  );

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
      console.log(c.dim(`Saved as ${savePatchFile(patch.display, id)}`));
    }
  } else {
    console.log(c.dim(`${savePatchFile(patch.display, id)} saved to current directory.`));
  }
}

// ─── Setup wizard ─────────────────────────────────────────────────────────────

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => { rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }); });
}

async function promptForKey(prefix: string): Promise<string> {
  while (true) {
    const key = await promptLine("Paste your API key here: ");
    if (key.startsWith(prefix)) return key;
    console.error(c.red(`Invalid key — ${prefix === "sk-ant-" ? "Anthropic" : "OpenAI"} keys start with ${prefix}. Try again.\n`));
  }
}

function saveKey(envVar: string, apiKey: string): void {
  const entries = readEnvFile();
  entries[envVar] = apiKey;
  writeEnvFile(entries);
  console.log(c.green(`\nKey saved to ${CONFIG_PATH}`));
}

function printShellInstructions(varName: string, apiKey: string): void {
  console.log("\nTo make this permanent in your shell:\n");
  if (process.platform === "win32") {
    console.log(`  Add ${varName}=${apiKey} to System Environment Variables.`);
  } else {
    console.log(`  Add this to ~/.bashrc or ~/.zshrc:\n\n    export ${varName}=${apiKey}\n`);
    console.log("  Then: source ~/.bashrc");
  }
}

async function testAnthropicKey(apiKey: string): Promise<void> {
  process.stdout.write(c.dim("\nTesting your API key… "));
  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    console.log(c.green("OK"));
    console.log(c.bold("\nSetup complete! Try: cat build.log | ci-why"));
  } catch {
    console.log(c.red("FAILED"));
    console.error(c.red("That key didn't work — double check it at console.anthropic.com"));
    process.exit(1);
  }
}

async function setup(): Promise<void> {
  console.log(c.bold("Welcome to ci-why setup!\n"));
  console.log("Which AI provider do you want to use?");
  console.log("  (1) Anthropic — cloud, requires API key " + c.dim("(recommended)"));
  console.log("  (2) Ollama    — local, free, requires Ollama installed");
  console.log("  (3) OpenAI    — cloud, requires API key");
  console.log();

  let choice = "";
  while (!["1", "2", "3"].includes(choice)) {
    choice = await promptLine("Enter 1, 2, or 3: ");
  }

  const entries = readEnvFile();

  if (choice === "1") {
    if (process.env.ANTHROPIC_API_KEY) {
      console.log(c.green("\nAnthropic API key already configured. You're good to go!"));
    } else {
      console.log("\nGet your free Anthropic API key at: console.anthropic.com\n");
      const apiKey = await promptForKey("sk-ant-");
      saveKey("ANTHROPIC_API_KEY", apiKey);
      printShellInstructions("ANTHROPIC_API_KEY", apiKey);
      await testAnthropicKey(apiKey);
    }
    entries["CI_WHY_MODEL"] = "anthropic:claude-haiku";
    writeEnvFile(entries);
  } else if (choice === "2") {
    console.log(c.bold("\nOllama setup"));
    console.log("1. Install Ollama from ollama.com");
    console.log("2. Start it:      ollama serve");
    console.log("3. Pull a model:  ollama pull llama3\n");
    const modelName = await promptLine("Which Ollama model? (default: llama3) ");
    const chosenModel = modelName || "llama3";
    entries["CI_WHY_MODEL"] = `ollama:${chosenModel}`;
    writeEnvFile(entries);
    console.log(c.green(`\nSaved. ci-why will use ollama:${chosenModel}.`));
    console.log(c.dim(`Make sure Ollama is running and you've run: ollama pull ${chosenModel}`));
  } else {
    if (process.env.OPENAI_API_KEY) {
      console.log(c.green("\nOpenAI API key already configured. You're good to go!"));
    } else {
      console.log("\nGet your OpenAI API key at: platform.openai.com\n");
      const apiKey = await promptForKey("sk-");
      saveKey("OPENAI_API_KEY", apiKey);
      printShellInstructions("OPENAI_API_KEY", apiKey);
    }
    const modelName = await promptLine("Which OpenAI model? (default: gpt-4o) ");
    const chosenModel = modelName || "gpt-4o";
    entries["CI_WHY_MODEL"] = `openai:${chosenModel}`;
    writeEnvFile(entries);
    console.log(c.green(`\nSetup complete! ci-why will use openai:${chosenModel}.`));
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "setup") { await setup(); process.exit(0); }

  if (args.command === "models") { await showModels(); process.exit(0); }

  if (args.command === "notify") {
    if (args.subCommand === "setup") { await notifySetup(); process.exit(0); }
    if (args.subCommand === "test")  { await notifyTest();  process.exit(0); }
    if (args.subCommand === "clear") { await notifyClear(); process.exit(0); }
    console.error(c.red("Usage: ci-why notify <setup|test|clear>")); process.exit(1);
  }

  if (args.command === "history") {
    if (args.clearHistory) { await clearHistoryWithConfirm(); process.exit(0); }
    if (args.showId)       { showHistoryEntry(args.showId);  process.exit(0); }
    if (args.jsonMode)     { console.log(JSON.stringify(loadHistory(), null, 2)); process.exit(0); }
    showHistoryTable(); process.exit(0);
  }

  if (args.command === "flaky") {
    let since: Date | undefined;
    if (args.since) {
      since = new Date(args.since);
      if (isNaN(since.getTime())) { console.error(c.red(`Invalid date: "${args.since}". Use ISO format, e.g. 2026-05-01`)); process.exit(1); }
    }
    const summaries = detectFlakyTests(loadHistory(), since);
    if (args.jsonMode) console.log(JSON.stringify(summaries, null, 2));
    else displayFlakyReport(summaries);
    process.exit(0);
  }

  if (args.version) { console.log(version); process.exit(0); }

  if (args.help) {
    console.log(`ci-why v${version} — explain CI build failures in plain English`);
    console.log("");
    console.log("First time? Run: ci-why setup");
    console.log("");
    console.log("Usage:");
    console.log("  cat build.log | ci-why                        # pipe a log through stdin");
    console.log("  ci-why ./build.log                            # analyze a log file");
    console.log("  ci-why --model ollama:llama3 ./build.log      # use a local Ollama model");
    console.log("  ci-why --model openai:gpt-4o ./build.log      # use OpenAI");
    console.log("  ci-why fix ./build.log                        # suggest a code patch");
    console.log("  ci-why fix --dry-run ./build.log              # show patch without applying");
    console.log("");
    console.log("Commands:");
    console.log("  ci-why setup                   Configure your AI provider and API key");
    console.log("  ci-why models                  List available models");
    console.log("  ci-why fix                     Analyse and suggest a code patch");
    console.log("  ci-why fix --dry-run           Show patch without applying it");
    console.log("  ci-why flaky                   Show flaky test report");
    console.log("  ci-why flaky --json            Output flaky report as JSON");
    console.log("  ci-why flaky --since <date>    Filter by date (e.g. 2026-05-01)");
    console.log("  ci-why history                 Show last 10 analyzed failures");
    console.log("  ci-why history --show <id>     Show full details of a past failure");
    console.log("  ci-why history --clear         Clear all history");
    console.log("  ci-why history --json          Dump full history as JSON");
    console.log("  ci-why notify setup            Configure Slack webhook");
    console.log("  ci-why notify test             Send a test Slack notification");
    console.log("  ci-why notify clear            Remove saved Slack webhook");
    console.log("");
    console.log("Options:");
    console.log("  --model <provider:model>   AI provider and model (default: anthropic:claude-haiku)");
    console.log("  --json                     Output results as JSON");
    console.log("  --format <fmt>             Log format: auto (default), jest, pytest, go, rust, maven");
    console.log("  --no-notify                Skip Slack notification for this run");
    console.log("  --dry-run                  Show patch without applying or saving");
    console.log("  --since <date>             Filter history by date (ISO format)");
    console.log("  --help,    -h              Show this help message");
    console.log("  --version, -v              Print the version number");
    console.log("");
    console.log("Environment:");
    console.log("  ANTHROPIC_API_KEY   For Anthropic models — get one at console.anthropic.com");
    console.log("  OPENAI_API_KEY      For OpenAI models   — get one at platform.openai.com");
    console.log("  SLACK_WEBHOOK_URL   Optional — set via: ci-why notify setup");
    console.log("  CI_WHY_MODEL        Default model — set by: ci-why setup");
    process.exit(0);
  }

  // Resolve model spec: --model flag > CI_WHY_MODEL env > default
  const modelStr  = args.model ?? process.env.CI_WHY_MODEL ?? DEFAULT_MODEL_SPEC;
  const modelSpec = parseModelSpec(modelStr);

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
    await fixCommand(chunkedLog, linesAnalyzed, resolvedFormat, args.dryRun, modelSpec);
  } else {
    await analyzeLog(chunkedLog, linesAnalyzed, args.jsonMode, resolvedFormat, args.noNotify, modelSpec);
  }
}

main().catch((err: Error) => {
  console.error(c.red(`Error: ${err.message}`));
  process.exit(1);
});
