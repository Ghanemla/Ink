param(
  [Parameter(Mandatory=$true)]
  [string]$TextPath,

  [Parameter(Mandatory=$false)]
  [string]$Language = 'en'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$text = Get-Content -LiteralPath $TextPath -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($text)) { throw 'There is no translated text to play.' }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $requested = ($Language -replace '_','-').ToLowerInvariant()
  $short = ($requested -split '-')[0]
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
  $match = $voices | Where-Object {
    $culture = $_.VoiceInfo.Culture
    $culture.Name.ToLowerInvariant() -eq $requested -or
    $culture.TwoLetterISOLanguageName.ToLowerInvariant() -eq $short
  } | Select-Object -First 1

  if (-not $match) {
    throw "No installed Windows text-to-speech voice matches '$Language'. Add that language's Speech voice in Windows Settings, then try again."
  }

  $synth.SelectVoice($match.VoiceInfo.Name)
  $synth.Rate = 0
  $synth.Volume = 100
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
