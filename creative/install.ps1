# Creative Studio install for this PC (RTX 5090). Re-runnable: skips files that already exist.
# Licences: everything here is Apache-2.0 / MIT (checked 2026-11-06), so it's OK for commercial apps.
$ErrorActionPreference = 'Stop'
$Root  = 'C:\AI'
$Comfy = "$Root\ComfyUI_windows_portable"
New-Item -ItemType Directory -Force $Root | Out-Null

# 1. ComfyUI portable (official build, PyTorch cu130, supports RTX 50-series)
if (-not (Test-Path "$Comfy\run_nvidia_gpu.bat")) {
  $zip = "$Root\ComfyUI_windows_portable_nvidia.7z"
  if (-not (Test-Path $zip)) {
    curl.exe -L --fail -o $zip https://github.com/comfyanonymous/ComfyUI/releases/latest/download/ComfyUI_windows_portable_nvidia.7z
  }
  tar.exe -xf $zip -C $Root   # Windows 11 tar (libarchive) reads .7z
}
$M = "$Comfy\ComfyUI\models"

function Get-Model($repo, $file, $folder) {
  $name = Split-Path $file -Leaf
  $dest = "$M\$folder\$name"
  if (Test-Path $dest) { Write-Host "have  $name"; return }
  New-Item -ItemType Directory -Force "$M\$folder" | Out-Null
  Write-Host "fetch $name"
  # No resume (-C -): a resumed download corrupted two files on 2026-11-07 (same size, wrong bytes).
  curl.exe -L --fail -o "$dest.part" "https://huggingface.co/$repo/resolve/main/$file"
  # Verify against Hugging Face's published SHA-256 before accepting the file.
  $dir = Split-Path $file -Parent
  $want = ((curl.exe -sL "https://huggingface.co/api/models/$repo/tree/main/$dir" | ConvertFrom-Json) | Where-Object { $_.path -eq $file }).lfs.oid
  $got = (Get-FileHash "$dest.part" -Algorithm SHA256).Hash.ToLower()
  if ($want -and $got -ne $want) { Remove-Item "$dest.part"; throw "Checksum mismatch for $name (got $got, want $want). Re-run to retry." }
  Move-Item "$dest.part" $dest
}

# 2. Image generation: Z-Image-Turbo (fast, Apache-2.0)
Get-Model 'Comfy-Org/z_image_turbo' 'split_files/diffusion_models/z_image_turbo_bf16.safetensors' 'diffusion_models'
Get-Model 'Comfy-Org/z_image_turbo' 'split_files/text_encoders/qwen_3_4b.safetensors'             'text_encoders'
Get-Model 'Comfy-Org/z_image_turbo' 'split_files/vae/ae.safetensors'                              'vae'

# 3. Image editing: Qwen-Image-Edit-2511 fp8 (Apache-2.0)
Get-Model 'Comfy-Org/Qwen-Image-Edit_ComfyUI' 'split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors' 'diffusion_models'
Get-Model 'Comfy-Org/Qwen-Image_ComfyUI'      'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors'      'text_encoders'
Get-Model 'Comfy-Org/Qwen-Image_ComfyUI'      'split_files/vae/qwen_image_vae.safetensors'                          'vae'

# 4. Video: Wan2.2 TI2V 5B (text- and image-to-video in one model, Apache-2.0)
Get-Model 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged' 'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors'       'diffusion_models'
Get-Model 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged' 'split_files/vae/wan2.2_vae.safetensors'                            'vae'
Get-Model 'Comfy-Org/Wan_2.1_ComfyUI_repackaged' 'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'  'text_encoders'

# 5. Audio + background removal, in ComfyUI's bundled Python (3.13 + CUDA torch)
$Py = "$Comfy\python_embeded\python.exe"
# Note: use kokoro-onnx, NOT kokoro. On Python 3.13, `kokoro` backtracks to an old release pinning
# numpy 1.26.4, which has no py3.13 wheel and would downgrade ComfyUI's numpy if it ever built.
& $Py -m pip install --quiet soundfile faster-whisper "rembg[gpu]" kokoro-onnx
Write-Host 'Creative Studio install complete.'
