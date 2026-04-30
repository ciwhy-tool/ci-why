# ci-why — project context

## What it is
A CLI tool that reads a failed CI build log and explains in plain English why it failed, which line caused it, and how to fix it. Powered by the Anthropic Claude API.

## Core value proposition
Developers waste time reading 400+ line CI logs to find one root cause. ci-why extracts the signal and explains it in 3 lines.

## Usage
```bash
cat build.log | ci-why
ci-why ./logs/build.log
```

## Business model
- Free and open source (MIT)
- BYOK — user provides their own Anthropic API key via ANTHROPIC_API_KEY env var
- Note in README: "A paid cloud tier with team features is planned for the future"
- No monetisation pressure at launch — focus entirely on adoption

## Tech stack decisions
- Node.js CLI (npx-friendly, no install friction)
- TypeScript
- Claude Haiku 4.5 as default model (cheapest, fast, sufficient for log parsing)
- Prompt caching on system prompt to cut costs
- stdin + file path as input modes (CI provider API = future)

## Output format
Four sections: WHY · FAILING LINE · DIFF (if present) · SUGGESTED FIX
Coloured terminal output using chalk or similar.

## Status
Planning phase — no code written yet.
