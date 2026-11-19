# Installs or updates T3 Code on Windows x64 from the get-aix/t3code releases.
# The installer is unsigned. PowerShell downloads carry no Mark of the Web, so
# SmartScreen never checks the file, and the per-user install needs no admin.
# Usage: irm <release>/install-windows.ps1 | iex   ($env:T3CODE_VERSION = "1.2.3" pins a version)
& {
  $ErrorActionPreference = "Stop"
  # Windows PowerShell 5.1 renders the progress bar so slowly that it throttles downloads.
  $ProgressPreference = "SilentlyContinue"
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = "get-aix/t3code"

  try {
    if ($env:OS -ne "Windows_NT") { throw "this installer is for Windows." }
    if (-not [Environment]::Is64BitOperatingSystem) { throw "only 64-bit Windows is supported." }

    # An elevated per-user install lands in the elevated account's profile and starts T3 Code as admin.
    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw "run this from a normal PowerShell window, not as administrator. T3 Code installs for your user only."
    }

    $version = $env:T3CODE_VERSION
    if (-not $version) {
      $version = (Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repo/releases/latest").tag_name -replace "^v", ""
    }
    if ($version -notmatch '^\d+\.\d+\.\d+(-aix\.\d+)?$') { throw "could not resolve a release version (got '$version')." }

    # The silent installer kills a running app without asking, which would stop its agents mid-turn.
    $running = Get-Process -Name "T3 Code", "T3 Code (Alpha)", "T3 Code (Beta)", "T3 Code (Nightly)" -ErrorAction SilentlyContinue
    if ($running) { throw "T3 Code is running; quit it and run this again." }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) "t3code-install-$([Guid]::NewGuid())"
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      $exe = "T3-Code-$version-x64.exe"
      $base = "https://github.com/$repo/releases/download/v$version"
      $path = Join-Path $tmp $exe

      Write-Host "Downloading T3 Code $version..."
      Invoke-WebRequest -UseBasicParsing "$base/$exe" -OutFile $path
      Invoke-WebRequest -UseBasicParsing "$base/$exe.sha256" -OutFile "$path.sha256"
      $expected = ((Get-Content -Raw "$path.sha256") -split '\s+')[0]
      if ((Get-FileHash -Algorithm SHA256 $path).Hash -ne $expected) { throw "checksum mismatch for $exe." }

      Write-Host "Installing..."
      # --force-run makes electron-builder's one-click installer start the app after a silent install.
      $install = Start-Process -FilePath $path -ArgumentList "/S", "--force-run" -Wait -PassThru
      if ($install.ExitCode -ne 0) { throw "the installer exited with code $($install.ExitCode)." }

      Write-Host "Installed T3 Code $version."
    } finally {
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
  }
}
