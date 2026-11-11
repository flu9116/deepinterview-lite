param([switch]$Installed)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataRoot = $ProjectRoot
if ($Installed) {
  $DataRoot = Join-Path $env:APPDATA 'DeepInterviewLite-Installed'
  New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
  $env:HF_HOME = Join-Path $DataRoot 'hf-cache'
  Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue
}
$VenvPath = Join-Path $DataRoot '.venv-kokoro'
$PythonPath = Join-Path $VenvPath 'Scripts\python.exe'

if (-not (Test-Path -LiteralPath $PythonPath)) {
  py -3.12 -m venv $VenvPath
  if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 virtual environment creation failed.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $VenvPath 'deepinterview-kokoro-ready'))) {
  & $PythonPath -m pip install --upgrade pip
  if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed.' }
  & $PythonPath -m pip install -r (Join-Path $ProjectRoot 'tts_server\requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Kokoro dependency installation failed.' }
  & $PythonPath -m pip install --no-deps 'kokoro==0.9.4' 'misaki==0.9.4'
  if ($LASTEXITCODE -ne 0) { throw 'Kokoro installation failed.' }
  New-Item -ItemType File -Path (Join-Path $VenvPath 'deepinterview-kokoro-ready') -Force | Out-Null
}

Set-Location $ProjectRoot
& $PythonPath -m uvicorn tts_server.app:app --host 127.0.0.1 --port 8787

