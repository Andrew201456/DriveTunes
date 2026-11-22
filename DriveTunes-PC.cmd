@echo off
setlocal
title DriveTunes - PC Transfer
set "DT_SELF=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$source=[System.IO.File]::ReadAllText($env:DT_SELF);$marker=':__DRIVETUNES_POWERSHELL_START__';$index=$source.LastIndexOf($marker);if($index -lt 0){throw 'Launcher content missing'};& ([scriptblock]::Create($source.Substring($index+$marker.Length)))"
if errorlevel 1 (
  echo.
  echo The DriveTunes PC transfer could not start. Check the error above.
  pause
)
exit /b %errorlevel%

:__DRIVETUNES_POWERSHELL_START__
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$port = 8765
$address = 'http://127.0.0.1:' + $port + '/'
$directory = Join-Path $env:LOCALAPPDATA 'DriveTunes-PC'
$sourceRoot = 'https://raw.githubusercontent.com/Andrew201456/DriveTunes/main/'
$files = @('pc-transfer.html','pc-transfer.css','pc-transfer.js','pc-bridge.js','assets/icon.svg')
try {
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
  Write-Host 'DriveTunes PC - Preparing transfer page...' -ForegroundColor Cyan
  foreach ($relative in $files) {
    $target = Join-Path $directory ($relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
    $uri = $sourceRoot + $relative
    $temp = $target + '.download'
    try {
      $client = New-Object System.Net.WebClient
      try { $client.DownloadFile($uri,$temp) } finally { $client.Dispose() }
      if (!(Test-Path -LiteralPath $temp) -or (Get-Item -LiteralPath $temp).Length -eq 0) {
        throw 'Received an empty file'
      }
      Move-Item -LiteralPath $temp -Destination $target -Force
    } catch {
      Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
      if (!(Test-Path -LiteralPath $target)) {
        throw "Cannot download $relative. Check your internet connection."
      }
      Write-Host "Offline fallback: $relative" -ForegroundColor Yellow
    }
  }
  # Serve only on this computer. No Windows firewall or router port forwarding.
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$port)
  $listener.Start()
  Write-Host ''
  Write-Host 'DriveTunes PC is ready!' -ForegroundColor Green
  Write-Host "Open in this PC browser:  $address" -ForegroundColor White
  Write-Host 'Keep this window open during transfer; close with Ctrl+C.' -ForegroundColor DarkGray
  Write-Host ''
  Start-Process -FilePath $address
  $allowed = @{
    '/' = 'pc-transfer.html'
    '/pc-transfer.html' = 'pc-transfer.html'
    '/pc-transfer.css' = 'pc-transfer.css'
    '/pc-transfer.js' = 'pc-transfer.js'
    '/pc-bridge.js' = 'pc-bridge.js'
    '/assets/icon.svg' = 'assets/icon.svg'
  }
  $mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.css' = 'text/css; charset=utf-8'
    '.js' = 'text/javascript; charset=utf-8'
    '.svg' = 'image/svg+xml'
  }
  while ($true) {
    $connection = $listener.AcceptTcpClient()
    try {
      $connection.ReceiveTimeout = 10000
      $connection.SendTimeout = 10000
      $stream = $connection.GetStream()
      $reader = [System.IO.StreamReader]::new($stream,[System.Text.Encoding]::ASCII,$false,1024,$true)
      $request = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($request)) { continue }
      $parts = $request -split ' '
      while ($true) {
        $headerLine = $reader.ReadLine()
        if ($null -eq $headerLine -or $headerLine -eq '') { break }
      }
      $route = if ($parts.Length -gt 1) { ($parts[1] -split '[?#]',2)[0] } else { '/' }
      $status = '200 OK'
      $mimeType = 'text/plain; charset=utf-8'
      $payload = [System.Text.Encoding]::UTF8.GetBytes('Not Found')
      if ($parts[0] -ne 'GET' -and $parts[0] -ne 'HEAD') {
        $status = '405 Method Not Allowed'
        $payload = [System.Text.Encoding]::UTF8.GetBytes('Only GET is supported')
      } elseif ($allowed.ContainsKey($route)) {
        $relative = $allowed[$route]
        $path = Join-Path $directory ($relative.Replace('/',[System.IO.Path]::DirectorySeparatorChar))
        if (Test-Path -LiteralPath $path -PathType Leaf) {
          $payload = [System.IO.File]::ReadAllBytes($path)
          $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
          $mimeType = $mime[$ext]
        } else {
          $status = '404 Not Found'
        }
      } else {
        $status = '404 Not Found'
      }
      $crlf = [string][char]13 + [char]10
      $headers = @(
        "HTTP/1.1 $status",
        "Content-Type: $mimeType",
        "Content-Length: $($payload.Length)",
        'Connection: close',
        'Cache-Control: no-store',
        'X-Content-Type-Options: nosniff',
        'Referrer-Policy: no-referrer',
        'X-Frame-Options: DENY'
      ) -join $crlf
      $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers + $crlf + $crlf)
      $stream.Write($headerBytes,0,$headerBytes.Length)
      if ($parts[0] -ne 'HEAD') { $stream.Write($payload,0,$payload.Length) }
      $stream.Flush()
    } catch {
      Write-Host 'A browser request could not be served.' -ForegroundColor DarkYellow
    } finally {
      $connection.Close()
    }
  }
} catch {
  Write-Host ('DriveTunes PC error: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  if ($listener) { $listener.Stop() }
}