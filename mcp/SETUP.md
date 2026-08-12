# Town Crier MCP Server — Setup Guide

## Architecture

```
Claude.ai (browser or phone)
    │ HTTPS
    ▼
agents.towncrierapp.com  (Cloudflare Tunnel → Pi)
    │
    ▼
Pi: MCP server (Node, port 3001)  ←── always on, systemd
    │
    ├── run_pi_cc  →  claude -p  (local, ~/town-crier-facts)
    │
    ├── run_win_cc / run_ds_cc
    │       │ SSH via reverse tunnel (port 2222, Pi loopback)
    │       ▼
    │   Dell: claude -p  (C:\dev\town-crier or C:\dev\kokoro-bench)
    │
    └── run_mac_tc_cc
            │ SSH via Cloudflare Access
            ▼
        Mac: claude -p  (~/dev/town-crier)
```

Dell must be awake and logged in for Win CC / DS CC.
Pi CC always works regardless of Dell state.
Mac CC requires cloudflared LaunchDaemon running on the Mac.

---

## Part 1: Pi setup

### Step 1: Install Node.js and dependencies

```bash
ssh barry@rosenpi.duckdns.org
cd ~/town-crier-mcp
npm install
```

### Step 2: Register systemd services

```bash
sudo cp town-crier-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable town-crier-mcp
sudo systemctl start town-crier-mcp
sudo systemctl status town-crier-mcp
```

### Step 3: Install and configure Cloudflare Tunnel

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
cloudflared login
cloudflared tunnel create town-crier-agents
```

Create ~/.cloudflared/config.yml:
```yaml
tunnel: <YOUR_TUNNEL_ID>
credentials-file: /home/barry/.cloudflared/<YOUR_TUNNEL_ID>.json

ingress:
  - hostname: agents.towncrierapp.com
    service: http://127.0.0.1:3001
  - service: http_status:404
```

```bash
cloudflared tunnel route dns town-crier-agents agents.towncrierapp.com
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

### Step 4: Verify Pi services

```bash
sudo systemctl status town-crier-mcp
sudo systemctl status cloudflared
curl https://agents.towncrierapp.com/health
```

---

## Part 2: Dell setup

The Dell establishes a reverse SSH tunnel to the Pi on login.
Port 2222 on the Pi loopback forwards to Dell port 22.
The MCP server connects to tcagent@localhost:2222 to reach the Dell.

### Step 5: Register the tunnel task

The TownCrierReverseTunnel Task Scheduler task should already exist.
If rebuilding from scratch, register it manually:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File C:\dev\town-crier-mcp\reverse-tunnel.ps1"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "MAN\E002526"
$settings = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "TownCrierReverseTunnel" -Action $action `
  -Trigger $trigger -Settings $settings -RunLevel Highest
```

### Step 6: Authenticate tcagent

tcagent needs its own Claude session (separate from Barry's login).
Uses a 1-year setup-token — no recurring OAuth expiry.

From a PowerShell window on the Dell:
```powershell
ssh -t barry@rosenpi.duckdns.org "ssh -t -p 2222 -o StrictHostKeyChecking=no tcagent@localhost claude setup-token"
```

Token expires ~1 year from setup. Re-run this command to renew.
Credential store: C:\Users\tcagent.CAI-HR4ZRK4\.claude\.credentials.json

### Step 7: Verify Dell is reachable from Pi

```bash
ssh -p 2222 tcagent@localhost echo tunnel_ok
```

Should print tunnel_ok. Never test from the Dell side — always fails by design.

---

## Part 3: Mac setup

### Step 8: Install cloudflared as a LaunchDaemon on Mac

```bash
brew install cloudflare/cloudflare/cloudflared
sudo cloudflared service install
sudo launchctl start com.cloudflare.cloudflared
```

Config at ~/.cloudflared/config.yml, ingress to mac-tc.towncrierapp.com to ssh://localhost:22.

### Step 9: Add mac-tc SSH alias on Pi

Add to ~/.ssh/config on Pi:
```
Host mac-tc
    HostName mac-tc.towncrierapp.com
    User barry
    ProxyCommand cloudflared access ssh --hostname %h
```

### Step 10: KeepAlive plist fix (prevents tunnel dying while alive)

```bash
sudo /usr/libexec/PlistBuddy -c "Delete :KeepAlive" /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
sudo /usr/libexec/PlistBuddy -c "Add :KeepAlive bool true" /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

### Step 11: Scoped sudoers rule for watchdog auto-remediation

```bash
echo 'barry ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/com.cloudflare.cloudflared' | sudo tee /etc/sudoers.d/mac-tunnel-watchdog
sudo chmod 440 /etc/sudoers.d/mac-tunnel-watchdog
sudo visudo -c
```

---

## Part 4: Claude.ai registration

1. Go to claude.ai and open Settings then Integrations
2. Add MCP server: https://agents.towncrierapp.com
3. Open your Town Crier project and paste CLAUDE-CHAT-INSTRUCTIONS.md into project instructions

---

## Day-to-day operation

Dell: Log in normally. TownCrierReverseTunnel starts automatically.
Manual start: tools.bat option 4 (remote/DuckDNS) or option 5 (local).

Tunnel window: Shows "Tunnel OK" on connect, "Tunnel in use" on Win CC activity.
Script: C:\dev\town-crier-mcp\tunnel.ps1

Logs (Pi):
```bash
tail -f ~/town-crier-mcp/logs/win-cc.log
tail -f ~/town-crier-mcp/logs/pi-cc.log
tail -f ~/town-crier-mcp/logs/ds-cc.log
```

---

## Troubleshooting

**All CC tools dark simultaneously:**
Pi MCP server is down. Check: sudo systemctl status town-crier-mcp
Restart: sudo systemctl restart town-crier-mcp

**Only Mac CC tools dark:**
cloudflared tunnel on Mac is hung (process alive but connections dead).
Fix: sudo launchctl kickstart -k system/com.cloudflare.cloudflared
Check logs: /Library/Logs/com.cloudflare.cloudflared.err.log

**Win CC / DS CC unreachable:**
Check tunnel: ss -tlnp | grep 2222 on Pi -- should show LISTEN.
If nothing: start tunnel via tools.bat option 4.
If listening but refusing: server.js probe-kills stale port automatically on next call.
Manual clear: sudo fuser -k 2222/tcp on Pi.

**Win CC auth expired:**
Re-authenticate tcagent:
```powershell
ssh -t barry@rosenpi.duckdns.org "ssh -t -p 2222 -o StrictHostKeyChecking=no tcagent@localhost claude setup-token"
```
Token lasts 1 year. Set Aug 12 2026, expires ~Aug 2027.

**Mac watchdog:**
Script: ~/town-facts-lab/scripts/watchMacTunnel.sh
Cron: every 5 min (currently commented out -- re-enable after Mac confirmed stable).
Auto-remediation via Tailscale requires Pi on tailnet (confirmed) + scoped sudoers rule on Mac (pending).
