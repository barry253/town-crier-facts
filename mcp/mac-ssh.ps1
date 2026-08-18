# Auto-detect local vs remote Pi and open interactive SSH session to Mac CC via Tailscale
if (Test-Connection raspberrypi.local -Count 1 -Quiet -ErrorAction SilentlyContinue) {
    $pi = "barry@raspberrypi.local"
} else {
    $pi = "barry@rosenpi.duckdns.org"
}
Write-Host "  Connecting via $pi -> edens-macbook-air..." -ForegroundColor Cyan
& ssh $pi "ssh barry@edens-macbook-air"
