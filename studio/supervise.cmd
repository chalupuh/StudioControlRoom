@echo off
REM Wrapper: runs the supervisor with the correct STUDIO_HOME and node path.
REM Called directly by the StudioSupervisor Scheduled Task (no cmd /c wrapper).
REM
REM When launched by the scheduled task, STUDIO_HOME and STUDIO_NODE are pre-set
REM as task environment variables by install-service.ps1.  If not (manual launch),
REM we fall back to resolving studio.home.json at the repo root.
REM
REM Resolution order:
REM   1. STUDIO_HOME environment variable (set by task)
REM   2. studio.home.json at repo root (%~dp0..)
REM   3. Abort — never silently use the repo root without a config file.

REM --- Resolve node executable ---
REM Prefer pinned path from task; fall back to PATH.
if defined STUDIO_NODE goto runSupervisor

REM --- Resolve STUDIO_HOME ---
if defined STUDIO_HOME goto runSupervisor

REM Try studio.home.json at repo root (%~dp0 is the studio\ directory)
for /f "usebackq tokens=1 delims=" %%A in (
    `powershell -NoProfile -NonInteractive ^
        -Command "$j=Get-Content -Raw '%~dp0..\studio.home.json' 2>$null; if($j){($j|ConvertFrom-Json).home}"`
) do set "STUDIO_HOME=%%A"
if defined STUDIO_HOME goto runSupervisor

REM Nothing resolved — abort instead of silently falling back to repo root.
echo ERROR: Cannot resolve STUDIO_HOME.
echo   - Set STUDIO_HOME env var, or
echo   - Create studio.home.json in the repo root, or
echo   - Run install-service.ps1 to set up the task.
exit /b 1

:runSupervisor
REM Trim trailing whitespace from the value (powershell output may have newline)
if defined STUDIO_HOME (
    for /f "tokens=* delims=" %%A in ("%STUDIO_HOME%") do set "STUDIO_HOME=%%A"
)

REM Launch supervisor
if defined STUDIO_NODE (
    "%STUDIO_NODE%" "%~dp0studio.js" supervise
) else (
    node "%~dp0studio.js" supervise
)
