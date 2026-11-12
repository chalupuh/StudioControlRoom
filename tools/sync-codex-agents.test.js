#!/usr/bin/env node
// sync-codex-agents / check-config: generation, drift detection and exit codes, in a temp --home.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const SYNC = path.join(__dirname, 'sync-codex-agents.js');
const CHECK = path.join(__dirname, 'ci', 'check-config.js');
let fails = 0;
const check = (ok, name) => { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) fails++; };
const run = (script, home, ...extra) => spawnSync(process.execPath, [script, '--home', home, ...extra], { encoding: 'utf8' });

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-codex-'));
const agentsDir = path.join(home, '.claude', 'agents');
fs.mkdirSync(agentsDir, { recursive: true });
const BOX = '┌─┐│└┘';
const srcFile = path.join(agentsDir, 'demo.md');
// BOM + CRLF + box-drawing + a backslash path + a """ sequence
const WINPATH = ['C:', 'Users', 'x'].join(String.fromCharCode(92));
const BOM = String.fromCharCode(0xFEFF);
fs.writeFileSync(srcFile, BOM + '---\r\nname: demo\r\ndescription: A demo role\r\n---\r\nYou are demo.\r\n' + BOX + '\r\nPath ' + WINPATH + ' and """ quotes.\r\n');
fs.writeFileSync(path.join(home, 'CLAUDE.md'), '# Studio\r\nThe main Claude Code session acts as the orchestrator. See CLAUDE.md and .claude/agents/.\r\nModels: Claude Opus.\r\n');

let r = run(SYNC, home, '--check');
check(r.status === 1, 'check before write: drift exits 1');
r = run(SYNC, home, '--write');
check(r.status === 0, 'write exits 0');
const toml = fs.readFileSync(path.join(home, '.codex', 'agents', 'demo.toml'), 'utf8');
check(toml.includes(BOX), 'UTF-8 box-drawing characters survive');
check(!toml.includes('\uFEFF') && !toml.includes('\r'), 'BOM and CRLF normalised');
check(toml.includes("developer_instructions = '''") && toml.includes(WINPATH + ' and """ quotes.'), "literal ''' string keeps backslashes and \"\"\"");
const md = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
check(md.includes('Claude Code orchestrator') && /main Claude Code session acts as the orchestrator/.test(md), 'AGENTS.md keeps Claude Code as the orchestrator');
check(!/Codex session|merged by Codex/.test(md) && md.includes('AGENTS.md and .codex/agents/'), 'AGENTS.md maps only file and directory names');
r = run(SYNC, home, '--check');
check(r.status === 0, 'check after write exits 0');
r = run(CHECK, home);
check(r.status === 0, 'check-config exits 0 when in sync');
fs.appendFileSync(srcFile, 'one more line\r\n');
r = run(CHECK, home);
check(r.status === 1, 'check-config exits 1 after the source changes');
run(SYNC, home, '--write');
// generator errors are tooling errors (2), not drift
fs.writeFileSync(path.join(agentsDir, 'bad.md'), '---\nname: bad\n---\nbody has \'\'\' inside\n');
r = run(SYNC, home, '--check');
check(r.status === 2, "body containing ''' exits 2");
fs.writeFileSync(path.join(agentsDir, 'bad.md'), 'no front matter\n');
r = run(SYNC, home, '--check');
check(r.status === 2, 'missing front matter exits 2');
fs.rmSync(path.join(agentsDir, 'bad.md'));
r = spawnSync(process.execPath, [SYNC, '--home'], { encoding: 'utf8' });
check(r.status === 2, '--home without a value exits 2');
fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
r = run(SYNC, home, '--check');
check(r.status === 2, 'missing .claude/agents exits 2');
r = run(CHECK, home);
check(r.status === 2, 'check-config passes exit 2 through');

fs.rmSync(home, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall sync-codex-agents tests passed');
process.exit(fails ? 1 : 0);
