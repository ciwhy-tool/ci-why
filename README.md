# ci-why

`ci-why` reads a CI build log and tells you exactly why it failed — in plain English.

Instead of scrolling through hundreds of lines of output, pipe your log into `ci-why` and get a three-line diagnosis: the root cause, the exact failing line, and a suggested fix.

---

## Installation

```bash
npm install -g ci-why
```

## Setup

`ci-why` uses the [Anthropic API](https://console.anthropic.com/) to analyze logs. Set your API key:

```bash
export ANTHROPIC_API_KEY=your-key-here
```

To make this permanent, add it to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.).

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

When a PR build fails, ci-why posts a comment like this:

> **ci-why: build failure analysis**
> ```
> ──────────────────────────────────────────────────
>   WHY
>   ...
> ```

---

## Requirements

- Node.js >= 18
- An [Anthropic API key](https://console.anthropic.com/)

## License

ISC
