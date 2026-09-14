param(
  [Parameter(Mandatory=$false)]
  [string]$Destination = "$env:APPDATA\ink-dictation\translation"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'cstr/madlad400-3b-ct2-int8'
$pythonExe = Join-Path $Destination 'python\python.exe'
$modelDir = Join-Path $Destination 'madlad400-3b-int8'
$marker = Join-Path $Destination 'madlad.json'
$modelBin = Join-Path $modelDir 'model.bin'

function Write-Step([string]$Text) { Write-Output "[Ink] $Text" }

if (-not (Test-Path $pythonExe)) {
  throw 'Install the Ink translation engine first. The private Python runtime is missing.'
}

$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PYTHONUTF8 = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:HF_HOME = Join-Path $Destination 'hf-cache'

Write-Step 'Installing high-quality translation dependencies...'
& $pythonExe -m pip install --upgrade --quiet --no-warn-script-location sentencepiece huggingface_hub
if ($LASTEXITCODE -ne 0) { throw 'Could not install the high-quality translation dependencies.' }

if ((Test-Path $modelBin) -and (Get-Item $modelBin).Length -gt 2000000000) {
  Write-Step 'MADLAD-400 high-quality model is already downloaded.'
} else {
  New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
  $downloadScript = Join-Path $Destination 'download-madlad.py'
  @"
from huggingface_hub import snapshot_download
print('[Ink] Downloading MADLAD-400 3B INT8 (~3 GB). This is a one-time download...', flush=True)
snapshot_download(
    repo_id='$Repo',
    local_dir=r'''$modelDir''',
    allow_patterns=['model.bin','config.json','shared_vocabulary.json','spiece.model','sentencepiece.model','tokenizer.json','tokenizer_config.json','special_tokens_map.json','added_tokens.json'],
)
print('[Ink] High-quality translation model downloaded.', flush=True)
"@ | Set-Content -Path $downloadScript -Encoding UTF8
  & $pythonExe -u $downloadScript
  $exit = $LASTEXITCODE
  Remove-Item -Force $downloadScript -ErrorAction SilentlyContinue
  if ($exit -ne 0) { throw 'MADLAD-400 model download failed. Retry keeps completed Hugging Face downloads.' }
}

if (-not (Test-Path $modelBin)) { throw 'MADLAD model.bin is missing after download.' }
$tokenizer = Join-Path $modelDir 'spiece.model'
if (-not (Test-Path $tokenizer)) { $tokenizer = Join-Path $modelDir 'sentencepiece.model' }
if (-not (Test-Path $tokenizer)) { throw 'MADLAD tokenizer model is missing after download.' }

Write-Step 'Checking MADLAD model files...'
& $pythonExe -c "import ctranslate2, sentencepiece; print('CTranslate2', ctranslate2.__version__)"
if ($LASTEXITCODE -ne 0) { throw 'MADLAD dependencies could not be imported.' }

$metadata = [ordered]@{
  repo = $Repo
  model = 'MADLAD-400-3B-MT INT8'
  installedAt = (Get-Date).ToString('o')
}
$metadata | ConvertTo-Json | Set-Content -Path $marker -Encoding UTF8
Write-Step 'High-quality multilingual translation is ready.'
