#!/usr/bin/env node
// Self-test for parseRunOutput() — verifies the error-detection logic.
// Run: node tools/engine/selftest.js

const { parseRunOutput } = require('./engine');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const jsonLine = (obj) => JSON.stringify(obj);
const now = () => new Date().toISOString();

// ---- Test 1: clean success ----
{
  const r = parseRunOutput({
    status: 0,
    stdout: jsonLine({ result: 'done', num_turns: 5, is_error: false }),
  });
  assert('clean success → no error', r.error === null);
  assert('clean success → result preserved', r.result === 'done');
  assert('clean success → turns parsed', r.turns === 5);
}

// ---- Test 2: stderr warning on a clean success → ignored ----
{
  const r = parseRunOutput({
    status: 0,
    stdout: jsonLine({ result: 'done', num_turns: 3, is_error: false }),
    stderr: '[claude-code:unrecognized_model] qwen3.6:27b is not a recognized model',
  });
  assert('stderr warning on success → no error', r.error === null);
  assert('stderr warning on success → result preserved', r.result === 'done');
}

// ---- Test 3: is_error=true but result present → still not an error (partial success) ----
{
  const r = parseRunOutput({
    status: 0,
    stdout: jsonLine({ result: 'partial output', num_turns: 2, is_error: true }),
    stderr: 'some warning about model mismatch',
  });
  assert('is_error + has result → no error (partial success)', r.error === null);
  assert('is_error + has result → result preserved', r.result === 'partial output');
}

// ---- Test 4: real error — is_error + no result → error reported ----
{
  const r = parseRunOutput({
    status: 0,
    stdout: jsonLine({ num_turns: 0, is_error: true, subtype: 'error_timeout' }),
    stderr: 'Timed out after 30m',
  });
  assert('is_error + no result → error reported', r.error !== null);
  assert('is_error + no result → stderr captured', r.error.includes('Timed out'));
}

// ---- Test 5: real error — non-zero status + no result → error reported ----
{
  const r = parseRunOutput({
    status: 1,
    stdout: jsonLine({ num_turns: 0, is_error: false }),
    stderr: 'Process crashed',
  });
  assert('non-zero status + no result → error reported', r.error !== null);
  assert('non-zero status + no result → stderr captured', r.error.includes('crashed'));
}

// ---- Test 6: real error — both is_error and non-zero + no result → error reported ----
{
  const r = parseRunOutput({
    status: 2,
    stdout: jsonLine({ num_turns: 0, is_error: true }),
    stderr: 'Fatal: config missing',
  });
  assert('is_error + non-zero + no result → error reported', r.error !== null);
  assert('is_error + non-zero + no result → stderr captured', r.error.includes('config missing'));
}

// ---- Test 7: fallback to subtype when stderr is empty ----
{
  const r = parseRunOutput({
    status: 1,
    stdout: jsonLine({ num_turns: 0, is_error: true, subtype: 'error_max_turns' }),
    stderr: '',
  });
  assert('empty stderr + is_error + no result → subtype used', r.error === 'error_max_turns');
  assert('empty stderr + is_error + no result → hitTurnCap true', r.hitTurnCap === true);
}

// ---- Test 8: empty stdout → graceful fallback ----
{
  const r = parseRunOutput({
    status: 0,
    stdout: '',
  });
  assert('empty stdout → no error', r.error === null);
  assert('empty stdout → result is empty string', r.result === '');
}

// ---- Test 9: malformed JSON stdout → graceful fallback ----
{
  const r = parseRunOutput({
    status: 0,
    stdout: 'not json at all',
  });
  assert('malformed JSON → no error', r.error === null);
  assert('malformed JSON → result is empty string', r.result === '');
}

// ---- Test 10: usage parsing ----
{
  const r = parseRunOutput({
    status: 0,
    stdout: jsonLine({
      result: 'ok', num_turns: 3, is_error: false,
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 },
    }),
  });
  assert('usage parsed correctly', r.usage.in === 1000 && r.usage.out === 500 && r.usage.cached === 200);
}

// ---- Test 11: unrecognized_model + is_error + non-zero + no result → ERROR REPORTED ----
// The unrecognized_model warning is logged to ignoredWarning but does NOT suppress the error.
// A real failure signal (is_error + non-zero exit) with no result must be reported.
{
  const stderr = '[claude-code:unrecognized_model] {"model":"qwen3.6:27b","query_source":"sdk"}';
  const r = parseRunOutput({
    status: 1,
    stdout: jsonLine({ num_turns: 3, is_error: true }),
    stderr,
  });
  assert('unrecognized_model + failure + no result → error reported (not suppressed)', r.error !== null);
  assert('unrecognized_model → ignoredWarning still logged', r.ignoredWarning !== null);
  assert('unrecognized_model → ignoredWarning contains the message', r.ignoredWarning.includes('[claude-code:unrecognized_model]'));
  assert('unrecognized_model → turns still parsed', r.turns === 3);
}

// ---- Test 12: unrecognized_model with result present → also no error (redundant but explicit) ----
{
  const r = parseRunOutput({
    status: 1,
    stdout: jsonLine({ result: 'completed successfully', num_turns: 4, is_error: true }),
    stderr: '[claude-code:unrecognized_model] {"model":"qwen3.6:27b","query_source":"sdk"}',
  });
  assert('unrecognized_model + has result → no error', r.error === null);
  assert('unrecognized_model + has result → result preserved', r.result === 'completed successfully');
  assert('unrecognized_model + has result → ignoredWarning set', r.ignoredWarning !== null);
}

// ---- Test 13: stderr contains unrecognized_model mid-stream (surrounded by other text) ----
// The warning is logged but does not suppress the error.
{
  const r = parseRunOutput({
    status: 1,
    stdout: jsonLine({ num_turns: 2, is_error: true }),
    stderr: 'some other log\n[claude-code:unrecognized_model] {"model":"qwen3.6:27b","query_source":"sdk"}\nexit',
  });
  assert('unrecognized_model buried in stderr → error reported (not suppressed)', r.error !== null);
  assert('unrecognized_model buried → ignoredWarning still logged', r.ignoredWarning !== null);
}

// ---- Test 14: no unrecognized_model warning + real failure → still reported as error ----
{
  const r = parseRunOutput({
    status: 1,
    stdout: jsonLine({ num_turns: 0, is_error: true }),
    stderr: 'Connection refused to API endpoint',
  });
  assert('genuine failure without model warning → error reported', r.error !== null);
  assert('genuine failure → ignoredWarning is null', r.ignoredWarning === null);
}

// ---- Test 15: timeout — status null, signal SIGTERM, no result → error reported ----
// spawnSync returns { status: null, signal: 'SIGTERM' } when the child is killed by timeout.
{
  const r = parseRunOutput({
    status: null,
    signal: 'SIGTERM',
    stdout: jsonLine({ num_turns: 0, is_error: false }),
    stderr: 'Timed out after 30m',
  });
  assert('timeout (signal SIGTERM, no result) → error reported', r.error !== null);
  assert('timeout → stderr captured in error', r.error.includes('Timed out'));
  assert('timeout → ignoredWarning is null', r.ignoredWarning === null);
}

// ---- Test 15b: timeout with empty stderr, no subtype → error is non-empty string (S2) ----
// spawnSync timeout with r.error ETIMEDOUT and no stderr/subtype must produce a real error string.
{
  const r = parseRunOutput({
    status: null,
    signal: 'SIGTERM',
    error: { code: 'ETIMEDOUT' },
    stdout: '',
    stderr: '',
  });
  assert('timeout empty stderr no subtype → error is non-empty string', typeof r.error === 'string' && r.error.length > 0);
  assert('timeout empty stderr → error includes ETIMEDOUT', r.error.includes('ETIMEDOUT'));
}

// ---- Test 15c: spawn error ENOENT, empty stderr → error is non-empty string (S2) ----
{
  const r = parseRunOutput({
    status: null,
    error: { code: 'ENOENT' },
    stdout: '',
    stderr: '',
  });
  assert('ENOENT empty stderr → error is non-empty string', typeof r.error === 'string' && r.error.length > 0);
  assert('ENOENT empty stderr → error includes ENOENT', r.error.includes('ENOENT'));
}

// ---- Test 15d: failure with only non-zero status, no stderr/subtype → error mentions exit code (S2) ----
{
  const r = parseRunOutput({
    status: 42,
    stdout: jsonLine({ num_turns: 0, is_error: true }),
    stderr: '',
  });
  assert('non-zero status no stderr → error is non-empty string', typeof r.error === 'string' && r.error.length > 0);
  assert('non-zero status no stderr → error mentions exit 42', r.error.includes('exit 42'));
}

// ---- Test 16: direct verify() test — empty result triggers "empty final answer" ----
{
  const { verify } = require('./engine');
  const resError = parseRunOutput({
    status: 1,
    stdout: jsonLine({ num_turns: 0, is_error: true }),
    stderr: 'something went wrong',
  });
  const problems1 = verify({ type: 'agent', id: 'test', expect: [] }, {}, resError);
  assert('verify() with error + empty result → reports both error and empty answer',
    problems1.some((p) => p.startsWith('run error:')) && problems1.some((p) => p === 'empty final answer'));

  const resOk = parseRunOutput({
    status: 0,
    stdout: jsonLine({ num_turns: 3, is_error: false, result: 'all done' }),
  });
  const problems2 = verify({ type: 'agent', id: 'test', expect: [] }, {}, resOk);
  assert('verify() with clean success → no problems', problems2.length === 0);

  // verify() "empty final answer" fires even when ignoredWarning is set (no bypass)
  const resWarnEmpty = parseRunOutput({
    status: 1,
    stdout: jsonLine({ num_turns: 2, is_error: true }),
    stderr: '[claude-code:unrecognized_model] warning text',
  });
  const problems3 = verify({ type: 'agent', id: 'test', expect: [] }, {}, resWarnEmpty);
  assert('verify() with ignoredWarning + empty result → empty final answer still reported',
    problems3.some((p) => p === 'empty final answer'));
}

// ---- Postmortem selftest ----
{
  const { writePostmortem } = require('./engine');
  const os = require('os');
  const tmpStudio = path.join(os.tmpdir(), `studio-postmortem-${process.pid}-${Date.now()}`);
  const oldHome = process.env.STUDIO_HOME;
  process.env.STUDIO_HOME = tmpStudio;
  // Re-require engine with new STUDIO_HOME so REPO points to our temp dir
  delete require.cache[require.resolve('./engine')];
  const { writePostmortem: write, REPO: tmpREPO } = require('./engine');
  const runId = `postmortem-test-${process.pid}`;
  const stageId = 'test-stage';
  const fakeRun = {
    id: runId,
    history: [
      { stage: stageId, agent: 'backend-dev', attempt: 1, tier: 'local', model: 'qwen3.6:27b', ok: false, error: 'timeout', problems: ['check failed: lint'], secs: 45, turns: 10, usage: { in: 1000, out: 500, cached: 200 }, at: now() },
      { stage: stageId, agent: 'backend-dev', attempt: 2, tier: 'sonnet', model: 'sonnet', ok: false, error: 'api error', problems: ['run error: connection refused'], secs: 30, turns: 5, usage: { in: 800, out: 400, cached: 0 }, at: now() },
    ],
  };
  const stage = { id: stageId };
  const fp = write(fakeRun, stage);
  assert('postmortem file created at correct path', fp.includes(runId) && fp.includes(stageId) && (fp.includes('docs/postmortems') || fp.includes('docs\\postmortems')));
  assert('postmortem file exists on disk', fs.existsSync(fp));
  const content = fs.readFileSync(fp, 'utf8');
  assert('postmortem contains "What happened"', content.includes('## What happened'));
  assert('postmortem lists tiers tried', content.includes('## Tiers tried'));
  assert('postmortem lists problems', content.includes('## Problems'));
  assert('postmortem contains "check failed: lint"', content.includes('check failed: lint'));
  assert('postmortem contains "run error: connection refused"', content.includes('run error: connection refused'));
  assert('postmortem has time/token section', content.includes('## Time and Token Usage'));
  assert('postmortem has token totals (1800 in, 900 out, 200 cached)', content.includes('1800') && content.includes('900') && content.includes('200'));
  assert('postmortem has empty "Root cause" section', content.includes('## Root cause'));
  assert('postmortem has empty "Fix" section', content.includes('## Fix'));
  assert('postmortem has empty "Prevent" section', content.includes('## Prevent'));
  // Cleanup temp studio home
  process.env.STUDIO_HOME = oldHome;
  try { fs.rmSync(tmpStudio, { recursive: true }); } catch {}
  // Restore cached engine module
  delete require.cache[require.resolve('./engine')];
}

// ---- Summary ----
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
