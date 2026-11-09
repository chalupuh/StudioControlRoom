@echo off
REM Wrapper: sets STUDIO_HOME (HQ checkout) then runs the supervisor.
REM Called by the StudioSupervisor Scheduled Task.
REM   %~1 = STUDIO_HOME path (quoted)
REM   %~2 = node.exe path (quoted)
set "STUDIO_HOME=%~1"
"%~2" "%~dp0studio.js" supervise
