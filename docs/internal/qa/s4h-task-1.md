# QA Report — Sprint 4h Task 1: Per-machine profile

**Date:** 2026-11-08
**Reviewer:** QA Engineer
**Scope:** `studio/machine.js`, `studio/machine.example.json`, `engine/selftest-machine.js`, changes to `studio/power.js`, `studio/studio.js`, `creative/comfy.js`, `engine/engine.js`, `engine/test.js`, `.gitignore`

---

## Acceptance Criteria (from sprint-log.md Task 1)

| # | Criterion | Status |
|---|-----------|--------|
| AC1 | `studio/machine.js` loads `HOME/.studio/machine.json` (gitignored) deep-merged over defaults | ✅ PASS |
| AC2 | Missing file → defaults only | ✅ PASS |
| AC3 | Bad JSON → defaults + `[machine]` warning | ✅ PASS |
| AC4 | Non-object JSON (e.g. array) → defaults + warning | ✅ PASS |
| AC5 | Fields: `{ name, gitBash, ollama:{url,numParallel,keepAlive,contextLength}, comfyUrl, gpu:{vramGB,llmModel,llmSlots}, controlRoom:{port,bind} }` | ✅ PASS |
| AC6 | Ollama URL/port used in `studio/power.js` (unload) and `studio/studio.js` (probe URLs) | ✅ PASS |
| AC7 | ComfyUI URL used in `creative/comfy.js` | ✅ PASS |
| AC8 | `OLLAMA_NUM_PARALLEL`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_CONTEXT_LENGTH` used in `power.js` startup | ✅ PASS |
| AC9 | GPU `llmSlots`/`llmModel` ready for `engine/gpu.js` (branch not merged — noted in sprint-log) | ⚠️ N/A (documented) |
| AC10 | Git Bash path used in `engine/engine.js` (compatible with existing resolution order) | ✅ PASS |
| AC11 | Control Room port used in `studio/studio.js` and `studio/power.js` | ✅ PASS |
| AC12 | `studio/machine.example.json` with profiles `goldg-5090` (32GB, numParallel 4, llmSlots 3) and `bld-3090` (24GB, numParallel 2, llmSlots 2, contextLength 32768) | ✅ PASS |
| AC13 | Selftest `engine/selftest-machine.js` (temp HOME: defaults, override merge, bad JSON fallback + warning) | ✅ PASS |
| AC14 | `node engine/test.js` exits 0 | ✅ PASS |
| AC15 | Nested override keeps sibling defaults (e.g. override `numParallel` keeps default `url`, `keepAlive`) | ✅ PASS |
| AC16 | `DEFAULTS` not mutated by merge | ✅ PASS |
| AC17 | `ollamaUrl` strips trailing slashes | ✅ PASS |
| AC18 | `ollamaHost` strips protocol prefix for `OLLAMA_HOST` | ✅ PASS |

---

## Test Results

### Full Self-test Suite (`node engine/test.js`)

All 7 suites passed:
- selftest.js (parseRunOutput/verify): **55/55** ✓
- selftest-team-lead.js: **21/21** ✓
- selftest-foreach.js: 4/4 ✓
- selftest-mustchange.js: 8/8 ✓
- selftest-rework.js: 15/15 ✓
- selftest-stage-contracts.js: 23/23 ✓
- selftest-machine.js: **15/15** ✓

Exit code: **0**

### Syntax Checks (`node --check`)

All edited/new files pass syntax validation:
- `studio/machine.js` ✓
- `studio/power.js` ✓
- `studio/studio.js` ✓
- `engine/engine.js` ✓
- `creative/comfy.js` ✓

### Edge Case Probes

| Probe | Result |
|-------|--------|
| `ollamaHost` with http/https URLs, trailing slashes | ✅ Correct extraction |
| Zero value override (`numParallel: 0`) | ✅ Works (not treated as null) |
| Empty string override (`name: ''`) | ✅ Preserved |
| False boolean override | ✅ Works |
| `null` defaults (gpu fields) kept when not overridden | ✅ Correct |
| Partial nested override keeps sibling defaults | ✅ Verified |
| `DEFAULTS` immutability (no mutation by merge) | ✅ Confirmed |
| Non-object top-level JSON (`[1,2]`) → fallback + warning | ✅ Works |

### Code Review Findings

1. **`unloadOllama()` in `power.js`** calls `machine.load()` without passing `ctx.HOME`, using the default `studioHome()` resolution. This is acceptable because `unloadOllama()` is called from `shutdown()` which runs in the same process where HOME is the same. However, if `STUDIO_HOME` env is set differently at runtime vs. at module load, it could diverge. **Minor — not a blocker.**

2. **`comfyUrl` in `studio.js`** uses `.replace(/\/+$/, '')` inline while `comfy.js` uses `machine.ollamaUrl()` helper for Ollama but not for comfy. Slight inconsistency but functionally correct.

3. **`engine/gpu.js` does not exist on this branch** — the sprint-log explicitly documents this as "Not done". The `machine.load().gpu` API is ready for consumption when that branch merges.

---

## Bugs

**None found.**

---

VERDICT: PASS

All 18 acceptance criteria satisfied. All 7 test suites pass (141 total assertions). Syntax checks clean. Edge cases verified. The one omission (gpu.js wiring) is explicitly out-of-scope and documented.
