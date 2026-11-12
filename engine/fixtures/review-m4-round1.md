# Code Review: Milestone 4 (Trial end and one-time unlock)

**Project:** family-chore-board (HiveBoard) · **Reviewer:** code-reviewer · **Date:** 2026-11-12
**Scope:** uncommitted working tree on `build/m1` vs `HEAD` (346bf09): `app/parent/full-access.tsx`, `app/parent/settings.tsx`, `app/parent/index.tsx`, `src/db/DbProvider.tsx`, `jest.setup.ts`, `package.json`/lock (+ `expo-iap`), new `src/i
**Against:** design.md §2 (access, parental gate), §3 (entitlement contract), §4 (layout), M4 task 7; qa-m4.md.

## Checks I ran

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx eslint .` | 0 errors, 2 warnings that were already there (kid routes, exhaustive-deps) |
| `npx jest` | 27 suites / 350 tests pass |
| `node scripts/check-deps.js` | OK |
| Read `node_modules/expo-iap` 6.4.3 source | `restorePurchases()` calls native restore / `syncIOS()` (StoreKit `AppStore.sync()`); `Purchase.purchaseState` is `'pending' or 'purchased' or 'unknown'` |

Access limits (cap of 8, oldest member regardless of type plus 3 oldest chores, trial clock) landed in M2/M3 and are unchanged here. The QA report confirms them with tests. This review covers the IAP, gate and UI work that is new in M4.

---

## Blockers

### B-1. The silent restore on launch can open an App Store sign-in sheet with no PIN, on the kids' board
`src/db/DbProvider.tsx:43` calls `restore(db)` every time the app starts. `restore()` calls `IAP.restorePurchases()` at `src/iap/entitlement.ts:77`. On iOS, expo-iap runs that as `AppStore.sync()` (`node_modules/expo-iap/build/utils/restore
**Fix:** add `refreshEntitlement(db)` for the launch path. It calls only `IAP.getAvailablePurchases()` (on iOS this reads current entitlements with no UI). Keep `IAP.restorePurchases()` only in the user-started restore behind the PIN gate. 

### B-2. Pending and deferred purchases get the wrong result, and transactions that arrive later are never finished
`src/iap/entitlement.ts:43-71`:
1. The update listener at line 54 grants premium and calls `finishTransaction` for any event that matches `PRODUCT_ID`. It never checks `purchaseState === 'purchased'`. A Play **pending** purchase or a pending Ask to Buy request would unloc
2. The listeners exist only while `purchase()` is running and are removed after it settles. A purchase that finishes later never reaches a listener: Ask to Buy approved later, a pending Play purchase that completes, or a purchase interrupte
3. If the store never sends an event, nothing settles the promise. The button stays on "Opening store…" until the screen unmounts.
4. `restore()` (lines 78-79) also grants premium on any matching purchase whatever its state, and never acknowledges unfinished ones.

**Fix:** register one app-wide `purchaseUpdatedListener` and one `purchaseErrorListener` at startup, in the same place as the launch refresh, and keep them for the app's lifetime. In the update handler, if the state is `purchased`, call `fi

---

## Should fix

### S-1. The parental gate does not follow the design (`gate.ts` / `requirePin()`)
The design (§2 "Parental gate", §4 `src/domain/gate.ts`) and the ESLint pattern on `**/src/domain/gate` both expect a single `requirePin()`. That file does not exist. Instead, three call sites wire `PinGateModal` + `verifyPin` themselves: `
**Fix:** either add `src/domain/gate.ts` (the pure rule: which actions need a PIN) plus a `useRequirePin()` hook that returns `requirePin(): Promise<boolean>` and renders `PinGateModal`, and route all call sites through it; or update design

### S-2. `PinGateModal` gets stuck in cooldown and shows no countdown
`src/ui/PinGateModal.tsx:72` sets `'cooldown'` but never passes `cooldownSeconds` to `PinPad` (line 104). Nothing ever clears the cooldown, so the pad stays locked with no time shown until the parent closes and reopens the modal.
**Fix:** keep `lockedUntil` from `verifyPin`'s locked result, as the parent PIN screen already does. Tick a 1-second interval to pass `cooldownSeconds`, and go back to `'idle'` at 0. Clear the interval on unmount and when the modal closes. 

### S-3. A global `unhandledRejection` handler swallows real bugs in every test suite
`jest.setup.ts:5` (`process.on('unhandledRejection', () => {})`) hides floating promises in all 27 suites. The current IAP tests don't need it, because every rejection in `entitlement.ts` is caught.
**Fix:** remove it. If a specific test needs it, handle the rejection inside that test.

### S-4. Wrong message when a restore finds nothing on the Full Access screen
`app/parent/full-access.tsx:87`: when `restore` returns `false`, the screen sets `'cancelled'` and shows "Purchase cancelled. Your progress is safe." The user didn't cancel anything.
**Fix:** add a status `'not-found'` and show "No previous purchase found.", the same text as Settings.

### S-5. Cancel detection matches text instead of using the error code
`src/iap/entitlement.ts:15-18` matches `/cancel/` against `error.message`. Messages are localized and can change, and any other error whose message contains "cancel" would be counted as a cancellation.
**Fix:** check the typed code, `error.code === ErrorCode.UserCancelled` from expo-iap, and keep the regex only as a fallback.

### S-6. Gaps in test coverage
- There are no unit tests for: `purchase()` returning `'failed'` (store error, or `finishTransaction` rejects); `ensureConnected()` returning false; `restore()` with no match returning false and leaving `isPremium` alone; the listener ignor
- There are no component tests for `PinGateModal` (wrong PIN does not call `onVerified`, cooldown, cancel) or for the Full Access screen (PIN required before `purchase` is called; cancelled/failed/not-found messages; unlocked state after `n
- Task 7 requires Maestro flows that are missing from `e2e/`: trial expiry with the debug clock, purchase (sandbox), restore, a 9th member blocked, and demo with an Adult as the oldest member (the QA report also notes this).

**Fix:** add the unit and component tests now. Add the Maestro flows, tagging the sandbox-store ones so they run only on dev-client builds.

### S-7. The `expo-iap` dependency may not build on SDK 52
`package.json:32` uses `"expo-iap": "^6.0.0"`, which resolves to 6.4.3, on Expo SDK 52. Every other Expo module is pinned with `~`. Nobody has built a dev client with it yet, and `app.config.ts` has no `expo-iap` plugin entry. A caret range
**Fix:** pin an exact or `~` version that supports SDK 52. Add the plugin if that version's README asks for it. Then have devops confirm an EAS dev-client build for iOS and Android before this milestone closes. Devops should also confirm th

---

## Nits
- **N-1** `app/parent/full-access.tsx:136`: `status === 'success' && !isPremium` can never be true, because the same callback sets `isPremium`. Delete the branch.
- **N-2** `app/parent/full-access.tsx:175`: the confetti origin is hard-coded at `{x:180,y:200}`. Use the button's layout or the center of the window.
- **N-3** `app/parent/full-access.tsx:34-42`: the subscriber also plays `purchase_success` and fires confetti when the launch restore finishes while this screen is open. Celebrate only when this screen started the purchase or restore.
- **N-4** `app/parent/settings.tsx:181-185`: the colours are hard-coded (`#2e7d32`, `#555`, `#c62828`). Use `color.*` tokens, as `full-access.tsx` does.
- **N-5** `app/parent/settings.tsx:51-56`: when the store can't be reached and the device is already premium, `restore()` returns true from the local cache, and Settings says "Purchase restored". Return a result that marks the cached case, 
- **N-6** `src/iap/entitlement.ts:93`: `isValidProductId` is used only by a test. Remove it, or use it to check the product ID read from config.
- **N-7** `src/iap/entitlement.ts:6`: the design says the product ID lives in `app.config.ts` (so a rename is cheap). Read it from `Constants.expoConfig.extra`.
- **N-8** `src/db/DbProvider.tsx:43`: call `refreshSettings()` after the launch refresh changes `isPremium`, so the `settings` held in context are not left with the old value. Screens that reload on focus are already fine.

## What is good
- Kid routes import no IAP code. The ESLint rule blocks `expo-iap`, `src/iap` and `Linking` under `app/kid/**`.
- Purchase and restore both sit behind the PIN gate on Full Access and in Settings. The purchase button is disabled once the device is premium.
- If the store can't be reached, `restore()` keeps the premium flag already stored on the device and never clears it.
- The `settled` flag stops the purchase promise from resolving twice.
- The user-facing copy says "members" and "8" (AC-76), and the dashboard button now says "Add member".
- The dependency allowlist still passes, and no secrets or network endpoints were added.

## Verdict
Typecheck, lint and tests pass, and access limits and wording follow the design. But the store integration has two blockers before sandbox testing: the launch restore can open an App Store sign-in sheet with no PIN, possibly on the kids' bo

REQUEST CHANGES

