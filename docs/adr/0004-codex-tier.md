# ADR 0004: Codex tier in the model ladder

**Status:** Proposed · **Date:** 2026-11-08 · **Owner:** studio owner

## Context

ADR 0001 established a five-level model ladder: local → local retry → Sonnet → blocked → owner. OpenAI's Codex (run through the owner's Pro plan, not pay-per-token) now offers a capable code-reasoning tier that can serve two purposes at the Pro plan's price point: (a) an intermediate escalation rung between local models and Sonnet for worker stages, and (b) an independent code-review voice at milestone gates alongside Opus.

The Pro plan includes fixed monthly usage limits for Codex. When Codex reports a rate-limit or usage-limit error, the attempt should fall through to Sonnet — not count as a failure — so that the Pro budget is used efficiently and tasks still complete.

**Data-residentiality note:** code sent to Codex is sent to OpenAI infrastructure. This is fine for public repos (the studio's default per ADR 0002). Private projects require explicit owner approval before Codex is used on their code.

## Decision

### Ladder change

The worker-stage escalation ladder becomes:

| Tier | Role | When |
|---|---|---|
| **L1 local** | `qwen3.6:27b` (Ollama) | first attempt |
| **L2 local retry** | same model, fresh prompt | first attempt failed its checks |
| **C1 Codex** | OpenAI Codex | local retry failed; Pro budget available |
| **C2 Sonnet** | Claude Sonnet | Codex failed **or** Codex budget exhausted |
| **blocked** | owner | Sonnet failed |

A Codex rate-limit or usage-limit response falls through to Sonnet **without** incrementing the failure counter — the task is not retried on Codex within the same run.

### Gate review: dual reviewers at milestones

Milestone-gate code reviews run **two independent reviewers in parallel**:

| Reviewer | Model | Verdict |
|---|---|---|
| Gate review A | Claude Opus | APPROVE / REJECT |
| Gate review B | Codex | APPROVE / REJECT |

**Both must not REJECT.** A milestone gate passes when neither reviewer REJECTS. That means:
- Opus APPROVE + Codex APPROVE → gate passes.
- Opus APPROVE + Codex no verdict (budget exhausted, fell through) → gate passes (Opus alone is sufficient).
- Opus REJECT + Codex APPROVE → gate **fails**.
- Opus APPROVE + Codex REJECT → gate **fails** (Codex's concerns must be addressed).

If Codex is unavailable (rate-limited, budget spent, or a private-repo project where Codex was not approved), only Opus reviews. The gate is not blocked by a missing Codex reviewer.

### Budget

Codex usage is bounded by the **Pro plan's monthly limits**. The engine tracks Codex tokens per run and per project in the usage events (`engine/engine.js`, `studio/studio.js`). When the Pro budget is exhausted for the month, all stages that would hit Codex go directly to Sonnet. This is logged as a budget event, not a failure.

### Privacy

- **Public repos:** Codex is used normally.
- **Private repos:** Codex is skipped unless the owner has explicitly approved it for that project (a flag in the project config or a per-PR label).

## Rules

1. **Codex failure ≠ task failure.** A `429` (rate limit), `403` (usage cap), or explicit budget-exhausted response from the Codex API falls through to Sonnet. The attempt counter is not incremented.
2. **Both gate reviewers must not REJECT.** A single REJECT from either Opus or Codex causes the gate to fail. Findings from both reviewers are merged and sent back to the engineer.
3. **Neither reviewer can be overruled by the other.** A REJECT from Opus fails the gate regardless of Codex; a REJECT from Codex fails the gate regardless of Opus.
4. **Missing Codex is not a blocker.** When Codex is budget-exhausted, rate-limited, or disallowed for a private project, Opus reviews alone. The gate is not escalated to blocked.
5. **Private-project guard.** Before any stage sends code to Codex, the engine checks project visibility and owner approval. Unauthorized Codex calls are refused and fall through to Sonnet.
6. **Usage tracking.** Each Codex call emits a usage event with `tier: "codex"`. The Control Room dashboard shows Codex token spend alongside existing Claude and local-model counters.

## Consequences

- The escalation ladder gains one rung, reducing Sonnet (and thus cost) for tasks Codex can handle.
- Milestone gates get a second independent code-review opinion, catching issues Opus might miss.
- Private projects add a small overhead: the engine must check visibility/approval before each Codex call.
- Codex usage needs monitoring; if the Pro budget is exhausted early, the remaining month runs on Sonnet for all escalations.
- `engine/engine.js` needs the Codex tier in the ladder logic, the budget check, and the parallel gate-review orchestrator.
- `studio/studio.js` and the Control Room UI need Codex in the usage breakdown.
- This ADR is linked from the Workflow Engine section of `CLAUDE.md` in the HQ repo.

## Next steps

1. Implement Codex tier in `engine/engine.js` ladder logic (internal sprint task).
2. Add parallel gate-review orchestrator (Opus + Codex).
3. Add Codex budget tracking and Pro-limit detection.
4. Add private-repo guard.
5. Update Control Room dashboard with Codex usage.
6. Pipeline integration test: one full lite-build run with Codex in the ladder.
