# Code Review: Sprint 2, Lane B (GPU capacity)

**Reviewer:** Senior Code Reviewer / security lead
**Date:** 2026-11-08
**Branch / worktree:** `feat/s2-gpu` at `C:\Users\goldg\StudioLanes\s2-gpu`
**Scope:** all four Lane B tasks in `docs/internal/sprint2/lane-b-gpu.md`, the sprint-log entries "Sprint 2b Task 1/2/4", and QA reports `qa/s2b-task-1.md` through `qa/s2b-task-4.md`.
**Diff reviewed:** `git show HEAD` (fe53a8c) plus the uncommitted working-tree changes.

| File | Change |
|---|---|
| `engine/gpu.js` | new, 244 lines |
| `engine/selftest-gpu.js` | new, 272 lines |
| `engine/selftest-integration-gpu.js` | new, 105 lines |
| `engine/selftest-qaca-home-abs.js` | new, 160 lines (not part of Lane B) |
| `engine/engine.js` | +36 / -9 |
| `engine/test.js` | +2 |
| `bench/concurrency.js` | new, 237 lines |
| `studio/studio.js` | +6 / -2 |
| `studio/app/src/api.ts` | +1 |
| `studio/app/package.json`, `package-lock.json` | uncommitted: allowScripts added, jsdom tree removed from the lockfile |

**Verification note:** I could not run `node engine/test.js`, the dry run or the app build in this session because node commands needed approval. Test results below come from QA (120/120 engine assertions, app build passing, 149 app tests passing). Every finding below comes from reading the code.

---

## Blockers

### B1. A queued creative job loses its place in the queue every 2 minutes, so LLM work can starve it
`engine/gpu.js:51`, `engine/gpu.js:200-210`, `engine/engine.js:187`

`acquire('creative')` gives up after `CREATIVE_TIMEOUT_MS`, which defaults to 120 s, and deletes its pending file. `withGpu` treats `timed out` as retryable. It waits `GPU_RETRY_MS` (5 s) and then queues the job again with a new token and a new `since`. Local agent attempts often run longer than 2 minutes (`stage.timeoutMin` defaults to 30). So the creative request times out while LLM slots are still busy, and for about 5 s nothing is pending. Any LLM waiter that retries during that gap takes a slot. With 3 parallel agents this can repeat indefinitely. That breaks the spec rule that a creative job "blocks new llm acquisitions while queued", and the FIFO order between creative jobs is lost too.

**Fix:** let the caller set the creative wait time and keep the pending entry for the whole wait. For example:
- Add `acquire(kind, meta, { timeoutMs, onWait })`.
- In `withGpu`, pass the time left before `deadline` (`GPU_WAIT_MS`) as `timeoutMs`.
- Stop matching `timed out` in the retry regex.

Add an integration test: an LLM slot is held longer than the creative timeout, and a second LLM acquire made during the wait must still be refused.

### B2. The creative unload leaves the `local-fast` model in VRAM, and LLM slots can be held by two different models
`engine/gpu.js:169`, `engine/gpu.js:211`, `engine/engine.js:36-37`, `engine/engine.js:195`

`gpuKind` gives an `llm` slot to both `local` (`qwen3.6:27b`) and `local-fast` (`qwen3-coder:30b`). `gpu.js` records `cfg.llmModel` on every slot whatever model actually runs. On creative promotion it unloads only `cfg.llmModel`. After any `local-fast` attempt, `qwen3-coder:30b` (about 18 GB) stays resident while ComfyUI starts, so "exclusive" creative work can run out of VRAM. The spec says the LLM slots are "all on cfg.llmModel", but the 3 slots can be shared between two different 20–30B models at once.

**Fix:**
1. In `unloadOllama`, call `GET /api/ps` and send `keep_alive:0` for every loaded model, not just `cfg.llmModel`.
2. Either pass the real model in `meta` and store it on the slot (`model: meta.model || cfg.llmModel`), or route `local-fast` through a separate slot kind or limit. Record the choice in the design doc.

Add a test using the mock Ollama: two models listed by `/api/ps` should produce two unload POSTs.

---

## Should fix

### S1. No "waiting for GPU" event for the first 2 minutes of a creative wait
`engine/engine.js:184-188`, `engine/gpu.js:200-206`

For `creative`, `gpuAcquire` waits inside its own loop, and `withGpu` only emits the progress event after acquire throws, which is after 120 s. The spec says to emit `progress` "while waiting". The integration test only checks the event for an LLM wait (test 6), not for a creative wait (test 7).

**Fix:** use the `onWait` callback from B1, and call it the first time `tryPromote` returns false. Add an event check to test 7.

### S2. A GPU wait timeout crashes the engine and leaves the run marked `running`
`engine/engine.js:187`, `engine/engine.js:250`, and the CLI catch at the end of the file

After `GPU_WAIT_MS` the error propagates out of `advance()`. The process exits with code 1 and the run file still says `status: 'running'`. The Sprint 4h supervisor resumes `running` runs that have no live engine, so this becomes a crash-and-resume loop every 30 minutes. QA flagged this as finding 4 in `qa/s2b-task-2.md`, and it was not addressed.

**Fix:** in `advance`, catch GPU wait errors around both `withGpu` calls. Set `run.status = 'blocked'` and `run.blockedReason = 'GPU wait timed out (<kind>)'`, call `save(run)`, and return. Errors from `runAgent` itself should still propagate as they do now.

### S3. The Control Room event loop can block for up to 10 s, and the status-path comment is wrong
`engine/gpu.js:70-72`, `engine/gpu.js:75-91`, `engine/gpu.js:230-232`, `studio/studio.js:272`

`status()` takes the file lock. `withLock` waits by spin-sleeping with `Atomics.wait` for up to 10 s, which blocks the thread. `studio.js` calls `status()` from `computeGpu()` on the HTTP server thread, so lock contention from 3 or more agents plus a stress of acquires stalls every API request. The `.catch` only handles a thrown error, not a stall. Also, `status()` deletes stale files from the server process, while the comment at `gpu.js:93` says status runs without the lock.

**Fix:** add `statusReadOnly()`. It should call `readEntries()` with no lock, filter out dead pids with `isAlive` but not delete anything, and be what `studio.js` uses. Then correct the comment. Separately, consider an async `withLock` with `await sleep`.

### S4. Breaking a stale lock can delete a lock another process just took
`engine/gpu.js:82-83`

Process A and process B both see a stale lock. A runs `rmdir` and then `mkdir`, so it holds the lock. B then runs its own `rmdir` on A's new, live lock and runs `mkdir` itself. Now both are in the critical section, and the slot limit can be exceeded. This only happens after a holder crashes while holding the lock, so it is rare, but it defeats the purpose of the lock.

**Fix:** break the lock with an atomic rename to a unique name (`LOCK_DIR + '.stale-' + pid + '-' + rand`), followed by `rmdir` of the renamed directory. Only one process's rename can succeed. Alternatively, write an owner pid file inside the lock and break it only if that pid is dead.

### S5. The level-4 benchmark only ever has 3 requests in flight, so it can recommend 4 slots without testing them
`bench/concurrency.js:21`, `bench/concurrency.js:80-101`, `bench/concurrency.js:160`

Each level runs the same 3 evals, so `concurrency = 4` behaves exactly like 3. If level 3 qualifies, level 4 usually does too (within noise), so `recommended` comes out as 4 without 4 simultaneous requests ever being measured.

**Fix:** for each level, run `max(level, 3) * k` requests, cycling through the 3 evals (for example `k = 2`), so every level is fully loaded at least once.

### S6. The recommendation compares each level to level 1 instead of to the previous level
`bench/concurrency.js:177-186`, `bench/concurrency.js:211-215`

The spec asks for the "highest level where aggregate throughput *still rises* by at least 20%", which is the gain over the previous level. The code compares every level to level 1, so it would pick 4 even if 4 were slower than 3, as long as 4 is 20% above level 1.

**Fix:** loop over levels 2..4. Set `rec = c` while `r[c].aggregateTok >= r[c-1].aggregateTok * 1.2 && r[c].passRate >= basePass`, and stop at the first level that fails. Make the same change in the report's "Eligible" column.

### S7. The benchmark numbers are biased toward more slots
`bench/concurrency.js:75`, `bench/concurrency.js:159-163`

- **No warm-up.** The first level-1 request includes the model load time. That lowers the level-1 aggregate tok/s, which is the baseline, so every gain looks bigger.
- **Test time counts as generation time.** `checkEval` uses `spawnSync` (`node --test`, up to 60 s) on the event loop while other requests are still in flight. That delays dispatching the next request, and the test time is counted in `wallSecs`.

**Fix:** send one warm-up `chat()` call before level 1. Collect the outputs first and grade them after the batch, or use async `spawn`.

### S8. The dry-run model check matches any tag of the same model family
`bench/concurrency.js:121`

`m.name.includes(MODEL.split(':')[0])` accepts any `qwen3.6:*` tag, for example `qwen3.6:7b`. The QA dry-run PASS therefore does not prove that `qwen3.6:27b` is installed.

**Fix:** use an exact match (`m.name === MODEL || m.model === MODEL`). The dry run should also print the server's `OLLAMA_NUM_PARALLEL` (or warn that it is unknown). If it is below 4, levels 3 and 4 run one after another on the server and the measurement is meaningless.

### S9. Unrelated files in the lane diff
`engine/selftest-qaca-home-abs.js` (whole file); uncommitted `studio/app/package.json:23-26` and `studio/app/package-lock.json`

- `selftest-qaca-home-abs.js` is a QA script for the `{{home}}` change (#1). It is not registered in `engine/test.js`. Its assertions are regexes over `engine.js` source text, so they test spelling, not behaviour.
- The uncommitted lockfile change removes the whole `jsdom` tree, about 28 packages. The `package.json` change adds an `allowScripts` key, which npm does not read.

QA flagged both as "not this task" (`qa/s2b-task-4.md`, Notes).

**Fix:** delete `selftest-qaca-home-abs.js`, or turn it into a behaviour test and register it in a separate PR. Revert both `studio/app` package files with `git checkout`, unless someone owns the change. If so, regenerate the lockfile with `npm install` and commit it separately with a reason.

---

## Nits

- **N1** `engine/gpu.js:43-46`: `llmSlots` from `gpu.json` is not checked. A value of `0`, a negative number or `"3"` would make every LLM wait 30 minutes or misbehave. Clamp it to an integer of at least 1 (default 3), and check that `llmModel` is a string.
- **N2** `engine/engine.js:187`: retry decisions depend on matching error message text. Set `e.code = 'GPU_BUSY'` in `gpu.js` and test `e.code` instead.
- **N3** `engine/engine.js:184-189`: a 30-minute GPU wait ignores the pause switch. Check `paused(stage.agent)` in the retry loop and return `paused` the same way the loop at line 200 does.
- **N4** `engine/gpu.js:65-68`: liveness is checked by pid only. After a reboot or pid reuse a stale slot can look alive, and if the engine crashes while its `claude` child keeps running, the slot is reclaimed while the GPU is still busy. Store a process start time with the pid, or accept the risk and write it down.
- **N5** `engine/gpu.js:146-158`: `startPoll()` is exported but nothing calls it. Reclaim only happens on acquire and status calls. That satisfies "poll every 5 s" for waiters only. Either call `startPoll()` from `studio.js`, or drop it and update the header comment.
- **N6** `bench/concurrency.js:32`: `arg()` is never used (QA noted this). Remove it.
- **N7** `bench/concurrency.js:36-41`: `chat()` has no timeout and does not check `r.ok`. A hung request stalls the whole level. Add an `AbortSignal.timeout` and throw on a non-OK response.
- **N8** `bench/concurrency.js:54`: the temp directories from `mkdtempSync` are never removed. Remove each one with `fs.rmSync` after the test run.
- **N9** `bench/concurrency.js:53-60` (security, low): this runs model-generated code with full user privileges. That matches the existing `bench.js`, and it is local only. Add a comment, and never point `OLLAMA_URL` at an untrusted server.
- **N10** `bench/concurrency.js:231-232`: the usage text says `--dry-run` runs "without contacting the model", but it does query Ollama `/api/tags`. Reword it.

---

## Security summary
- No injection risk found. `release()` checks tokens against `TOKEN_RE`, so path traversal is blocked (QA probed this). Tokens are generated by the code, and `meta` is only serialised with JSON.
- No secrets in the code. HTTP calls go only to `127.0.0.1`. The script runner's `shell: true` was already there and is not new in this lane.
- No new dependencies: `gpu.js` uses Node built-ins only, as the spec requires. The uncommitted lockfile change (S9) is the only dependency risk.

## Test coverage
- The scheduler tests (48 checks) are strong. They use real child processes, cover FIFO order and reclaim, and stress the slot limit.
- The wiring tests (17 checks) cover attempts, the tier ladder, release on throw and cloud bypass.
- **Gaps:** creative wait longer than its timeout (B1), multi-model unload (B2), the creative waiting event (S1), the GPU wait timeout setting the run to `blocked` (S2), and studio.js with `gpu.js` missing (QA checked this by reading only). `bench/concurrency.js` has no tests for `runBatch` or the recommendation logic. Make the recommendation a pure function and unit-test it.

## Contract and layout
File locations and the `status()` shape match the lane spec, and `Gpu.slots?` in `api.ts` matches `status()`. Two deviations: `local-fast` uses a model other than `llmModel` (B2), and the recommendation rule differs from the spec wording (S6).

---

**REQUEST CHANGES**. Fix B1 and B2 (creative starvation and incomplete VRAM unload) before merge. Fix S2, S3, S5, S6 and S9 in the same rework round. The rest can go to the backlog.
