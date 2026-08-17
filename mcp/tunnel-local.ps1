while ($true) {
    function ts { Get-Date -Format 'MM/dd/yyyy HH:mm:ss' }

    Write-Host "$(ts) Starting tunnel (LOCAL)..."

    $job = Start-Job -ScriptBlock {
        & ssh -N -R 2222:localhost:22 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes barry@raspberrypi.local
    }

    Start-Sleep 5
    if ($job.State -eq 'Running') {
        Write-Host "$(ts) Tunnel OK - listening on Pi:2222"
        $lastActivity = Get-Date
        while ($job.State -eq 'Running') {
            Start-Sleep 10
            $active = netstat -n 2>$null |
                Select-String '127\.0\.0\.1:22\s+127\.0\.0\.1' |
                Where-Object { $_ -notmatch 'LISTEN' }
            if ($active) {
                $now = Get-Date
                if (($now - $lastActivity).TotalSeconds -gt 15) {
                    Write-Host "$(ts) Tunnel in use (Win CC active)"
                    $lastActivity = $now
                }
            }
        }
    } else {
        Write-Host "$(ts) SSH exited immediately - connection failed"
    }

    $job | Wait-Job | Out-Null
    Remove-Job $job -Force 2>$null
    Write-Host "$(ts) Tunnel died, retrying in 10s..."
    Start-Sleep 10
}
