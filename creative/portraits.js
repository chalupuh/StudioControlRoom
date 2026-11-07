#!/usr/bin/env node
// Generates the cast portraits from .studio/roster.json with one consistent art direction.
//   node tools/creative/portraits.js [--seeds 2] [--only id1,id2] [--size 768]
// Writes candidates to .studio/portraits/candidates/<id>_<seed>.png. The Creative Director picks
// the winner and copies it to .studio/portraits/<id>.png (see pipeline creative-portraits).
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
// Org workspace: STUDIO_HOME env → studio.home.json at the software root → error.
const REPO = (() => { if (process.env.STUDIO_HOME) return path.resolve(process.env.STUDIO_HOME); try { return path.resolve(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'studio.home.json'), 'utf8')).home); } catch { throw new Error('Set STUDIO_HOME or create studio.home.json'); } })();
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

const STYLE = 'clean modern anime illustration, bust portrait, looking at viewer, soft studio lighting, crisp lineart, ' +
  'simple smooth gradient background in {color}, centered composition, high detail face, no text, no watermark, no logo';
// Original characters. Role props only, no franchise costumes, no artist names.
const LOOKS = {
  manager: 'calm young man, short dark navy hair, navy captain-style jacket with a small gold pin, holding a tablet, composed confident expression',
  'rd-manager': 'sharp-eyed woman in her thirties, long black hair in a low ponytail, round glasses, lab coat over a violet turtleneck, holding an open notebook',
  'market-researcher': 'energetic young woman, short sky-blue bob, explorer vest with many pockets, binoculars around her neck, curious smile',
  'opportunity-analyst': 'focused young woman, twin braids in chestnut brown, oversized cardigan, holding a clipboard with charts, pencil behind ear',
  'product-manager': 'organised young woman, neat shoulder-length pink hair with a hairclip, crisp blazer, holding sticky notes and a planner, warm smile',
  architect: 'stoic tall man, short grey-streaked hair, rolled-up sleeves, rolled blueprints under his arm, drafting compass in breast pocket',
  'ui-ux-designer': 'gentle young person, soft white-silver hair, pastel turtleneck, stylus in hand, colour swatches pinned to sweater, thoughtful look',
  'frontend-dev': 'confident young man, spiky orange hair, hoodie with headphones around neck, holding a laptop, grin',
  'backend-dev': 'laid-back young man, messy black hair, beanie, dark t-shirt with server-rack pattern, coffee mug in hand',
  'mobile-dev': 'cheerful young woman, teal hair in a side ponytail, bomber jacket, holding a smartphone up, sparkle in eyes',
  'devops-engineer': 'rugged young man, short brown hair with goggles on forehead, mechanic overalls with grease marks, wrench over shoulder',
  'qa-engineer': 'sharp young woman, red hair in a high ponytail, detective-style coat, holding a magnifying glass, determined squint',
  'code-reviewer': 'strict older man, neatly combed silver hair and short beard, dark hakama-inspired vest over shirt, arms crossed, red pen in hand',
  'creative-director': 'visionary young adult, wavy magenta hair, artist beret, paint-flecked jacket, holding a sketchbook, inspired expression',
  'image-artist': 'bright young woman, golden-blonde hair with paint brush hairpin, smock apron, holding a large paintbrush, joyful',
  'video-producer': 'cool young man, black undercut hair, director headset, holding a small film camera, focused',
  'copy-voice': 'friendly young woman, lavender hair, studio headphones, holding a microphone, mid-sentence warm smile',
};

const roster = JSON.parse(fs.readFileSync(path.join(REPO, '.studio', 'roster.json'), 'utf8')).agents;
const seeds = Number(arg('seeds', 2)), size = arg('size', '768');
const only = arg('only') ? arg('only').split(',') : Object.keys(LOOKS);
const out = path.join(REPO, '.studio', 'portraits', 'candidates');
fs.mkdirSync(out, { recursive: true });
const log = [];
for (const id of only) {
  const c = roster[id]; if (!c || !LOOKS[id]) { console.log('skip', id); continue; }
  const prompt = `${LOOKS[id]}, ${STYLE.replace('{color}', c.color)}`;
  for (let s = 1; s <= seeds; s++) {
    const seed = 1000 + s * 17 + id.length;
    const file = path.join(out, `${id}_${seed}.png`);
    if (fs.existsSync(file)) { console.log('have', path.basename(file)); continue; }
    const r = spawnSync(process.execPath, [path.join(__dirname, 'comfy.js'), 'image', '--prompt', prompt, '--w', size, '--h', size, '--seed', String(seed), '--out', file], { encoding: 'utf8', cwd: REPO });
    console.log((r.stdout || r.stderr).trim().split('\n').pop());
    log.push(`| ${id} | ${seed} | ${prompt.replace(/\|/g, '/')} |`);
    try { require('child_process').execSync(`node .studio/studio.js log image-artist ${Math.round((only.indexOf(id) + s / seeds) / only.length * 100)} "Portrait ${c.name} (${s}/${seeds})"`, { cwd: REPO }); } catch {}
  }
}
fs.appendFileSync(path.join(REPO, '.studio', 'portraits', 'manifest.md'), `\n## Candidates ${new Date().toISOString()}\n| id | seed | prompt |\n|---|---|---|\n${log.join('\n')}\n`);
console.log('done');
