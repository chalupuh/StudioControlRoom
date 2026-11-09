## Sprint 3g Task 1

**ADR 0004: Codex tier in the model ladder.**

**Changed:**
- `docs/adr/0004-codex-tier.md` (new): the ladder is now local → local retry → Codex → Sonnet → blocked. Codex also runs a second, independent code review at milestone gates next to Opus — both must not REJECT. Budget = Pro plan's usage limits; a Codex rate or usage limit falls through to Sonnet without counting as a failure. Code sent to Codex goes to OpenAI (fine for public repos; private apps need an owner OK). Linked from the Workflow Engine section of HQ `CLAUDE.md`.
- HQ `CLAUDE.md` (`C:\Users\goldg\AI Development Company`): Workflow Engine section updated — ladder text now includes Codex, gate-review text notes the parallel Codex reviewer, both linked to `docs/adr/0004-codex-tier.md`.
- HQ `docs/internal/sprint-log.md`: matching "Sprint 3g Task 1" entry.

**Verified:**
- Read existing ADRs (0001, 0002, 0005) to match style — structure, tone, and table formatting align.
- Confirmed the Workflow Engine section of HQ `CLAUDE.md` links `docs/adr/0004-codex-tier.md` and the ladder/gate text matches the ADR.
- `npm --prefix studio/app run build` passes (tsc --noEmit + vite build; 47 modules, 0 errors).
- Read full `CLAUDE.md` post-edit to confirm the paragraph flows correctly and the link path is valid.


## Sprint 3g Task 2
**Changed:**
- `engine/engine.js`: the `codex` tier runs `codex exec --json --sandbox workspace-write --skip-git-repo-check -` in the stage workdir. The prompt is the role's instructions from HQ `.codex/agents/<role>.toml` plus the stage task. `parseCodexOutput` returns `{result, error, usage, turns}`. Rate and usage limits set `limited: true`. A missing `codex` binary sets `skipped: true` and emits a 'progress' warning. `advance` skips limited or skipped tiers without counting a failure. `findCodex` searches PATH. `parseSimpleTOML` now reads multi-line `"""` strings.
- `engine/selftest-codex.js` (new, registered in `engine/test.js`): fake `codex` on PATH; success, failure, limited, missing, ladder fall-through.
- `engine/selftest-rework.js`: expected tier order is now `local,local,codex,sonnet`.

**Verified:** `node engine/test.js` — all suites pass (16 new codex checks). I did not run the real `codex` CLI, so the JSONL event names are unconfirmed.

## Sprint 3g Task 3

**Metrics split by provider.**

**Changed:**
- `engine/engine.js`: usage events carry `provider` (ollama | anthropic | openai) via `providerOf(tier)`; a rate-limited Codex attempt emits a usage event with `limited: true`.
- `studio/studio.js`: `/api/usage` adds `byProvider` (runs, tokens, attempts, limited). Older events without `provider` are inferred from tier/cloud.
- `studio/app/src/api.ts`: `Usage.byProvider`, `Provider`/`ProviderUsage` types, `provider`/`limited` on `StudioEvent`.
- `studio/app/src/features/ops/format.ts`: `providerRows` helper. `OpsPanel.tsx`: card renamed "Model usage", new "By provider" table.
- `format.test.ts`: tests for `providerRows`.

**Verified:** `npm --prefix studio/app run build` passes; vitest 151/151 pass; `node engine/test.js` passes; `node --check` on engine.js and studio.js.

## Sprint 3g Task 4 (rework round 1)

**Rework:** QA found `tools/ci/check-config.js` missing and generated HQ files not produced or committed. Fixed both.

**Changed:**
- `tools/sync-codex-agents.js` (unchanged from previous round — already worked correctly). Reads `.claude/agents/*.md` + `CLAUDE.md`, generates `.codex/agents/*.toml` + `AGENTS.md`. UTF-8 with BOM strip and CRLF→LF normalisation so box-drawing characters survive. Flags: `--write`, `--check`, `--dry-run`, `--home`.
- `tools/ci/check-config.js` (new): thin CI gate wrapper around `sync-codex-agents.js --check`. Exits 0 when all generated files match source, exits 1 on drift, exits 2 on tooling error (missing script/source dir). Passes `--home` through.
- HQ `.codex/agents/test-box-drawing.toml` (new, generated): the sync was missing this agent's TOML (17th agent added since first round). `--write` produced it.
- HQ `.codex/manifest.json` (updated): now lists all 17 agents including `test-box-drawing`.
- HQ `AGENTS.md` (regenerated): was already in sync, rewritten identically.

**Committed:** `7d09504` — `tools/sync-codex-agents.js` + `tools/ci/check-config.js` in this repo (s3-codex). HQ generated files written to disk (`.codex/agents/test-box-drawing.toml`, `.codex/manifest.json`).

**Verified (actual command output):**

```
$ node tools/ci/check-config.js --home "C:\Users\goldg\AI Development Company"
HQ root: C:\Users\goldg\AI Development Company
Agent count: 17
  = architect  (ok)
  = backend-dev  (ok)
  = code-reviewer  (ok)
  = copy-voice  (ok)
  = creative-director  (ok)
  = devops-engineer  (ok)
  = frontend-dev  (ok)
  = image-artist  (ok)
  = market-researcher  (ok)
  = mobile-dev  (ok)
  = opportunity-analyst  (ok)
  = product-manager  (ok)
  = qa-engineer  (ok)
  = rd-manager  (ok)
  = test-box-drawing  (ok)
  = ui-ux-designer  (ok)
  = video-producer  (ok)
  = AGENTS.md  (ok)
EXIT: 0
```

```
$ node --check tools/sync-codex-agents.js && node --check tools/ci/check-config.js
OK: sync-codex-agents.js
OK: check-config.js
```

Box-drawing verification (`test-box-drawing.toml`): 64 box-drawing characters found, including ┌─┐│└┘.
Manifest lists all 17 agents including `test-box-drawing`.
```
