# Real agent-loop test: Claude Code's own agent loop, driven by a LOCAL model through Ollama's
# Anthropic-compatible API. Nothing here calls Anthropic's cloud.
param(
  [Parameter(Mandatory)] [string]$ProjectDir,
  [string]$Model = 'qwen3.6:27b',
  [string]$Claude = (Get-ChildItem "$env:LOCALAPPDATA\Claude-Data" -Recurse -Filter claude.exe | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
)
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:11434'
$env:ANTHROPIC_AUTH_TOKEN = 'ollama'
$env:ANTHROPIC_API_KEY = ''
$env:ANTHROPIC_MODEL = $Model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $Model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $Model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'qwen3:4b'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

$task = @'
The tests in test/intake.test.js are failing. Fix the bugs in src/intake.js (do not change the tests),
run `npm test` until all tests pass, then write NOTES.md with one line per bug you fixed.
'@
Push-Location $ProjectDir
$t0 = Get-Date
& $Claude -p $task --model $Model --permission-mode acceptEdits --allowedTools "Read" "Edit" "Write" "Glob" "Grep" "Bash(npm test)" "Bash(node --test*)" --output-format json --max-turns 25
"`nELAPSED_SECONDS=$([int]((Get-Date) - $t0).TotalSeconds)"
Pop-Location
