# Provider Comparison — 2026-11-11

> Bench: `node bench/bench.js run --providers codex,sonnet,qwen3.6:27b --roles coding`
> Run directory: `bench/results/2026-11-12-02-24` (local only; run dirs are in .gitignore)

## Results

| Provider | Pass Rate | Avg Wall Time | Avg tok/s | Avg Out Tokens | Avg In Tokens |
|---|---|---|---|---|---|
| Codex (OpenAI CLI) | 5/5 | 11.0s | 21 | 245 | 20,038 |
| Sonnet (Claude Code CLI) | 4/5 | 6.4s | 37 | 234 | 13,176 |
| Qwen3.6 27B (Ollama local) | 5/5 | 32.0s | 167 | 3,598 | 128 |

**Notes:**
- Single sample per eval (n=1); results may vary across runs.
- Codex (OpenAI CLI via `codex exec --json --sandbox read-only`) passed all 5 coding evals: month-totals, parse-duration, shift-pattern, streak-forgiving, water-goal.
- Sonnet (Claude Code CLI via `claude -p --model sonnet`) passed 4/5 evals: month-totals, shift-pattern, streak-forgiving, and water-goal passed; parse-duration failed (regex required hours prefix, did not handle bare "90s" format).
- Qwen3.6 27B (local Ollama) passed all 5 coding evals. Highest output token count due to verbose solutions with explanation text.
- **Token overhead:** In-token counts for Codex (~20k) and Sonnet (~13k) include the CLI system prompt and are not directly comparable with Ollama's raw in-token counts (~128) which only count the user message.

## Recommendation

The engine's ladder is `local → local → codex → sonnet`. Codex earns its rung: it matches Qwen3.6 27B's perfect 5/5 pass rate at 3× the speed (11.0s vs 32.0s) with 15× fewer output tokens, making it the ideal first escalation for coding roles (`backend-dev`, `frontend-dev`, `mobile-dev`). Sonnet is fastest (6.4s avg) and passed 4/5, but its parse-duration failure suggests it can miss edge cases Codex catches (single-sample caveat applies) — reserve Sonnet for the rung after Codex, which runs when Codex is unavailable, limited, or fails its stage checks. For the local-first tiers, Qwen3.6 27B remains the strongest free local option with 5/5 accuracy at the cost of higher latency.
