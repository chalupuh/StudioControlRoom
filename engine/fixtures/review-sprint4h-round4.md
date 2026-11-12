# Code Review: Sprint 4, Lane H (Always-on host), whole sprint, round 4

- **Branch:** `feat/s4-host` (StudioControlRoom worktree `C:\Users\goldg\StudioLanes\s4-host`). HEAD is `9a7063c` and the working tree is clean. **No commits have landed since the round-3 review** (`review-sprint4h-round3.md`). Diff `main..
- **Spec:** `docs/internal/sprint4/lane-h-host.md`. All three tasks are still unchecked.
- **Inputs:** `docs/internal/sprint-log.md` (Sprint 4h entries, the latest being "Task 3 (rework round 2)" for `9a7063c`); `docs/internal/qa/s4h-task-1.md`, `s4h-task-2.md`, `s4h-task-3.md`, `s4h-task-3-round1.md`, `s4h-task-3-round2.md`; r
- **Files read:** `studio/{supervisor.js, backup.js, machine.js, install-service.ps1, power.js, studio.js}`, `engine/{engine.js, test.js, selftest-supervisor.js}`, `creative/comfy.js`, `.gitignore`, `studio/app/package.json`.
- **Reviewer:** Code Reviewer, 2026-11-11.

**What I ran:**
- `node engine/test.js`: "All self-tests passed".
- `node -e "require('./studio/machine').load({HOME:'x',DIR:'y'})"` throws `The "path" argument must be of type string`, so S1 is still present.
- `git log HEAD..main`: `main` is now **5** commits ahead (#9, #10, #11, #12, #14). It was 4 in round 3.

**What I could not run:** executing `install-service.ps1`, including `-WhatIf` and the parse check. Registering a real Scheduled Task is out of scope for a reviewer, and earlier sessions refused even the parse-only check.

## Summary

Nothing has changed since round 3. I re-checked every round-3 finding against the current source, and all of them still apply. The line numbers below are confirmed against HEAD `9a7063c`.

This round adds one new should-fix, **S10**: engines that the supervisor resumes write their stdout/stderr through pipes owned by the supervisor. Whenever the supervisor restarts, every engine it resumed loses its log, and may crash with EP

---

## Blocker

### B1. The boot install has never been executed (open since round 2)
- **Where:** `studio/install-service.ps1:54-128`; `qa/s4h-task-3.md` AC1-AC7 and Limitation 1 ("code-only").
- **Problem:** every installer criterion is marked PASS from reading the code alone. Each earlier installer defect (cmd quoting, a nonexistent parameter, the SYSTEM principal, an em-dash parse failure) would only have been caught by running
- **Fix:** on the **5090 host only** (this lane must not touch BLD), run these steps and paste the real output into a QA report:
  1. Parse check: `[Management.Automation.Language.Parser]::ParseFile(...)` must report 0 errors.
  2. `-WhatIf -StudioHome <HQ>`: the Action line must show `node.exe "...\studio\studio.js" supervise --home "<HQ>"`.
  3. Install from an elevated shell: the Principal must show `S4U` and `Highest`, and `RestartCount` must be 999.
  4. `Start-ScheduledTask StudioSupervisor`: `supervisor.log` must show `supervisor started`.
  5. Kill the node pid: a new `supervisor started` line must appear within 2 minutes. If it doesn't, add a 5-minute repeating trigger with `-MultipleInstances IgnoreNew`.
  6. `-Uninstall`: the task must be gone.

  If any step can't be run, mark it UNVERIFIED and leave Task 3 unticked.

---

## Should fix

### S1. The concurrency cap never reads `machine.json` (still open)
- **Where:** `studio/supervisor.js:163`.
- **Problem:** `require('./machine').load({ HOME, DIR })` passes an object where `machine.load(home)` expects a string path. The call throws, the `catch` returns `{}`, and `maxEngines` is always 2, so the 5090's `llmSlots: 3` is ignored. I 
- **Fix:** use `const MACHINE = deps.MACHINE || require('./machine').load(HOME);` and drop the swallowing `try`. Add a selftest that writes `{"gpu":{"llmSlots":1}}` to the temp HOME's `machine.json`, calls `tick` without `deps.MACHINE`, and

### S2. The crash-loop guard blocks healthy runs after the owner pauses and resumes (still open)
- **Where:** `studio/supervisor.js:97-101`, `:199-213`, `:218`.
- **Problem:** every resume is counted against the same `cursor`, whatever stopped the engine. Three Paused/Running flips, Game-mode cycles or reboots within an hour on a long stage set the run to `status='blocked'` even though nothing cras
- **Fix:** do either or both of these:
  - Count a resume as a crash only when the engine lived less than about 5 minutes. Record `{time, cursor, pid}`, and work out the lifetime when that pid is next found dead.
  - Clear `locks/*.resumes.json` on any tick where `control.state !== 'running'`.

  Add a test: three resumes separated by a Paused tick must not block the run.

### S3. Lock liveness trusts bare PIDs; `enginePid()` is dead code (still open)
- **Where:** `studio/supervisor.js:43-47` (`enginePid` is never called), `:13` (the header claims the PID command line is verified), `:71`, `:244`; `studio/studio.js:432-434`; the `server.pid` check in `studio/power.js`.
- **Problem:** locks are never removed when an engine exits. Once Windows reuses that PID for an unrelated process, the run is reported "locked by a live process" on every tick, forever. The same applies to `server.pid`, so the Control Room
- **Fix:**
  - Default `isAlive` in `tick` to `(pid) => enginePid(pid, studioProcs)`.
  - Delete the lock in `child.on('exit')`.
  - Probe the server over HTTP (`/api/state`, 2 s timeout) instead of using `process.kill(pid, 0)`.
  - Add a test: a lock holding the test's own `process.pid` (alive, but not an engine) gets replaced.

### S4. The dashboard resume can still start two engines on one run (still open)
- **Where:** `studio/studio.js:426-441`, `:351-359`.
- **Problem:** the route only reads the lock. It never takes the lock or writes the child pid, so two quick clicks, or a click on a run the dashboard itself started, spawn two engines. That breaks the spec's "never two". It is also a third 
- **Fix:** export `takeLock` and an `engineAlive(runId, procs)` helper from `supervisor.js`. In the route, reply 409 if the engine is alive or the lock is held. Otherwise take the lock, spawn, and write `child.pid` into the lock (`spawnEngi

### S5. Backup silently drops sources that fail to copy (still open)
- **Where:** `studio/backup.js:135`, `:140`, `:144` (empty `catch {}`); `:147`.
- **Problem:** an EBUSY or EPERM error partway through `runs/` or `docs/internal` still yields `backup done`, and the day is marked complete. The `sources:` line lists the paths that were found, not the ones actually copied.
- **Fix:** collect the copy errors and retry each failed item once. If an item still fails, reject so the hourly retry runs, or write `MISSING.txt` into the archive and log `backup partial: <items>`. Add a test with a stubbed `cpSync` that 

### S6. Backup tests don't cover the S6-S8 claims (still open)
- **Where:** `engine/selftest-backup.js:57`, `:93`.
- **Problem:** the suffix-regex path checks would also pass on the old, unrestorable layout. Nothing tests `.partial` cleanup or staging cleanup after a failure.
- **Fix:** assert the exact entries `.studio/runs/test-run.json` and `docs/internal/<file>`. Make the zipper injectable (`opts.zip`) and have it write bytes and then reject. Assert that no `.partial` file, no `<date>.zip` and no new `os.tmp

### S7. Task 1 is incomplete: `engine/gpu.js` does not exist (still open)
- **Where:** the spec's Task 1 ("engine/gpu.js reads machine.json `gpu` before gpu.json").
- **Problem:** `gpu.llmModel` is unused, and `gpu.llmSlots` is used only by the broken cap (S1).
- **Fix:** leave Task 1 unticked and open a follow-up task that depends on the GPU-scheduler branch. Note the dependency in the lane file.

### S8. Branch hygiene: rebase, committed QA file, unrelated app changes (still open, and the branch is drifting further)
- **Where:**
  - The branch is 5 commits behind `main`. #11 (`localTierEnv`) and #14 (resume path) touch the same `engine.js` areas this branch edits (`engine/engine.js:30-31`, `:136`).
  - `docs/internal/qa/s4h-task-1.md` is tracked in StudioControlRoom.
  - `studio/app/package-lock.json` has 355 lines deleted, and `studio/app/package.json:23-25` adds `allowScripts`.
  - The WIP commits `991ffb7` and `10d99ba` are still on the branch.
- **Problem:**
  - The rebase conflicts grow with every merge to `main`. #14 changes how resume works, and the supervisor depends on resume behaviour, so it has to be retested after the rebase.
  - Deleting the lock file changes which dependency versions get installed, and that change is unrelated to this lane (a supply-chain review concern).
- **Fix:**
  - Rebase onto `main`, keeping `machineLib.ollamaUrl(MACHINE)` inside `localTierEnv`, then rerun `node engine/test.js`.
  - Run `git rm --cached docs/internal/qa/s4h-task-1.md`.
  - Restore `studio/app/package*.json` from `main` and move them to a separate `chore(app)` PR.
  - Squash on merge with a conventional message (ADR 0002).

