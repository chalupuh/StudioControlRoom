## Sprint 3g Task 1

**ADR 0004: Codex tier in the model ladder.**

**Changed:**
- `docs/adr/0004-codex-tier.md`: the ladder is now local → local retry → Codex → Sonnet → blocked. Codex also runs a second, independent review at milestone gates next to Opus, and both must not REJECT. The budget is the Pro plan's usage limits. A Codex rate or usage limit falls through to Sonnet without counting as a failure. Code sent to Codex goes to OpenAI, which is fine for public repos; private apps need an owner OK. This round I reworded the Pro-plan line (not pay-per-token API) and removed a contradiction in the "final authority" rule: neither reviewer can overrule the other.
- HQ `CLAUDE.md` (`C:\Users\goldg\AI Development Company`): the Workflow Engine section already carries the new ladder and the Codex gate reviewer, and links `docs/adr/0004-codex-tier.md` (no further edit needed).
- HQ `docs/internal/sprint-log.md`: has the matching "Sprint 3g Task 1" entry.

**Verified:** Read the ADR and the Workflow Engine section of HQ `CLAUDE.md` after editing. The ladder text, gate rule and link path match the ADR. Not run: no code changed, so there are no tests.
