# Creates a desktop shortcut "OpenSCAD Studio" that launches start.bat
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'OpenSCAD Studio.lnk'
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sh.TargetPath = Join-Path $root 'start.bat'
$sh.WorkingDirectory = $root
$sh.WindowStyle = 7   # minimized
$oscad = 'C:\Program Files\OpenSCAD\openscad.exe'
if (Test-Path $oscad) { $sh.IconLocation = $oscad }
$sh.Save()
Write-Host "Created $lnk"