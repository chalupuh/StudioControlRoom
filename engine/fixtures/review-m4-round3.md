# Code Review: Milestone 4 (Trial end and one-time unlock), re-check after rework round 2

**Project:** family-chore-board (HiveBoard) · **Reviewer:** code-reviewer · **Date:** 2026-11-12
**Scope:** `git diff ecb3949..d78b84e` ("Rework M4 review nit fixes (round 2)"). Changed files: `app/parent/full-access.tsx`, `app/parent/settings.tsx`, `src/iap/entitlement.ts`. The working tree is clean.
**Prior report:** `family-chore-board.review-m4-round2.md`
**Against:** design.md §2 (access, parental gate), §3 (entitlement contract), §4 (layout), M4 task 7.

## Checks I ran

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass (no output) |
| `npx eslint .` | 0 errors, the same 2 warnings as before (kid routes, exhaustive-deps) |
| `npx jest` | 27 suites / 350 tests pass |
| `src/ui/tokens.ts:31` | `space.s2 = 8`, so the token swap does not change the layout |

## Status of the requested IDs (N-9 to N-12)

| ID | Status | Evidence |
|---|---|---|
| N-9 | **FIXED** | `app/parent/full-access.tsx:2`: `import { StyleSheet, useWindowDimensions, View } from 'react-native';`. The second `react-native` import is removed. |
| N-10 | **FIXED** | `app/parent/settings.tsx:52-62`: `wasPremium` is read before `restoreIap(db)`, and `play('purchase_success')` runs only when `ok && !wasPremium`. `restore()` returns true from the cache only when `isPremium === 1` is al
| N-11 | **FIXED** | `app/parent/settings.tsx:12,189-192`: `space` is imported, and `gap` and `marginTop` now use `space.s2` instead of literal `8`. |
| N-12 | **FIXED** | `src/iap/entitlement.ts:7`: the finding offered two options, and the rework took the second one. It kept the fallback and added the comment "Fallback must match `extra.iapProductId` in app.config.ts — keep in sync." |

All four requested IDs are fixed. None is STILL FAILING.

## New findings in this rework

### Nits
- **N-13** `app/parent/settings.tsx:52-66`: `wasPremium` comes from the `current` state, which is loaded once on mount. After a restore succeeds, `current` is never refreshed. So if the device is offline and the user taps Restore a second t

## Earlier findings outside this round's ID list

The rework touched only the nits. I checked the code again, and the round-1 blockers and should-fix items are still present. The owner has not recorded any of them as deferred or accepted (`qa-m4.md:63` says they "remain open").

| ID | Status | Evidence |
|---|---|---|
| B-1 | **STILL FAILING** | `src/db/DbProvider.tsx:43` still calls `restoreIap(db)` on every launch, and `restore()` still calls `IAP.restorePurchases()` (`entitlement.ts:79`). On iOS this can show an Apple ID sheet on the kids' board, with
| B-2 | **STILL FAILING** | `entitlement.ts:57-63`: the listener still finishes the transaction and grants premium without checking `purchaseState`. There is still no persistent listener for late or deferred purchases and no `purchase()` ti
| S-1 | STILL FAILING | `src/domain/gate.ts` does not exist. |
| S-2 | STILL FAILING | `PinGateModal.tsx` was not changed. |
| S-3 | STILL FAILING | `jest.setup.ts:5` still has `process.on('unhandledRejection', () => {})`. |
| S-5 | STILL FAILING | `entitlement.ts` still matches cancellations with a regex. |
| S-6 | STILL FAILING | No new tests in this round. |
| S-7 | STILL FAILING | `package.json:32` is still `"expo-iap": "^6.0.0"`, with no config plugin. |

## Security notes
- No new inputs, endpoints, secrets or dependencies were added in this round.
- B-1 is still the main child-safety issue: a store UI that can appear with no parental gate. B-2 is still a revenue and correctness issue: pending or Ask to Buy purchases unlock premium, and Google Play refunds purchases that are never ack

## Verdict
N-9, N-10, N-11 and N-12 are all **FIXED**. N-13 is a new nit. The milestone still cannot be approved, because blockers B-1 and B-2 (and S-1 to S-3, S-5 to S-7) from round 1 are unchanged in the code. Next round must fix B-1 and B-2, with t

VERDICT: FAIL

REQUEST CHANGES

