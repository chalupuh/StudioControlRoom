# Starts ComfyUI headless on 127.0.0.1:8188 in the background if not already up.
# Usage: start-comfy.ps1 [-LowVram]   (auto-enabled when free VRAM < 14 GB)
param([switch]$LowVram)
$root = 'C:\AI\ComfyUI_windows_portable'
$log  = 'C:\AI\comfy.log'
try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8188/system_stats | Out-Null; Write-Host 'ComfyUI already running'; exit 0 } catch {}
try {
  $free = [int](nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits | Select-Object -First 1)
  if ($free -lt 14000) { $LowVram = $true }
} catch {}
$args = @('-s','ComfyUI\main.py','--windows-standalone-build','--listen','127.0.0.1','--port','8188','--disable-auto-launch')
if ($LowVram) { $args += '--lowvram','--disable-dynamic-vram' }
Start-Process -FilePath "$root\python_embeded\python.exe" -ArgumentList $args -WorkingDirectory $root `
  -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
for ($i=0; $i -lt 90; $i++) {
  Start-Sleep 2
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8188/system_stats | Out-Null; Write-Host "ComfyUI up (lowvram=$LowVram)"; exit 0 } catch {}
}
Write-Host "ComfyUI did not come up; see $log"; exit 1
