@echo off
rem Game mode: checkpoint agents, stop local models, ComfyUI and the Control Room. Frees the GPU.
node "%~dp0studio\studio.js" shutdown
pause
