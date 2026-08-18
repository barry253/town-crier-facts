# Auto-detect local vs remote Pi and open interactive SSH session to Mac CC
if (Test-Connection raspberrypi.local -Count 1 -Quiet -ErrorAction SilentlyContinue) {
    $pi = "barry@raspberrypi.local"
} else {
    $pi = "barry@rosenpi.duckdns.org"
}
Write-Host "  Connecting via $pi..." -ForegroundColor Cyan
& ssh -t $pi "ssh -t barry@mac-tc.towncrierapp.com"
