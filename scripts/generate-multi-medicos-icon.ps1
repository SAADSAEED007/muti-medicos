param(
  [string]$Source = "public\Multi Medicos Pharmacy Logo.png",
  [string]$IconOutput = "assets\images\multi-medicos.ico",
  [string]$PngOutput = "assets\images\multi-medicos-icon.png"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$sourceImage = [System.Drawing.Bitmap]::FromFile($sourcePath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = [System.Collections.Generic.List[byte[]]]::new()

try {
  # The emblem occupies x=77..499 and y=148..561 in the supplied transparent logo.
  # A small transparent margin keeps it readable at Windows shortcut sizes.
  $crop = [System.Drawing.Rectangle]::new(57, 128, 462, 454)

  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $padding = [Math]::Max(1, [Math]::Round($size * 0.055))
        $destination = [System.Drawing.Rectangle]::new($padding, $padding, $size - (2 * $padding), $size - (2 * $padding))
        $graphics.DrawImage($sourceImage, $destination, $crop, [System.Drawing.GraphicsUnit]::Pixel)
      } finally {
        $graphics.Dispose()
      }

      if ($size -eq 256) {
        $pngDirectory = Split-Path -Parent $PngOutput
        if ($pngDirectory) { New-Item -ItemType Directory -Path $pngDirectory -Force | Out-Null }
        $bitmap.Save($PngOutput, [System.Drawing.Imaging.ImageFormat]::Png)
      }

      $stream = [System.IO.MemoryStream]::new()
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $images.Add($stream.ToArray())
      } finally {
        $stream.Dispose()
      }
    } finally {
      $bitmap.Dispose()
    }
  }
} finally {
  $sourceImage.Dispose()
}

$iconDirectory = Split-Path -Parent $IconOutput
if ($iconDirectory) { New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null }
$file = [System.IO.File]::Open($IconOutput, [System.IO.FileMode]::Create)
$writer = [System.IO.BinaryWriter]::new($file)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$sizes.Count)
  $offset = 6 + (16 * $sizes.Count)

  for ($index = 0; $index -lt $sizes.Count; $index++) {
    $size = $sizes[$index]
    $payload = $images[$index]
    $writer.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
    $writer.Write([byte]($(if ($size -eq 256) { 0 } else { $size })))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$payload.Length)
    $writer.Write([uint32]$offset)
    $offset += $payload.Length
  }

  foreach ($payload in $images) { $writer.Write($payload) }
} finally {
  $writer.Dispose()
  $file.Dispose()
}

Write-Output "Created $IconOutput and $PngOutput from $Source"
