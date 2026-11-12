#!/usr/bin/env node
// extractFindings / findingsFallback / reworkPrompt, against trimmed excerpts of real review reports (engine/fixtures).
// Regression: on a HiveBoard M4 rework the checklist held only nit IDs and the blockers B-1/B-2 stayed open for 3 rounds.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.STUDIO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-extract-home-'));
const engine = require('./engine.js');
let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const ids = (f) => f.map((x) => x.id);
const rank = (f, id) => ids(f).indexOf(id);

// M4 round 1: "### B-1. ..." headings with no severity word and no file:line; nits as "- **N-1** ..." bullets.
{
  const f = engine.extractFindings(fx('review-m4-round1.md'));
  check(['B-1', 'B-2'].every((i) => ids(f).includes(i)), 'm4r1: B-1 and B-2 headings are extracted');
  check(f[0].id === 'B-1' && f[1].id === 'B-2' && f[0].severity === 'blocker', 'm4r1: blockers come first');
  check(['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6', 'S-7'].every((i) => ids(f).includes(i)), 'm4r1: all S-items extracted');
  check(rank(f, 'S-7') < rank(f, 'N-1'), 'm4r1: should-fix before nits');
  check(/silent restore/i.test(f[0].text) && f[0].ref === 'src/db/DbProvider.tsx:43', 'm4r1: short title and file:line kept');
  check(new Set(ids(f)).size === f.length, 'm4r1: IDs unique');
  check(engine.findingsFallback(fx('review-m4-round1.md'), f) === '', 'm4r1: no fallback needed when blockers were extracted');
}
// M4 round 3: status tables. B-1/B-2/S-* STILL FAILING must be listed, N-9..N-12 FIXED must not.
{
  const f = engine.extractFindings(fx('review-m4-round3.md'));
  check(['B-1', 'B-2', 'S-1', 'S-2', 'S-3', 'S-5', 'S-6', 'S-7'].every((i) => ids(f).includes(i)), 'm4r3: STILL FAILING table rows extracted');
  check(!['N-9', 'N-10', 'N-11', 'N-12'].some((i) => ids(f).includes(i)), 'm4r3: FIXED rows are skipped');
  check(ids(f).includes('N-13'), 'm4r3: new nit N-13 kept');
  check(f[0].id === 'B-1' && f[1].id === 'B-2' && rank(f, 'S-7') < rank(f, 'N-13'), 'm4r3: ordered blockers, should-fix, nits');
  check(!ids(f).includes('S-4'), 'm4r3: S-4 (not in table) is not invented');
}
// M3 round 3: bold lead-in blockers, a 4-column status table (F-ids), FIXED rows skipped.
{
  const t = fx('review-m3-round3.md'); const f = engine.extractFindings(t);
  check(['B-1', 'B-2'].every((i) => ids(f).includes(i)) && f[0].id === 'B-1', 'm3r3: bold "**B-1. ..." blockers extracted first');
  check(ids(f).includes('F17') && ids(f).includes('F36') && ids(f).includes('F39'), 'm3r3: STILL FAILING / UNVERIFIED table rows extracted');
  check(!['F1', 'F2', 'F8', 'F13', 'F35'].some((i) => ids(f).includes(i) && /FIXED/.test(f.find((x) => x.id === i).text)), 'm3r3: FIXED rows are not listed');
  check(!ids(f).includes('F19'), 'm3r3: "**FIXED** (code); e2e broken" is still FIXED');
}
// Sprint 4h round 4: "### B1." and "### S1." headings with "- **Where:**" sub-bullets.
{
  const f = engine.extractFindings(fx('review-sprint4h-round4.md'));
  check(f[0].id === 'B1' && f[0].severity === 'blocker' && /install-service\.ps1:54/.test(f[0].ref), '4h: B1 first, with file:line from its Where line');
  check(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'].every((i) => ids(f).includes(i)), '4h: S1-S8 extracted');
  check(!f.some((x) => /^(Where|Problem|Fix)/i.test(x.text) || /^F\d+$/.test(x.id) && x.severity === 'blocker'), '4h: sub-bullets of a finding are not separate findings');
}
// Inline synthetic cases.
{
  const f = engine.extractFindings('## Blockers\n**B-1 (F36). The honey jar never reaches Ready.**\nbody\n- R2a: the cache is stale after logout\n- F7: `a.js:3` leaks a token\n');
  check(ids(f).join() === 'B-1,R2a,F7', 'bold "**B-1 (F36). ..." lead-in, R<n><letter> bullet and F<n> bullet');
  const g = engine.extractFindings('| ID | Status | Evidence |\n|---|---|---|\n| S-1 | FAIL | x.js:1 broken |\n| S-2 | OPEN | nothing done |\n| S-3 | UNVERIFIED | could not run |\n| S-4 | **FIXED** | ok |\n| B-9 | **NOT FIXED** | still there |\n');
  check(ids(g).join() === 'B-9,S-1,S-2,S-3', 'FAIL / OPEN / UNVERIFIED / NOT FIXED kept (blocker first), FIXED dropped');
  const h = engine.extractFindings('- B-1 is still the main issue in this report overall.\nF1-F18 are as in round 2.\n- **F19 = AC-72** (household onboarding)\n');
  check(h.length === 0, 'prose mentions of IDs are not findings');
}
// Fallback: a non-empty Blockers section with no extractable blocker is injected verbatim.
{
  const rep = '# Review\n## Blockers\nThe whole thing is wrong, nothing validates input at all and the build is broken.\nSecond paragraph of explanation.\n\n## Should fix\nrename things consistently across the code base\n\n## Nits\n- **N-1** `a.js:1` typo here\n';
  const f = engine.extractFindings(rep);
  const fb = engine.findingsFallback(rep, f);
  check(/nothing validates input/.test(fb) && /rename things/.test(fb) && !/typo/.test(fb), 'fallback contains the Blockers and Should-fix sections only');
  check(engine.findingsFallback('## Blockers\nNone.\n\n## Nits\n- x\n', []) === '', 'no fallback for an empty ("None.") Blockers section');
  check(engine.findingsFallback('## Blockers\n' + 'x'.repeat(9000) + '\n', []).length < 6200, 'fallback is truncated');
  const p = engine.reworkPrompt({ round: 1, max: 3, rejectedBy: 'review', report: 'r.md', reportSha256: 'abc', findings: f, findingsFallback: fb, baseline: null }, process.cwd());
  check(/copied verbatim/.test(p) && /nothing validates input/.test(p), 'rework prompt injects the fallback');
  const q = engine.reworkPrompt({ round: 1, max: 3, rejectedBy: 'review', report: 'r.md', reportSha256: 'abc', findings: engine.extractFindings(fx('review-m4-round3.md')), baseline: null }, process.cwd());
  check(/Fix blockers first; fix nits only after all blockers and should-fix items are done\./.test(q), 'rework prompt has the blockers-first line');
  check(q.indexOf('B-1 ') < q.indexOf('S-1 ') && q.indexOf('S-7') < q.indexOf('N-13'), 'prompt checklist is ordered B, S, N');
  check(!/copied verbatim/.test(q), 'no fallback block when blockers were extracted');
}
if (fails) { console.error(`\n${fails} extractFindings test(s) failed`); process.exit(1); }
console.log('\nextractFindings tests passed');
