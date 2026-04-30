# Decisions log

## Why BYOK instead of proxying the API
Decided: planning phase
Reason: Zero API cost risk. No infrastructure to run. Developers are comfortable with API keys. Allows full focus on the product quality. Can always add a proxy tier later once there's demand.

## Why Haiku as default model
Decided: planning phase
Reason: Log parsing is pattern extraction, not complex reasoning. Haiku is 3x cheaper than Sonnet and fast enough for a CLI. Users can override with --model flag in v0.2.

## Why free + open source at launch
Decided: planning phase
Reason: Fastest path to traction. Developer tools live or die by word of mouth. Paid gates would slow adoption before we understand the real use cases. Monetisation note in README sets expectations without blocking growth.

## Why Node.js / TypeScript
Decided: planning phase
Reason: npm is the natural distribution channel. npx install is zero friction. TS gives us safety without a compile step for users.
