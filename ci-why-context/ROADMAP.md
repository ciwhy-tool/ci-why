# Roadmap

## v0.1 — MVP (not started)
- [ ] Project scaffold (TypeScript, bin entry, package.json)
- [ ] stdin input mode
- [ ] File path input mode
- [ ] ANSI/noise stripping from logs
- [ ] Basic chunker (last 200 lines + error lines)
- [ ] Claude API call with structured prompt
- [ ] Coloured terminal output (WHY / FAILING LINE / SUGGESTED FIX)
- [ ] README with animated GIF demo
- [ ] Publish to npm

## v0.2 — polish (planned)
- [ ] Smart chunker (weight error lines, stack traces, log tail)
- [ ] Support for common CI providers output formats (GH Actions, CircleCI, GitLab)
- [ ] --model flag to let users choose Haiku/Sonnet/Opus
- [ ] --raw flag to output JSON instead of terminal colour
- [ ] Error handling for missing API key

## Backlog (unscoped)
- GitHub Actions native integration (run as a step)
- CircleCI / GitLab CI orb/component
- Web dashboard for team failure history
- Slack alert integration
