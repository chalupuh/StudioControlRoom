#!/usr/bin/env node
// check-intake: validate a Hana intake file (front matter + fixed sections).
//
//   node tools/intake/check-intake.js <file...>     exit 0 if all OK, else 1 and print problems
//
// Library: checkIntake(markdown) -> { ok, problems, meta: { id, type, priority, route, project } }

const fs = require('fs');

const ENUMS = {
  type: ['feature', 'enhancement', 'bug'],
  priority: ['P1', 'P2', 'P3'],
  route: ['quick-fix', 'lite', 'full', 'needs-owner'],
};
const SECTIONS = [
  'Original request',
  'Problem',
  'Acceptance criteria',
  'Team',
  'Work order',
  'Start command',
  'Open questions for the owner',
];

function parseFrontMatter(txt) {
  const m = txt.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  m[1].split('\n').forEach((l) => {
    const i = l.indexOf(':');
    if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).replace(/\s+#.*$/, '').trim();
  });
  return { meta, body: m[2] };
}

// Split body into { heading: content } on "## " headings (not "###").
function parseSections(body) {
  const out = {};
  let cur = null;
  for (const line of body.split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      cur = h[1].replace(/\s*\(.*\)$/, '').trim();
      out[cur] = '';
    } else if (cur !== null) {
      out[cur] += line + '\n';
    }
  }
  return out;
}

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').trim();

function checkIntake(markdown) {
  const problems = [];
  const txt = String(markdown).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = parseFrontMatter(txt);
  const emptyMeta = { id: '', type: '', priority: '', route: '', project: '' };
  if (!fm) return { ok: false, problems: ['missing front matter'], meta: emptyMeta };
  const { meta, body } = fm;
  const out = {
    id: meta.id || '', type: meta.type || '', priority: meta.priority || '',
    route: meta.route || '', project: meta.project || '',
  };

  for (const k of ['id', 'project']) if (!meta[k]) problems.push(`front matter: ${k} required`);
  for (const [k, vals] of Object.entries(ENUMS)) {
    if (!vals.includes(meta[k])) problems.push(`${k} must be one of ${vals.join(', ')}`);
  }

  const sections = parseSections(body);
  for (const s of SECTIONS) if (!(s in sections)) problems.push(`missing section: ${s}`);

  if ('Team' in sections && !/^\s*Team:\s*\S+/m.test(stripComments(sections.Team))) {
    problems.push('Team: line required');
  }
  if ('Work order' in sections && !/^###\s+Milestone\b/m.test(sections['Work order'])) {
    problems.push('Work order needs at least one "### Milestone" heading');
  }
  if (out.route && out.route !== 'quick-fix' && 'Start command' in sections
      && !stripComments(sections['Start command'])) {
    problems.push('Start command required unless route is quick-fix');
  }

  const flags = (meta.flags || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim());
  if (flags.includes('games-ip')) {
    const hay = (sections['Open questions for the owner'] || '') + (sections.Problem || '');
    if (!/^\s*[-*]?\s*IP:/m.test(hay)) problems.push('games-ip flag requires an IP: note');
  }

  if (out.type === 'bug') {
    const ac = sections['Acceptance criteria'] || '';
    if (!(/Repro/i.test(ac) && /Expected/i.test(ac) && /Actual/i.test(ac))) {
      problems.push('bug requires Repro/Expected/Actual');
    }
  }

  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(body)) problems.push('remove submitter email');

  return { ok: problems.length === 0, problems, meta: out };
}

function main(files) {
  if (!files.length) {
    console.error('usage: check-intake.js <file...>');
    return 2;
  }
  let bad = 0;
  for (const f of files) {
    let r;
    try { r = checkIntake(fs.readFileSync(f, 'utf8')); }
    catch (e) { r = { ok: false, problems: [`cannot read: ${e.message}`] }; }
    if (r.ok) console.log(`OK    ${f}`);
    else {
      bad++;
      console.log(`FAIL  ${f}`);
      r.problems.forEach((p) => console.log(`  - ${p}`));
    }
  }
  return bad ? 1 : 0;
}

module.exports = { checkIntake };

if (require.main === module) process.exit(main(process.argv.slice(2)));
