# WinRT OCR bridge (called by src/lib/ocr.js)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -ImagePath <png> [-Lang zh-CN]
# Output: single-line JSON on stdout: { ok, lang?, lines?, code?, detail? }
# NOTE: keep this file ASCII-only (PowerShell 5.1 parses non-BOM UTF-8 literals unreliably)
param(
  [string]$ImagePath = '',
  [string]$Lang = '',
  [double]$Scale = 0,
  [string]$Interp = 'bicubic'
)
$ErrorActionPreference = 'Stop'

function Write-Result($obj) {
  $obj | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

  if (-not (Test-Path -LiteralPath $ImagePath)) { Write-Result @{ ok = $false; code = 'file_not_found' } }

  # Project WinRT namespaces (Windows PowerShell 5.1 only; pwsh 7 dropped this projection)
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime]
  Add-Type -AssemblyName System.Runtime.WindowsRuntime

  # WinRT IAsyncOperation -> .NET Task await helper
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($WinRtOp, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtOp))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }

  # Fixed 2x upscale (bicubic): best accuracy trade-off for small UI text, verified
  # empirically - 12px Chinese goes from ~30% correct at 1x to ~100% at 2x; 3x degrades
  # again. Guard: keep output long side <= 8000px (engine dimension limits / speed).
  $factor = 2
  if ($Scale -gt 1) { $factor = $Scale }
  try {
    Add-Type -AssemblyName System.Drawing
    $img0 = [System.Drawing.Image]::FromFile($ImagePath)
    $long = [Math]::Max($img0.Width, $img0.Height)
    $img0.Dispose()
    if ($long * $factor -gt 8000) { $factor = [Math]::Max(1, 8000 / $long) }
  } catch { }

  $bytes = [System.IO.File]::ReadAllBytes($ImagePath)
  if ($factor -gt 1.05) {
    try {
      Add-Type -AssemblyName System.Drawing
      $img = [System.Drawing.Image]::FromFile($ImagePath)
      $w = [int][Math]::Round($img.Width * $factor)
      $h = [int][Math]::Round($img.Height * $factor)
      $scaledBmp = New-Object System.Drawing.Bitmap($w, $h)
      $g = [System.Drawing.Graphics]::FromImage($scaledBmp)
      $mode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      if ($Interp -eq 'nearest') { $mode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor }
      elseif ($Interp -eq 'bilinear') { $mode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear }
      $g.InterpolationMode = $mode
      $g.DrawImage($img, 0, 0, $w, $h)
      $g.Dispose()
      $ms = New-Object System.IO.MemoryStream
      $scaledBmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $bytes = $ms.ToArray()
      $scaledBmp.Dispose()
      $img.Dispose()
      $ms.Dispose()
    } catch { $bytes = [System.IO.File]::ReadAllBytes($ImagePath) }
  }

  # Decode image bytes into a SoftwareBitmap
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
  $writer.WriteBytes($bytes)
  Await ($writer.StoreAsync()) ([UInt32]) | Out-Null
  Await ($writer.FlushAsync()) ([Boolean]) | Out-Null
  $writer.DetachStream() | Out-Null

  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  function New-Engine([string]$tag) {
    try {
      if (-not $tag) { return $null }
      return [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($tag)))
    } catch { return $null }
  }

  # Language pick: requested tag -> any zh -> user profile languages -> first available
  $engine = New-Engine $Lang
  if (-not $engine) {
    $avail = @()
    try { $avail = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) } catch { $avail = @() }
    $zh = $avail | Where-Object { $_.LanguageTag -like 'zh*' } | Select-Object -First 1
    if ($zh) { $engine = New-Engine $zh.LanguageTag }
  }
  if (-not $engine) {
    try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
  }
  if (-not $engine) { Write-Result @{ ok = $false; code = 'no_language' } }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object { $_.Text })
  Write-Result @{ ok = $true; lang = $engine.RecognizerLanguage.LanguageTag; lines = $lines }
} catch {
  Write-Result @{ ok = $false; code = 'exception'; detail = $_.Exception.Message }
}
