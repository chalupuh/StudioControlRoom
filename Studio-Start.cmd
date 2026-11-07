@echo off
rem Start the studio back up (Ollama + Control Room). Work stays paused until you flip the switch.
node "%~dp0studio\studio.js" startup
start "" http://localhost:4777
