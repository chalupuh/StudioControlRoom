# Creative tools (local ComfyUI)

ComfyUI lives in `C:\AI\ComfyUI_windows_portable`. Start it with `powershell -ExecutionPolicy Bypass -File tools/creative/start-comfy.ps1`
(headless, 127.0.0.1:8188, log `C:\AI\comfy.log`; adds `--lowvram` automatically when free VRAM < 14 GB).

## comfy.js
`node tools/creative/comfy.js image --prompt "<p>" --w 768 --h 768 --out assets/x/y.png [--seed N] [--steps 8]`

Z-Image-Turbo text-to-image (workflow: `workflows/z_image_turbo.json`, API format). One job at a time; retries on OOM.
Not implemented yet (exit with an error): `edit`, `upscale`, `rmbg`, `i2v`, `t2v`.
Env: `COMFY_URL` overrides the server address.

## Known issue (2026-11-06)
Z-Image-Turbo output on this machine (RTX 5090, torch 2.14.1+cu130, ComfyUI 0.44.0) is corrupted: images ignore the prompt and show
blocky artifacts and garbled text, regardless of --lowvram, dynamic VRAM on/off, async offload, fp32 text-encoder/unet/vae,
pytorch attention, sampler (res_multistep/euler), 8-28 steps, cfg 1-4, 768 or 1024. Model files are complete (headers valid).
Portraits are blocked until this is resolved (try a different torch build or re-download the weights).
