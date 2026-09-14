param(
  [Parameter(Mandatory=$false)]
  [string]$Destination = "$env:APPDATA\ink-dictation\runtime",

  [Parameter(Mandatory=$false)]
  [ValidateSet('auto','cuda','cpu')]
  [string]$Backend = 'auto'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Version = '1.9.1'
$EnglishModelName = 'ggml-base.en.bin'
$MultilingualModelName = 'ggml-base.bin'
$BilingualModelName = 'ggml-large-v3-turbo-q5_0.bin'
$EnglishModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$EnglishModelName"
$MultilingualModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MultilingualModelName"
$BilingualModelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$BilingualModelName"
$EnglishModelSha1 = '137c40403d78fd54d454da0f9bd998f78703390c'
$MultilingualModelSha1 = '465707469ff3a37a2b9b8d8f89f2f99de7299dac'
$BilingualModelSha1 = 'e050f7970618a659205450ad97eb95a18d69c9ee'
$CpuUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/v$Version/whisper-bin-x64.zip"
$CudaUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/v$Version/whisper-cublas-12.4.0-bin-x64.zip"

function Write-Step([string]$Text) {
  Write-Output "[Ink] $Text"
}

function Test-Nvidia {
  try {
    $null = Get-Command nvidia-smi -ErrorAction Stop
    $name = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
    return -not [string]::IsNullOrWhiteSpace($name)
  } catch {
    return $false
  }
}

function Get-Sha1Hex([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try {
      return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

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
      try {
        $input.CopyTo($output)
      } finally {
        $output.Dispose()
      }
    } finally {
      $input.Dispose()
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Download-File([string]$Url, [string]$OutFile) {
  Write-Step "Downloading $(Split-Path -Leaf $OutFile)..."
  $partial = "$OutFile.partial"
  Remove-Item -Force $partial -ErrorAction SilentlyContinue

  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    Write-Step 'Using Windows curl with redirect + retry support.'
    & $curl.Source --location --fail --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 20 --output $partial $Url
    if ($LASTEXITCODE -eq 0 -and (Test-Path $partial) -and (Get-Item $partial).Length -gt 0) {
      Move-Item -Force $partial $OutFile
      return
    }
    Remove-Item -Force $partial -ErrorAction SilentlyContinue
    Write-Step 'curl download failed; trying the .NET HTTPS downloader.'
  }

  try {
    Download-WithHttpClient -Url $Url -OutFile $partial
    if (-not (Test-Path $partial) -or (Get-Item $partial).Length -eq 0) {
      throw 'The download completed without creating a usable file.'
    }
    Move-Item -Force $partial $OutFile
  } catch {
    Remove-Item -Force $partial -ErrorAction SilentlyContinue
    throw
  }
}

function Ensure-Model(
  [string]$Name,
  [string]$Url,
  [string]$ExpectedSha1,
  [string]$ModelDirectory
) {
  $path = Join-Path $ModelDirectory $Name
  $needsDownload = $true

  if (Test-Path $path) {
    $size = (Get-Item $path).Length
    if ($size -gt 100MB) {
      Write-Step "Checking existing $Name..."
      try {
        if ((Get-Sha1Hex $path) -eq $ExpectedSha1) {
          Write-Step "$Name is already installed; keeping it."
          $needsDownload = $false
        } else {
          Write-Step "$Name did not pass verification; downloading a clean copy."
        }
      } catch {
        Write-Step "$Name could not be verified; downloading a clean copy."
      }
    }
  }

  if ($needsDownload) {
    Remove-Item -Force $path -ErrorAction SilentlyContinue
    Download-File -Url $Url -OutFile $path
    if ((Get-Item $path).Length -lt 100MB) {
      Remove-Item -Force $path -ErrorAction SilentlyContinue
      throw "$Name downloaded, but the file is unexpectedly small."
    }
    Write-Step "Verifying $Name..."
    if ((Get-Sha1Hex $path) -ne $ExpectedSha1) {
      Remove-Item -Force $path -ErrorAction SilentlyContinue
      throw "$Name failed integrity verification. Please retry setup."
    }
    Write-Step "$Name ready."
  }
}

function Write-Metadata([string]$Path, [string]$ResolvedBackend, [bool]$ServerReady, [bool]$EnglishReady, [bool]$MultiReady, [bool]$BilingualReady) {
  $metadata = [ordered]@{
    version = $Version
    backend = $ResolvedBackend
    models = @($EnglishModelName, $MultilingualModelName, $BilingualModelName)
    serverReady = $ServerReady
    englishModelReady = $EnglishReady
    multilingualModelReady = $MultiReady
    bilingualModelReady = $BilingualReady
    installedAt = (Get-Date).ToString('o')
  }
  $metadata | ConvertTo-Json | Set-Content -Path $Path -Encoding UTF8
}

$resolvedBackend = $Backend
if ($Backend -eq 'auto') {
  $resolvedBackend = if (Test-Nvidia) { 'cuda' } else { 'cpu' }
}

Write-Step "Destination: $Destination"
Write-Step "Selected backend: $resolvedBackend"

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$downloads = Join-Path $Destination 'downloads'
$engineDir = Join-Path $Destination 'engine'
$modelDir = Join-Path $Destination 'models'
$metadataPath = Join-Path $Destination 'engine.json'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null

$existingMetadata = $null
if (Test-Path $metadataPath) {
  try { $existingMetadata = Get-Content $metadataPath -Raw | ConvertFrom-Json } catch {}
}
if ($existingMetadata -and $existingMetadata.backend -in @('cuda','cpu')) {
  $resolvedBackend = $existingMetadata.backend
  Write-Step "Keeping the existing $resolvedBackend engine backend."
}

$exe = Get-ChildItem -Path $engineDir -Recurse -Filter 'whisper-cli.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$serverExe = Get-ChildItem -Path $engineDir -Recurse -Filter 'whisper-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe -or -not $serverExe) {
  if ($exe -and -not $serverExe) {
    Write-Step 'Your existing whisper.cpp runtime predates Ink persistent speech. Repairing the runtime once for faster dictation.'
  }
  $zipPath = Join-Path $downloads "whisper-$resolvedBackend-$Version.zip"
  $engineUrl = if ($resolvedBackend -eq 'cuda') { $CudaUrl } else { $CpuUrl }

  try {
    Download-File -Url $engineUrl -OutFile $zipPath
  } catch {
    if ($resolvedBackend -eq 'cuda') {
      Write-Step 'CUDA package download failed; falling back to CPU.'
      $resolvedBackend = 'cpu'
      $engineUrl = $CpuUrl
      $zipPath = Join-Path $downloads "whisper-cpu-$Version.zip"
      Download-File -Url $engineUrl -OutFile $zipPath
    } else {
      throw
    }
  }

  Write-Step 'Extracting whisper.cpp...'
  Remove-Item -Recurse -Force $engineDir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $engineDir -Force
  $exe = Get-ChildItem -Path $engineDir -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
  $serverExe = Get-ChildItem -Path $engineDir -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
  if (-not $exe) { throw 'whisper-cli.exe was not found after extraction.' }
  if (-not $serverExe) { throw 'whisper-server.exe was not found after extraction. Ink 0.2.1 needs it for fast persistent dictation.' }
  Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
} else {
  Write-Step 'whisper.cpp CLI + persistent server are already installed; skipping the engine download.'
}

Write-Step "CLI ready: $($exe.FullName)"
Write-Step "Persistent speech server ready: $($serverExe.FullName)"
Write-Metadata -Path $metadataPath -ResolvedBackend $resolvedBackend -ServerReady $true -EnglishReady (Test-Path (Join-Path $modelDir $EnglishModelName)) -MultiReady (Test-Path (Join-Path $modelDir $MultilingualModelName)) -BilingualReady (Test-Path (Join-Path $modelDir $BilingualModelName))

Write-Step 'Installing English speech model (1 of 3)...'
Ensure-Model -Name $EnglishModelName -Url $EnglishModelUrl -ExpectedSha1 $EnglishModelSha1 -ModelDirectory $modelDir
Write-Step 'Installing multilingual speech model (2 of 3)...'
Ensure-Model -Name $MultilingualModelName -Url $MultilingualModelUrl -ExpectedSha1 $MultilingualModelSha1 -ModelDirectory $modelDir
Write-Step 'Installing English + Swedish bilingual model (3 of 3)...'
Ensure-Model -Name $BilingualModelName -Url $BilingualModelUrl -ExpectedSha1 $BilingualModelSha1 -ModelDirectory $modelDir

Write-Metadata -Path $metadataPath -ResolvedBackend $resolvedBackend -ServerReady $true -EnglishReady $true -MultiReady $true -BilingualReady $true
Write-Step 'Speech engine installation complete.'
Write-Step 'Ink is ready for fast persistent local dictation.'
