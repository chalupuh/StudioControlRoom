#!/usr/bin/env node
// Regression: run vars containing Windows backslashes (e.g. {{home}} = C:\Users\...) must survive
// foreach expansion. Before the fix, the expanded stage JSON failed to parse and the engine crashed.
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-foreach-'));
fs.mkdirSync(path.join(home, 'tools', 'engine', 'pipelines'), { recursive: true });
fs.mkdirSync(path.join(home, '.studio'), { recursive: true });
fs.writeFileSync(path.join(home, 'items.md'), '- [ ] [x] alpha\n- [ ] [y] beta "quoted"\n');
const pipeline = {
  description: 'foreach escape test', defaults: {},
  stages: [{ id: 'loop', type: 'foreach', items: { file: 'items.md', regex: '^- \\[ \\] \\[(\\w+)\\] (.+)$' },
    stages: [{ id: 's', type: 'script', run: 'node -e "require(\'fs\').appendFileSync(\'out.txt\', process.argv[1] + \'\\n\')" "{{g2}} | {{winpath}}"' }] }],
};
fs.writeFileSync(path.join(home, 'tools', 'engine', 'pipelines', 't.json'), JSON.stringify(pipeline));

const r = spawnSync(process.execPath, [path.join(__dirname, 'engine.js'), 'start', 't', '--var', 'winpath=C:\\Users\\someone\\AI Dev Co'],
  { env: { ...process.env, STUDIO_HOME: home }, encoding: 'utf8', cwd: home });
const out = fs.existsSync(path.join(home, 'out.txt')) ? fs.readFileSync(path.join(home, 'out.txt'), 'utf8') : '';
let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
check(r.status === 0 && !/SyntaxError/.test(r.stderr + r.stdout), 'engine expands foreach without crashing');
check(out.includes('alpha | C:\\Users\\someone\\AI Dev Co'), 'Windows backslash path survives into the stage');
check(out.includes('beta'), 'second item ran');
fs.rmSync(home, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nforeach selftest passed');
process.exit(fails ? 1 : 0);
