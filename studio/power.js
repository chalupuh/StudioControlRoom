// Studio power: one-shot total shutdown ("Game mode") and startup.
// Shutdown = pause → let running agents checkpoint → force-stop leftovers (with a checkpoint note)
//          → unload + stop Ollama → stop ComfyUI → stop the Control Room server → report GPU.
// Windows-first (this studio runs on the owner's gaming PC); other platforms degrade to best effort.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => {
  try { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};

/** Processes that belong to the studio (never the user's desktop Claude app, games, etc.). */
function studioProcesses() {
  if (!isWin) return [];
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'engine[\\\\/]engine\\.js') -or ($_.Name -eq 'claude.exe' -and $_.CommandLine -match ' -p ' -and $_.CommandLine -match '--agent') -or ($_.Name -match '^ollama' ) -or ($_.Name -eq 'python.exe' -and $_.CommandLine -match 'ComfyUI') } | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.Name, ($_.CommandLine -replace '[\\r\\n|]',' ') }`);
  return out.split(/\r?\n/).filter(Boolean).map((l) => { const [pid, name, ...cmd] = l.split('|'); return { pid: Number(pid), name, cmd: cmd.join('|') }; })
    .filter((p) => p.pid && p.pid !== process.pid);
}
const kill = (pid) => { if (isWin) ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`); else try { process.kill(pid, 'SIGKILL'); } catch {} };
const gpuUsed = () => { try { return execFileSync('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim(); } catch { return 'n/a'; } };

async function unloadOllama() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(3000) });
    const { models = [] } = await r.json();
    for (const m of models) await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(10000) }).catch(() => {});
    return models.map((m) => m.name);
  } catch { return []; }
}

/**
 * @param ctx {{ HOME, DIR, setControl, append, checkpoint, keepServer?: boolean, graceSec?: number, log?: (s)=>void }}
 */
async function shutdown(ctx) {
  const log = ctx.log || console.log;
  const report = { started: new Date().toISOString(), gpuBefore: gpuUsed(), steps: [] };
  const step = (s) => { report.steps.push(s); log('• ' + s); };

  // 1. Safe stop: hooks block new tool calls; agents save checkpoints at their next step.
  ctx.setControl('paused', 'shutdown');
  step('Studio paused (agents checkpoint at their next step)');

  // 2. Wait for engine runs / headless agents to wind down, then force-stop leftovers.
  const grace = (ctx.graceSec ?? 60) * 1000, t0 = Date.now();
  let busy = studioProcesses().filter((p) => p.name === 'claude.exe' || /engine/.test(p.cmd));
  while (busy.length && Date.now() - t0 < grace) { await sleep(3000); busy = studioProcesses().filter((p) => p.name === 'claude.exe' || /engine/.test(p.cmd)); }
  if (busy.length) {
    for (const p of busy) kill(p.pid);
    // Mark runs that were mid-stage so `resume` knows to redo that stage.
    const runsDir = path.join(ctx.DIR, 'runs');
    if (fs.existsSync(runsDir)) for (const f of fs.readdirSync(runsDir).filter((f) => f.endsWith('.json'))) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
        if (r.status === 'running') {
          const st = r.stages[r.cursor];
          r.status = 'paused'; r.blockedReason = 'force-stopped by shutdown'; fs.writeFileSync(path.join(runsDir, f), JSON.stringify(r, null, 2));
          ctx.checkpoint([st?.agent || 'manager', `Shutdown force-stopped run ${r.id} during stage ${st?.id}`, `On startup: node tools/engine/engine.js resume ${r.id} (re-runs stage ${st?.id})`, '(see run file)']);
        }
      } catch {}
    }
    step(`Force-stopped ${busy.length} agent/engine process(es) after ${Math.round(grace / 1000)} s; runs marked paused with checkpoints`);
  } else step('All agents stopped on their own');

  // 3. Local models: unload, then stop Ollama entirely (tray app + server).
  const unloaded = await unloadOllama();
  for (const p of studioProcesses().filter((p) => /^ollama/i.test(p.name))) kill(p.pid);
  step(`Ollama stopped${unloaded.length ? ' (unloaded ' + unloaded.join(', ') + ')' : ''}`);

  // 4. ComfyUI (image/video)
  const comfy = studioProcesses().filter((p) => p.name === 'python.exe');
  for (const p of comfy) kill(p.pid);
  step(comfy.length ? `ComfyUI stopped (${comfy.length} process(es))` : 'ComfyUI was not running');

  await sleep(2000);
  report.gpuAfter = gpuUsed();
  report.leftover = studioProcesses().map((p) => `${p.name}#${p.pid}`);
  step(`GPU memory used (MiB, used,total): before ${report.gpuBefore} → after ${report.gpuAfter}`);
  if (report.leftover.length) step('WARNING still running: ' + report.leftover.join(', '));
  report.finished = new Date().toISOString();
  fs.writeFileSync(path.join(ctx.DIR, 'shutdown-report.json'), JSON.stringify(report, null, 2));
  ctx.append({ type: 'paused', agent: 'manager', message: `Game mode: studio fully shut down. GPU ${report.gpuBefore} → ${report.gpuAfter} MiB` });

  // 5. The Control Room server itself (last, so the UI can show the result first).
  if (!ctx.keepServer) {
    const pidFile = path.join(ctx.DIR, 'server.pid');
    try { const pid = Number(fs.readFileSync(pidFile, 'utf8')); if (pid && pid !== process.pid) { kill(pid); step('Control Room server stopped'); } fs.unlinkSync(pidFile); } catch {}
  }
  return report;
}

/** Start everything back up (does NOT resume work — the owner flips the switch for that). */
function startup(ctx) {
  const log = ctx.log || console.log;
  if (isWin) {
    // Start the Ollama *server* headless (the tray app doesn't reliably start it and isn't needed).
    const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
    if (fs.existsSync(exe) && !studioProcesses().some((p) => p.name === 'ollama.exe')) {
      const env = { OLLAMA_KEEP_ALIVE: '5m', OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NUM_PARALLEL: '4', ...process.env };
      spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref(); log('• Ollama server started (headless)');
    } else log('• Ollama already running (or not installed)');
  }
  const pidFile = path.join(ctx.DIR, 'server.pid');
  let up = false; try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); up = true; } catch {}
  if (!up) {
    const out = fs.openSync(path.join(ctx.DIR, 'server.log'), 'a');
    spawn(process.execPath, [path.join(__dirname, 'studio.js'), 'serve'], { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
    log('• Control Room server started → http://localhost:4777');
  } else log('• Control Room server already running');
  log('Studio is still PAUSED. Flip the switch to Running (or `studio.js resume`) when you want agents to work.');
}

module.exports = { shutdown, startup, studioProcesses, gpuUsed };
