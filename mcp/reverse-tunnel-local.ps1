while ($true) {
    ssh -N `
        -o ExitOnForwardFailure=yes `
        -o ServerAliveInterval=30 `
        -o ServerAliveCountMax=3 `
        -o BatchMode=yes `
        -o StrictHostKeyChecking=accept-new `
        -R 2222:localhost:22 `
        barry@raspberrypi.local
    Start-Sleep -Seconds 10
}
