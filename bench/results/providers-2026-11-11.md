# Provider Comparison — 2026-11-11

> Bench: `node bench/bench.js run --provider codex --provider sonnet --provider qwen3.6:27b --roles coding`
> (singular `--provider` alias; each run invoked with `--providers codex,sonnet,qwen3.6:27b`)

## Results

| Provider | Pass Rate | Avg Wall Time | Avg tok/s | Out Tokens | In Tokens |
|---|---|---|---|---|---|
| Codex | 0/5 | 0.0s | 0 | 0 | 0 |
| Sonnet (Claude Code CLI) | 3/5 | 10.2s | 27 | 1,341 | 65,883 |
| Qwen3.6 27B (Ollama local) | 5/5 | 47.9s | 171 | 20,788 | 641 |

**Notes:**
- Codex binary is not installed on this machine, so all 5 evals failed immediately with "codex binary not found on PATH". These results reflect availability, not capability.
- Sonnet (via Claude Code CLI) ran 5/5 evals: month-totals, shift-pattern, and water-goal passed; parse-duration failed (did not handle bare "90s" format — regex required hours prefix); streak-forgiving failed (test assertion mismatch).
- Qwen3.6 27B passed all 5 coding evals. Token counts are high because the model generates verbose solutions with explanation text.

## Recommendation

For the engine's `codex` tier (ladder: codex → sonnet), the data shows Qwen3.6 27B as the strongest local model for coding stages (`backend-dev`, `frontend-dev`, `mobile-dev` roles) with a perfect 5/5 pass rate. While it is 4.7× slower than Sonnet (47.9s vs 10.2s average wall time), it runs entirely locally with zero cloud costs. Sonnet achieved 3/5 and is 5× faster (10.2s avg), making it the right escalation tier for time-sensitive stages like `qa-engineer` checks and `code-reviewer` passes where speed matters more than raw pass rate. Stages that can afford the extra time (`backend-dev` build, `frontend-dev` implementation) should start at the `codex` tier with Qwen3.6 27B as the local default, then escalate to Sonnet only on failure. Once Codex CLI is installed and signed in, it should be benchmarked again to validate its position between local and Sonnet in the ladder.
