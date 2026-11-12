#!/usr/bin/env node
// import-feedback: turn an export of the language app's /feedback page into raw intake files.
//
//   node tools/intake/import-feedback.js <export.txt|export.json> --project a-loreille --out <dir>
//
// Accepts pasted page text, or JSON from /api/requests ({requests:[...]} or a bare array).
// Writes <out>/<sourceId>.md per item, skipping ids that already exist. Submitter emails are dropped.
//
// Library: parseFeedback(text) -> [{ sourceId, status, language, route, text }]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LANGS = { french: 'fr', swedish: 'sv', spanish: 'es', fr: 'fr', sv: 'sv', es: 'es' };
const HEADER = /^([A-Za-z][A-Za-z -]*?)\s+·\s+(French|Swedish|Spanish|Both)\s*$/;
const TAG = /^\[\s*(fr|sv|es)\s*·\s*[^·\]]*?\s*·\s*(#[^\]\s]*)\s*\]\s*/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

const toLang = (s) => LANGS[String(s || '').trim().toLowerCase()] || null;
const scrub = (s) => s.replace(EMAIL, '[email]');

function makeItem(status, language, body) {
  let text = body;
  let route = null;
  const m = text.match(TAG);
  if (m) {
    route = m[2];
    language = language || toLang(m[1]);
    text = text.slice(m[0].length);
  }
  text = scrub(text.trim());
  const sourceId = 'fb-' + crypto.createHash('sha256')
    .update(`${language || ''}\n${text}`).digest('hex').slice(0, 12);
  return { sourceId, status, language, route, text };
}

function parseJson(data) {
  const list = Array.isArray(data) ? data : data.requests;
  if (!Array.isArray(list)) throw new Error('JSON has no requests array');
  return list.filter((r) => r && typeof r.text === 'string')
    .map((r) => makeItem(String(r.status || ''), toLang(r.language), r.text));
}

function parseFeedback(input) {
  const txt = String(input).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (/^\s*[[{]/.test(txt)) {
    try { return parseJson(JSON.parse(txt)); } catch (e) { /* fall through to text */ }
  }
  const lines = txt.split('\n');
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].trim().match(HEADER);
    if (!h) continue;
    const body = [];
    // The line after the header is the submitter (an email or one bare token); drop it only then.
    const sub = (lines[i + 1] || '').trim();
    const hasSubmitter = sub !== '' && (/@/.test(sub) || !/\s/.test(sub))
      && sub !== 'Update status' && !HEADER.test(sub);
    let j = i + (hasSubmitter ? 2 : 1);
    for (; j < lines.length; j++) {
      if (lines[j].trim() === 'Update status') break;
      if (HEADER.test(lines[j].trim())) { j--; break; }
      body.push(lines[j]);
    }
    const text = body.join('\n').trim();
    if (text) items.push(makeItem(h[1], toLang(h[2]), text));
    i = j;
  }
  return items;
}

const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();

function toMarkdown(item, project) {
  return [
    '---',
    `id: ${clean(item.sourceId)}`,
    `project: ${clean(project)}`,
    `status: ${clean(item.status)}`,
    `language: ${clean(item.language)}`,
    `route: ${clean(item.route)}`,
    '---',
    '',
    item.text,
    '',
  ].join('\n');
}

function main(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') args.project = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else args._.push(argv[i]);
  }
  if (args._.length !== 1 || !args.project || !args.out) {
    console.error('usage: import-feedback.js <export> --project <slug> --out <dir>');
    return 2;
  }
  let items;
  try { items = parseFeedback(fs.readFileSync(args._[0], 'utf8')); }
  catch (e) { console.error(`cannot read export: ${e.message}`); return 1; }
  if (!items.length) {
    console.error('warning: no feedback items found in the export (unrecognised layout or invalid JSON); nothing written');
    return 1;
  }
  fs.mkdirSync(args.out, { recursive: true });
  let wrote = 0;
  let skipped = 0;
  const seen = new Set();
  for (const it of items) {
    const f = path.join(args.out, `${it.sourceId}.md`);
    if (seen.has(it.sourceId) || fs.existsSync(f)) { skipped++; continue; }
    seen.add(it.sourceId);
    fs.writeFileSync(f, toMarkdown(it, args.project));
    wrote++;
  }
  console.log(`wrote ${wrote}, skipped ${skipped} existing`);
  return 0;
}

module.exports = { parseFeedback };

if (require.main === module) process.exit(main(process.argv.slice(2)));
