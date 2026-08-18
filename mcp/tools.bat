@echo off
:menu
cls
echo.
echo  ================================
echo    Town Crier -- Dev Tools
echo  ================================
echo.
echo  1. Start AA Emulator (DHU)
echo  2. Start Town Crier Editor (LOCAL)
echo  3. Start Town Crier Editor (REMOTE)
echo  4. Start SSH Tunnel (REMOTE via DuckDNS)
echo  5. Start SSH Tunnel (LOCAL via raspberrypi.local)
echo  6. SSH into Mac CC (via Pi relay)
echo.
echo  0. Exit
echo.
set /p choice=" Select an option: "

if "%choice%"=="1" goto aa_emulator
if "%choice%"=="2" goto editor_local
if "%choice%"=="3" goto editor_remote
if "%choice%"=="4" goto tunnel_remote
if "%choice%"=="5" goto tunnel_local
if "%choice%"=="6" goto mac_ssh
if "%choice%"=="0" goto end
echo  Invalid option. Try again.
timeout /t 1 >nul
goto menu

:aa_emulator
echo.
echo  Launching AA Emulator...
powershell -ExecutionPolicy Bypass -File "C:\dev\start-aa-emulator.ps1"
goto menu

:editor_local
echo.
echo  Launching Town Crier Editor (LOCAL)...
powershell -ExecutionPolicy Bypass -File "C:\dev\Start-TownCrierEditor-LOCAL.ps1"
goto menu

:editor_remote
echo.
echo  Launching Town Crier Editor (REMOTE)...
powershell -ExecutionPolicy Bypass -File "C:\dev\Start-TownCrierEditor.ps1"
goto menu

:tunnel_remote
echo.
echo  Starting SSH Tunnel (REMOTE via DuckDNS)...
echo  Stopping any existing tunnel process...
powershell -ExecutionPolicy Bypass -Command "Get-Process ssh -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
echo  Clearing any existing port 2222 listener on Pi...
powershell -ExecutionPolicy Bypass -Command "ssh barry@rosenpi.duckdns.org 'sudo fuser -k 2222/tcp 2>/dev/null; sleep 1'"
echo  Starting persistent tunnel window (keep it open while working)...
start powershell -ExecutionPolicy Bypass -NoExit -File "C:\dev\town-crier-mcp\tunnel.ps1"
echo  Waiting for tunnel to establish...
powershell -ExecutionPolicy Bypass -Command "Start-Sleep 6; $r = ssh barry@rosenpi.duckdns.org 'ssh -p 2222 tcagent@localhost echo tunnel_ok'; if ($r -eq 'tunnel_ok') { Write-Host '  Tunnel OK.' -ForegroundColor Green } else { Write-Host '  Tunnel may have failed - check the tunnel window.' -ForegroundColor Red }"
echo.
pause
goto menu

:tunnel_local
echo.
echo  Starting SSH Tunnel (LOCAL via raspberrypi.local)...
echo  Stopping any existing tunnel process...
powershell -ExecutionPolicy Bypass -Command "Get-Process ssh -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
echo  Clearing any existing port 2222 listener on Pi...
powershell -ExecutionPolicy Bypass -Command "ssh barry@raspberrypi.local 'sudo fuser -k 2222/tcp 2>/dev/null; sleep 1'"
echo  Starting persistent tunnel window (keep it open while working)...
start powershell -ExecutionPolicy Bypass -NoExit -File "C:\dev\town-crier-mcp\tunnel-local.ps1"
echo  Waiting for tunnel to establish...
powershell -ExecutionPolicy Bypass -Command "Start-Sleep 6; $r = ssh barry@raspberrypi.local 'ssh -p 2222 tcagent@localhost echo tunnel_ok'; if ($r -eq 'tunnel_ok') { Write-Host '  Tunnel OK.' -ForegroundColor Green } else { Write-Host '  Tunnel may have failed - check the tunnel window.' -ForegroundColor Red }"
echo.
pause
goto menu

:mac_ssh
echo.
echo  Opening SSH session to Mac CC via Pi relay...
echo  (Type 'exit' to return to Pi, then 'exit' again to return here)
echo.
ssh -t barry@raspberrypi.local "ssh -t barry@mac-tc.towncrierapp.com"
echo.
pause
goto menu

:end
goto :eof


