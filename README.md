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

## Auto-fix suggestions

`ci-why fix` does everything the normal analysis does, then reads the failing source file and asks Claude to produce a patch.

```bash
ci-why fix ./build.log
cat build.log | ci-why fix
```

Example output:

```
──────────────────────────────────────────────────
  SUGGESTED PATCH
  src/services/auth.ts  line 47
──────────────────────────────────────────────────
--- a/src/services/auth.ts
+++ b/src/services/auth.ts
@@ -45,3 +45,3 @@
 const payload = { userId: user.id };
-return { token: null, expiresIn: 0 };
+return { token: jwt.sign(payload, secret), expiresIn: 3600 };
──────────────────────────────────────────────────
Apply this patch? (y/n)
```

- **y** — applies the patch directly to the file
- **n** — saves a `ci-why-fix-<id>.patch` file you can apply manually

**Preview without applying:**

```bash
ci-why fix --dry-run ./build.log
```

> The patch is AI-generated and should always be reviewed before applying. Run your tests after applying to confirm the fix is correct.

---

## Flaky test detection

ci-why tracks every analysis in a local history file. Over time it can identify tests that fail repeatedly but for different reasons — a strong signal of a flaky test.

```bash
ci-why flaky
```

```
──────────────────────────────────────────────────
  FLAKY TEST REPORT
──────────────────────────────────────────────────
⚠  src/services/auth.test.ts:63
   Failed 4 times — 3 different failure reasons
   Last seen: 2026-05-11
   Confidence: HIGH

⚠  src/api/client.test.ts:112
   Failed 2 times — 2 different failure reasons
   Last seen: 2026-05-10
   Confidence: MEDIUM
──────────────────────────────────────────────────
2 flaky tests detected. Run ci-why history to see full details.
```

**Confidence levels:**

| Level | Meaning |
|---|---|
| `HIGH` | Same line failed 4+ times with different reasons |
| `MEDIUM` | Same line failed 2–3 times with different reasons |
| `LOW` | Same line failed repeatedly with the same reason — likely a real bug, not flaky |

**Filter by date:**

```bash
ci-why flaky --since 2026-05-01
```

**Machine-readable output:**

```bash
ci-why flaky --json
```

After every analysis, ci-why automatically warns you if any HIGH-confidence flaky tests are detected.

---

## Failure history

Every analysis is automatically saved to `~/.config/ci-why/history.json`.

**Show last 10 failures:**

```bash
ci-why history
```

```
  ID       DATE          FORMAT   WHY
  ──────────────────────────────────────────────────────────────────────────
  a3f9bc   May 11 14:22  jest     Missing peer dependency — react@^18 is req…
  d72e01   May 10 09:15  pytest   AssertionError: expected 200 but got 401
```

**Show full details of a past failure:**

```bash
ci-why history --show a3f9bc
```

**Dump full history as JSON:**

```bash
ci-why history --json
```

**Clear history:**

```bash
ci-why history --clear
```

**Flaky test detection:** If the same failing line appears 3 or more times in your history, ci-why will warn you:

```
⚠  This line has failed 4 times recently — this may be a flaky test.
```

---

## Slack notifications

After every analysis, ci-why can automatically post the result to a Slack channel.

**Setup:**

```bash
ci-why notify setup
```

**How to get a Slack webhook URL:**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**
2. Give it a name (e.g. "ci-why") and pick your workspace
3. In the left sidebar click **Incoming Webhooks** and toggle it on
4. Click **Add New Webhook to Workspace**, choose a channel, click **Allow**
5. Copy the webhook URL and paste it when prompted

**Test it:**

```bash
ci-why notify test
```

**Skip notification for a single run:**

```bash
ci-why --no-notify ./build.log
```

**Remove the webhook:**

```bash
ci-why notify clear
```

The Slack message includes the failure cause, failing line, suggested fix, detected log format, and timestamp.

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
    uses: ciwhy-tool/ci-why@v0.3.0
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
