param(
  [Parameter(Mandatory=$false)]
  [string]$Destination = "$env:APPDATA\ink-dictation\translation"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$PythonVersion = '3.12.10'
$ArgosVersion = '1.11.0'
$PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe"

function Write-Step([string]$Text) {
  Write-Output "[Ink] $Text"
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
      try { $input.CopyTo($output) } finally { $output.Dispose() }
    } finally { $input.Dispose() }
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
$pythonDir = Join-Path $Destination 'python'
$pythonExe = Join-Path $pythonDir 'python.exe'
$marker = Join-Path $Destination 'translation.json'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Destination 'packages') | Out-Null

if (-not (Test-Path $pythonExe)) {
  Write-Step 'Installing Ink private Python runtime...'
  $installer = Join-Path $downloads "python-$PythonVersion-amd64.exe"
  if (-not (Test-Path $installer)) { Download-File -Url $PythonUrl -OutFile $installer }
  New-Item -ItemType Directory -Force -Path $pythonDir | Out-Null
  $arguments = @(
    '/quiet',
    'InstallAllUsers=0',
    "TargetDir=$pythonDir",
    'Include_launcher=0',
    'Include_test=0',
    'Include_doc=0',
    'Include_pip=1',
    'PrependPath=0',
    'Shortcuts=0'
  )
  $proc = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru
  if ($proc.ExitCode -ne 0 -or -not (Test-Path $pythonExe)) {
    throw "Private Python installation failed with exit code $($proc.ExitCode)."
  }
  Remove-Item -Force $installer -ErrorAction SilentlyContinue
} else {
  Write-Step 'Ink private Python runtime is already installed.'
}

$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PYTHONUTF8 = '1'
Write-Step 'Updating pip...'
& $pythonExe -m pip install --upgrade --quiet --no-warn-script-location pip
if ($LASTEXITCODE -ne 0) { throw 'pip update failed.' }

Write-Step "Installing offline translation engine (Argos Translate $ArgosVersion)..."
& $pythonExe -m pip install --upgrade --quiet --no-warn-script-location "argostranslate==$ArgosVersion"
if ($LASTEXITCODE -ne 0) { throw 'Argos Translate installation failed.' }

Write-Step 'Checking translation engine...'
$version = (& $pythonExe -c "import argostranslate, importlib.metadata; print(importlib.metadata.version('argostranslate'))").Trim()
if ([string]::IsNullOrWhiteSpace($version)) { throw 'Argos Translate could not be imported after installation.' }

Write-Step 'Caching translation language catalog...'
& $pythonExe -c "import argostranslate.package as p; p.update_package_index()"
if ($LASTEXITCODE -ne 0) { Write-Step 'Language catalog cache could not be refreshed now; Ink will retry when needed.' }

$metadata = [ordered]@{
  pythonVersion = $PythonVersion
  argosVersion = $version
  installedAt = (Get-Date).ToString('o')
}
$metadata | ConvertTo-Json | Set-Content -Path $marker -Encoding UTF8
Write-Step "Translation engine ready (Argos $version)."
Write-Step 'Language packs are downloaded on demand from Ink Settings or the first time a language is used.'
