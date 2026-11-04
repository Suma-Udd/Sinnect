# Installs Sinnect-Setup.exe on a Windows runner the way a person would
# (clicking through each page), launches the app, and screenshots the whole
# thing every half second so we can see it worked.
param([string]$Installer = "Sinnect-Setup.exe", [string]$Out = "smoke")

$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$script:n = 0

function Shot {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $Out ("{0:D4}.png" -f $script:n)), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $script:n++
}
function Film([double]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) { Shot; Start-Sleep -Milliseconds 400 }
}
function Press([int]$procId, [string]$keys) {
  try { [Microsoft.VisualBasic.Interaction]::AppActivate($procId) } catch {}
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}

Write-Host "Screen:" ([System.Windows.Forms.Screen]::PrimaryScreen.Bounds)
Film 1
$p = Start-Process -FilePath $Installer -PassThru
Film 4
# Welcome -> Install location -> Start menu folder (Install)
for ($i = 0; $i -lt 3; $i++) { Press $p.Id "{ENTER}"; Film 3 }
# Wait for the files to copy and the Finish page to show up
Film 25
# Finish page: "Run Sinnect" is ticked, Enter closes it and opens the app
Press $p.Id "{ENTER}"
Film 14

Write-Host "Installed files:"
Get-ChildItem "$env:LOCALAPPDATA\Sinnect" -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  " $_.Name $_.Length }
Write-Host "Installer still running:" (-not $p.HasExited)
if (-not (Get-Process -Name sinnect -ErrorAction SilentlyContinue)) {
  Write-Host "App not open after Finish, opening it from the Start menu shortcut path"
  $exe = Join-Path $env:LOCALAPPDATA "Sinnect\sinnect.exe"
  if (Test-Path $exe) { Start-Process $exe; Film 14 }
}
$app = Get-Process -Name sinnect -ErrorAction SilentlyContinue
$node = Get-Process -Name node* -ErrorAction SilentlyContinue
Write-Host "Sinnect running:" ([bool]$app) " engine running:" ([bool]$node)
Get-Process | Where-Object { $_.Name -match 'sinnect|node|msedgewebview2' } | ForEach-Object { Write-Host "  proc" $_.Name $_.Id }
if (-not $app) { Write-Error "Sinnect did not start"; exit 1 }
if (-not $node) { Write-Error "The engine did not start"; exit 1 }
