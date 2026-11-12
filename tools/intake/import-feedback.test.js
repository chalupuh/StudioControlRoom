const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseFeedback } = require('./import-feedback.js');

const FIX = path.join(__dirname, 'fixtures', 'feedback-export.txt');
const text = fs.readFileSync(FIX, 'utf8');
const CLI = path.join(__dirname, 'import-feedback.js');

test('parses the screenshot item', () => {
  const items = parseFeedback(text);
  assert.strictEqual(items.length, 2);
  const a = items[0];
  assert.strictEqual(a.status, 'Submitted');
  assert.strictEqual(a.language, 'fr');
  assert.strictEqual(a.route, '#practice/avance-retour-achat');
  assert.ok(a.text.startsWith('I would like a complete new section called "Read Along"'));
  assert.ok(a.text.endsWith('Dark Souls, or Tainted Grail'));
  assert.strictEqual(items[1].language, 'sv');
  assert.strictEqual(items[1].route, null);
});

test('drops the submitter email', () => {
  const items = parseFeedback(text);
  assert.ok(!JSON.stringify(items).includes('@'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const r = spawnSync(process.execPath, [CLI, FIX, '--project', 'a-loreille', '--out', out]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const files = fs.readdirSync(out);
  assert.strictEqual(files.length, 2);
  for (const f of files) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes('@'));
});

test('stable id', () => {
  const a = parseFeedback(text).map((i) => i.sourceId);
  const b = parseFeedback(text.replace('Submitted', 'Shipped')).map((i) => i.sourceId);
  assert.deepStrictEqual(a, parseFeedback(text).map((i) => i.sourceId));
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a[0], a[1]);
});

test('re-import skips existing', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'imp-')), 'raw');
  const run = () => spawnSync(process.execPath, [CLI, FIX, '--project', 'a-loreille', '--out', out], { encoding: 'utf8' });
  const r1 = run();
  assert.strictEqual(fs.readdirSync(out).length, 2);
  const before = fs.readdirSync(out).map((f) => fs.statSync(path.join(out, f)).mtimeMs);
  const r2 = run();
  assert.match(r2.stdout, /skipped 2 existing/);
  assert.match(r2.stdout, /wrote 0/);
  assert.strictEqual(fs.readdirSync(out).length, 2);
  assert.ok(r1.stdout.includes('wrote 2'));
  assert.deepStrictEqual(fs.readdirSync(out).map((f) => fs.statSync(path.join(out, f)).mtimeMs), before);
});

test('multi-line + emoji body is preserved', () => {
  const b = parseFeedback(text)[1].text;
  assert.strictEqual(b, 'Please add a "café" mode 🎧\nSecond line: écoute d\'abord, puis répète.\n\nThird paragraph after a blank line.');
});

test('json export from /api/requests is supported', () => {
  const json = JSON.stringify({ requests: [
    { id: 'x1', userId: 'u', email: 'a@b.co', text: 'Add dark mode', kind: 'idea', language: 'es', status: 'planned' },
    { id: 'x2', userId: 'u', email: 'a@b.co', text: '[fr · open path · #home] Fix typo', kind: 'bug', language: 'both', status: 'submitted' },
  ] });
  const items = parseFeedback(json);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].language, 'es');
  assert.strictEqual(items[0].status, 'planned');
  assert.strictEqual(items[1].language, 'fr'); // 'both' falls back to the body tag
  assert.strictEqual(items[1].route, '#home');
  assert.strictEqual(items[1].text, 'Fix typo');
  assert.ok(!JSON.stringify(items).includes('@'));
});

test('item without a submitter line keeps its first body line', () => {
  const items = parseFeedback('Submitted · French\nPlease add more verbs to practice\nsecond line\nUpdate status\n');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].text, 'Please add more verbs to practice\nsecond line');
});

test('zero items: warns on stderr and exits non-zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const f = path.join(dir, 'bad.json');
  fs.writeFileSync(f, '{"requests": [');
  const r = spawnSync(process.execPath, [CLI, f, '--project', 'p', '--out', path.join(dir, 'raw')], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /no feedback items/);
});

test('front-matter values cannot inject keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-'));
  const f = path.join(dir, 'x.json');
  fs.writeFileSync(f, JSON.stringify([{ id: 'a', text: 'hello', language: 'fr', status: 'planned\nroute: evil\n---' }]));
  const out = path.join(dir, 'raw');
  const r = spawnSync(process.execPath, [CLI, f, '--project', 'p', '--out', out], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(out, fs.readdirSync(out)[0]), 'utf8');
  const fm = md.split('\n---\n')[0];
  assert.strictEqual((fm.match(/^route:/gm) || []).length, 1);
  assert.ok(!/^route: evil/m.test(fm));
  assert.strictEqual(md.split('\n').filter((l) => l === '---').length, 2);
});
