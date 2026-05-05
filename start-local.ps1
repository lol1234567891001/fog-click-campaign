$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

$env:OPENROUTER_API_KEY = [Environment]::GetEnvironmentVariable("OPENROUTER_API_KEY", "User")
$env:ELEVENLABS_API_KEY = [Environment]::GetEnvironmentVariable("ELEVENLABS_API_KEY", "User")
$env:HOST = "127.0.0.1"

if (-not $env:PORT) {
  $env:PORT = "5173"
}

Write-Host "Starting Fog Click Campaign..."
Write-Host "If port 5173 is busy, the server will try the next open port."
Write-Host ""

node live-server.js
