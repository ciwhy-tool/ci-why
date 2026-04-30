# ci-why

`ci-why` reads a CI build log and tells you exactly why it failed — in plain English.

Instead of scrolling through hundreds of lines of output, pipe your log into `ci-why` and get a three-line diagnosis: the root cause, the exact failing line, and a suggested fix.

---

## Installation

```bash
npm install -g ci-why
```

## Setup

```bash
ci-why setup
```

This walks you through getting a free Anthropic API key and saves it automatically.

Or set it manually:

```bash
export ANTHROPIC_API_KEY=your-key-here
```

---

## Usage

**Analyze a log file:**

```bash
ci-why ./build.log
```

**Pipe from stdin:**

```bash
cat build.log | ci-why
```

**Works great with GitHub Actions, CircleCI, and other CI tools:**

```bash
gh run view --log-failed | ci-why
```

---

## Example output

```
──────────────────────────────────────────────────
  WHY
  Missing peer dependency — react@^18 is required by @mui/material
  but is not installed in the project.

  FAILING LINE
  npm ERR! peer react@"^18" from @mui/material@5.15.0

  SUGGESTED FIX
  Run `npm install react@18` to satisfy the peer dependency,
  then retry the build.
──────────────────────────────────────────────────
```

---

## JSON output

Add `--json` to get machine-readable output — useful for piping into other tools or scripts:

```bash
ci-why --json ./build.log
```

```json
{
  "why": "The auth service returns null for the token field instead of a valid token string",
  "failingLine": "src/services/auth.test.ts:63 — expect(result.token.substring(0, 3)).toBe('abc')",
  "suggestedFix": "Check authService.login() to ensure it returns a valid token from the API response",
  "linesAnalyzed": 312,
  "model": "claude-haiku-4-5-20251001"
}
```

---

## Supported log formats

`ci-why` auto-detects the log format and prioritises the most relevant lines before sending to Claude. You can also specify a format manually with `--format`.

| Format | Auto-detected from | Example |
|---|---|---|
| `jest` (default) | Jest/Node output | `cat jest.log \| ci-why` |
| `pytest` | `FAILED`, `AssertionError`, traceback blocks | `ci-why --format pytest ./pytest.log` |
| `go` | `--- FAIL:`, `panic:` | `go test ./... 2>&1 \| ci-why` |
| `rust` | `error[E0xxx]`, `thread 'main' panicked` | `cargo test 2>&1 \| ci-why` |
| `maven` | `BUILD FAILURE`, `[ERROR]`, `[FATAL]` | `ci-why --format maven ./maven.log` |

---

## GitHub Actions integration

Add `ci-why` to any existing workflow to automatically post a plain-English explanation of build failures as a PR comment.

```yaml
steps:
  - uses: actions/checkout@v4

  - name: Build and test
    id: build
    continue-on-error: true
    shell: bash
    run: |
      set -o pipefail
      { npm ci && npm run build && npm test; } 2>&1 | tee /tmp/build.log

  - name: Explain failure with ci-why
    if: steps.build.outcome == 'failure'
    uses: ciwhy-tool/ci-why@v0.2.0
    with:
      log-file: /tmp/build.log
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      github-token: ${{ secrets.GITHUB_TOKEN }}
      pr-number: ${{ github.event.pull_request.number }}

  - name: Fail the job
    if: steps.build.outcome == 'failure'
    run: exit 1
```

**Required secrets:**

| Secret | How to set it |
|---|---|
| `ANTHROPIC_API_KEY` | Add in your repo → Settings → Secrets and variables → Actions |
| `GITHUB_TOKEN` | Provided automatically by GitHub — no setup needed |

---

## Requirements

- Node.js >= 18
- An [Anthropic API key](https://console.anthropic.com/)

## License

ISC
