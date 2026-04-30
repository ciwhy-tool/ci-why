#!/usr/bin/env node

// Load environment variables from a .env file (e.g. ANTHROPIC_API_KEY=...)
// dotenv.config() reads the .env file in the current working directory
import "dotenv/config";

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

// ─── Terminal colour helpers ───────────────────────────────────────────────
// These use standard ANSI escape codes supported by every modern terminal.
// \x1b[<code>m  = start colour    \x1b[0m = reset to default
const c = {
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ─── Step 1: Strip ANSI escape codes from the raw log ─────────────────────
// CI logs are often full of colour codes like "\x1b[32mOK\x1b[0m".
// This regex matches the standard ANSI CSI (Control Sequence Introducer)
// patterns and removes them so Claude only sees plain text.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

// ─── Step 2: Chunk the log down to the most useful parts ──────────────────
// Full CI logs can be megabytes long. We extract:
//   • Every line that mentions an error, failure, or exception (top context)
//   • The last 200 lines (where the build usually falls over)
// Duplicates are removed so we don't send the same line twice.
function chunkLog(text: string): string {
  const lines = text.split("\n");

  // Collect lines that look like errors/failures
  const errorPattern = /error|failed|exception|fatal|panic|traceback/i;
  const errorLines: string[] = [];
  for (const line of lines) {
    if (errorPattern.test(line)) {
      errorLines.push(line);
    }
  }

  // Take the last 200 lines
  const tail = lines.slice(-200);

  // Merge error lines + tail, keeping insertion order and removing dupes
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

// ─── Step 3: Read the log from a file path or stdin ───────────────────────
// Usage:
//   ci-why ./build.log          ← pass a file path as the first argument
//   cat build.log | ci-why      ← pipe the log through stdin
async function readInput(): Promise<string> {
  const args = process.argv.slice(2);

  if (args.length > 0 && !args[0].startsWith("-")) {
    // A file path was given — read it directly
    const filePath = path.resolve(args[0]);
    if (!fs.existsSync(filePath)) {
      console.error(`Error: file not found: ${filePath}`);
      process.exit(1);
    }
    return fs.readFileSync(filePath, "utf8");
  }

  // No file path — read from stdin (supports piping)
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ─── Step 4: Send the log to Claude and get an analysis ───────────────────
// We use the claude-haiku-4-5 model — it's fast and cheap, perfect for
// parsing build logs. The system prompt tells Claude exactly what format
// to respond in so we can reliably parse WHY / FAILING LINE / SUGGESTED FIX.
async function analyzeLog(log: string): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(c.red("Error: ANTHROPIC_API_KEY is not set."));
    console.error("Copy .env.example to .env and add your Anthropic API key.");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // The system prompt locks Claude into a structured format that we can parse.
  const systemPrompt = `You are a CI/CD build failure analyst. Given a build log, respond ONLY in this exact format — no extra commentary:

WHY: <one clear sentence explaining the root cause of the failure>
FAILING LINE: <the exact line, command, or file reference that caused it>
SUGGESTED FIX: <one actionable step the developer can take to fix it>`;

  process.stderr.write(c.dim("Analyzing build log…\n\n"));

  // Call the Anthropic Messages API
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

  // Extract the text content from the response
  // response.content is an array of content blocks; we only need text blocks.
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  displayResult(text);
}

// ─── Step 5: Pretty-print the result with colours ─────────────────────────
// Claude responds with three clearly-labelled sections.
// We parse each one with a regex and print it with colour.
function displayResult(text: string): void {
  // Each section starts with the label and runs until the next label or end
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

  // Fallback: if none of the sections parsed, just print the raw response
  if (!whyMatch && !failingMatch && !fixMatch) {
    console.log(text);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage:");
    console.log("  ci-why ./build.log        # analyze a log file");
    console.log("  cat build.log | ci-why    # pipe a log through stdin");
    process.exit(0);
  }

  const rawLog = await readInput();

  if (!rawLog.trim()) {
    console.error(c.red("Error: no log content provided."));
    console.error("Pass a file path or pipe a log via stdin.");
    process.exit(1);
  }

  // Clean and reduce the log before sending to Claude
  const cleanLog   = stripAnsi(rawLog);
  const chunkedLog = chunkLog(cleanLog);

  await analyzeLog(chunkedLog);
}

// Run and handle top-level errors
main().catch((err: Error) => {
  console.error(c.red(`Error: ${err.message}`));
  process.exit(1);
});
