param(
  [Parameter(Mandatory=$false)]
  [string]$Destination = "$env:APPDATA\ink-dictation\arabic-asr"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$PythonVersion = '3.12.10'
$OnnxAsrVersion = '0.12.0'
$ModelRepo = 'OpenVoiceOS/whisper-large-v3-turbo-arabic-dialectal-v2-onnx'
$PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"

function Write-Step([string]$Text) { Write-Output "[Ink] $Text" }

function Download-WithHttpClient([string]$Url, [string]$OutFile) {
  Add-Type -AssemblyName System.Net.Http
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $true
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromMinutes(30)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('Ink-Dictation/0.2.12')
  try {
    $response = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode()
    $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    try {
      $output = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
      try { $input.CopyTo($output) } finally { $output.Dispose() }
    } finally { $input.Dispose() }
  } finally {
    $client.Dispose(); $handler.Dispose()
  }
}

function Download-File([string]$Url, [string]$OutFile) {
  Write-Step "Downloading $(Split-Path -Leaf $OutFile)..."
  $partial = "$OutFile.partial"
  Remove-Item -Force $partial -ErrorAction SilentlyContinue
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source --location --fail --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 20 --output $partial $Url
    if ($LASTEXITCODE -eq 0 -and (Test-Path $partial) -and (Get-Item $partial).Length -gt 0) {
      Move-Item -Force $partial $OutFile
      return
    }
    Remove-Item -Force $partial -ErrorAction SilentlyContinue
  }
  Download-WithHttpClient -Url $Url -OutFile $partial
  Move-Item -Force $partial $OutFile
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$downloads = Join-Path $Destination 'downloads'
$privatePythonDir = Join-Path $Destination 'python'
$privatePythonExe = Join-Path $privatePythonDir 'python.exe'
$packagesDir = Join-Path $Destination 'python-packages'
$modelDir = Join-Path $Destination 'model'
$modelRuntimeDir = Join-Path $modelDir 'int8'
$marker = Join-Path $Destination 'arabic-asr.json'
$inkRoot = Split-Path $Destination -Parent
$translationPython = Join-Path $inkRoot 'translation\python\python.exe'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
New-Item -ItemType Directory -Force -Path $packagesDir | Out-Null

# Python's Windows installer treats a second install of the exact same version as
# maintenance of the first registered per-user install. Ink already installs
# Python 3.12.10 for Translation, so trying to install 3.12.10 again can return
# exit code 0 without creating arabic-asr\python\python.exe. Reuse Ink's existing
# private Translation runtime when available and keep Arabic dependencies isolated
# under python-packages via PYTHONPATH.
$pythonExe = $null
$runtimeSource = $null
if (Test-Path $privatePythonExe) {
  $pythonExe = $privatePythonExe
  $runtimeSource = 'arabic-private'
  Write-Step 'Arabic speech private Python runtime is already installed.'
} elseif (Test-Path $translationPython) {
  $pythonExe = $translationPython
  $runtimeSource = 'translation-shared'
  Write-Step 'Reusing Ink translation Python runtime for the Arabic speech pack.'
} else {
  Write-Step 'Installing private runtime for the Arabic dialect speech pack...'
  $installer = Join-Path $downloads "python-$PythonVersion-amd64.exe"
  if (-not (Test-Path $installer)) { Download-File -Url $PythonUrl -OutFile $installer }
  New-Item -ItemType Directory -Force -Path $privatePythonDir | Out-Null
  $arguments = @('/quiet','InstallAllUsers=0',"TargetDir=$privatePythonDir",'Include_launcher=0','Include_test=0','Include_doc=0','Include_pip=1','PrependPath=0','Shortcuts=0')
  $proc = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru
  if ($proc.ExitCode -ne 0) { throw "Private Python installation failed with exit code $($proc.ExitCode)." }

  if (Test-Path $privatePythonExe) {
    $pythonExe = $privatePythonExe
    $runtimeSource = 'arabic-private'
    Remove-Item -Force $installer -ErrorAction SilentlyContinue
  } elseif (Test-Path $translationPython) {
    # This is the exact maintenance-mode case reported by a real 0.2.9 install.
    $pythonExe = $translationPython
    $runtimeSource = 'translation-shared'
    Write-Step 'Python setup completed but Windows reused Ink translation Python; continuing with that runtime.'
  } else {
    throw "Python setup returned exit code 0 but no usable Python runtime was found. Install the Ink translation engine once, then retry the Arabic speech pack."
  }
}

if (-not (Test-Path $pythonExe)) { throw 'Ink could not find a usable Python runtime for the Arabic speech pack.' }

$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PYTHONUTF8 = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$oldPythonPath = $env:PYTHONPATH
$env:PYTHONPATH = if ([string]::IsNullOrWhiteSpace($oldPythonPath)) { $packagesDir } else { "$packagesDir;$oldPythonPath" }

Write-Step 'Checking pip...'
& $pythonExe -m pip --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The selected Ink Python runtime does not have pip available.' }

Write-Step "Installing isolated ONNX speech runtime (onnx-asr $OnnxAsrVersion)..."
& $pythonExe -m pip install --upgrade --quiet --no-warn-script-location --target $packagesDir "onnx-asr[cpu,hub]==$OnnxAsrVersion"
if ($LASTEXITCODE -ne 0) { throw 'Arabic ONNX speech runtime installation failed.' }

$requiredModelFiles = @(
  'vocab.json',
  'added_tokens.json',
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'encoder_model_int8.onnx',
  'encoder_model_int8.onnx.data',
  'decoder_model_merged_int8.onnx',
  'decoder_model_merged_int8.onnx.data'
)
$modelComplete = $true
foreach ($name in $requiredModelFiles) {
  if (-not (Test-Path (Join-Path $modelRuntimeDir $name))) { $modelComplete = $false; break }
}

if ($modelComplete) {
  Write-Step 'Arabic dialect model files are already downloaded; reusing them.'
} else {
  Write-Step 'Downloading Arabic dialect model (~1.4 GB, one time)...'
  $downloadCode = @"
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='$ModelRepo',
    allow_patterns=['int8/*'],
    local_dir=r'''$modelDir''',
)
"@
  & $pythonExe -c $downloadCode
  if ($LASTEXITCODE -ne 0) { throw 'Arabic dialect model download failed.' }
}

$encoder = Join-Path $modelRuntimeDir 'encoder_model_int8.onnx.data'
$decoder = Join-Path $modelRuntimeDir 'decoder_model_merged_int8.onnx.data'
$vocab = Join-Path $modelRuntimeDir 'vocab.json'
$tokens = Join-Path $modelRuntimeDir 'added_tokens.json'
if (-not (Test-Path $encoder) -or (Get-Item $encoder).Length -lt 500MB) { throw 'Arabic dialect encoder download is incomplete.' }
if (-not (Test-Path $decoder) -or (Get-Item $decoder).Length -lt 500MB) { throw 'Arabic dialect decoder download is incomplete.' }
if (-not (Test-Path $vocab)) { throw 'Arabic dialect vocabulary is missing from the INT8 model folder.' }
if (-not (Test-Path $tokens)) { throw 'Arabic dialect added-token vocabulary is missing from the INT8 model folder.' }

Write-Step 'Validating Arabic dialect model...'
$checkCode = @"
import onnx_asr
m = onnx_asr.load_model('whisper', r'''$modelRuntimeDir''', quantization='int8', providers=['CPUExecutionProvider'])
print('ok')
"@
$checkOutput = & $pythonExe -c $checkCode 2>&1
$validationExitCode = $LASTEXITCODE
$check = ($checkOutput | Out-String).Trim()
if ($validationExitCode -ne 0 -or $check -notmatch 'ok') {
  throw "Arabic dialect model could not be loaded after installation. $check"
}

$metadata = [ordered]@{
  pythonVersion = $PythonVersion
  pythonPath = $pythonExe
  packagesPath = $packagesDir
  runtimeSource = $runtimeSource
  runtime = "onnx-asr $OnnxAsrVersion"
  model = 'oddadmix whisper-large-v3-turbo Arabic dialectal v2 · ONNX INT8'
  modelPath = $modelRuntimeDir
  sourceRepo = $ModelRepo
  dialects = 13
  installedAt = (Get-Date).ToString('o')
}
$json = $metadata | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($marker, $json, $utf8NoBom)
Write-Step 'Arabic dialect speech pack ready.'
Write-Step 'It covers Gulf/Saudi, Iraqi, Egyptian, Syrian, Bahraini, Yemeni, Palestinian, Lebanese, Libyan, Tunisian, Algerian, Moroccan, and Sudanese speech.'
