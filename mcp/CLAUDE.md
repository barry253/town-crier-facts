# Town Crier MCP Server — Operations Reference

## Architecture

- **MCP server:** `~/town-crier-mcp/server.js` (Node, port 3001)
- **Process supervisor:** systemd `town-crier-mcp.service` (Restart=always)
- **Inbound tunnel:** Cloudflare Tunnel → `agents.towncrierapp.com`
- **Restart:** `sudo systemctl restart town-crier-mcp`
- **Logs:** `~/town-crier-mcp/logs/`

## Agent routing

| Tool | Machine | Repo | User |
|------|---------|------|------|
| `run_win_cc` | Dell Windows | `C:\dev\town-crier` | tcagent |
| `run_ds_cc` | Dell Windows | `C:\dev\kokoro-bench` | tcagent |
| `run_pi_cc` | Raspberry Pi | `~/town-crier-facts` | barry |
| `run_mac_tc_cc` | MacBook Air | `~/dev/town-crier` | barry |

## Win CC prompt delivery

Prompts are written to `proc.stdin` — not passed as CLI arguments. This eliminates:
- The 8191-char Windows command-line length ceiling
- All PowerShell single-quote/apostrophe escaping issues

## Dell reverse SSH tunnel

Port 2222 listens on the **Pi's loopback** (127.0.0.1:2222), not the Dell.
The MCP server connects to `tcagent@localhost -p 2222` from the Pi side.

**Live tunnel task:** `TownCrierReverseTunnel` (runs as `MAN\E002526`, logon trigger,
script `C:\dev\town-crier-mcp\reverse-tunnel.ps1`).

**Disabled task:** `TC-SSH-Tunnel` (tcagent) — disabled Aug 12 2026, was causing
duplicate tunnel race and stale port 2222 accumulation.

**Manual tunnel start:** tools.bat option 4, or:
```powershell
powershell -ExecutionPolicy Bypass -NoExit -File "C:\dev\town-crier-mcp\tunnel.ps1"
```

**Stale port 2222:** server.js probes before killing (probe-first fuser logic).
Manual fallback: `ssh barry@rosenpi.duckdns.org "sudo fuser -k 2222/tcp"`

**Tunnel test (from Pi):** `ssh -p 2222 tcagent@localhost echo tunnel_ok`
Never test from the Dell side — it always fails by design.

## tcagent authentication

Win CC and DS CC run as `tcagent` on the Dell. tcagent uses a **1-year setup-token**
(set Aug 12 2026, expires ~Aug 2027) — no per-session OAuth expiry.

**Re-auth when expired:**
```powershell
ssh -t barry@rosenpi.duckdns.org "ssh -t -p 2222 -o StrictHostKeyChecking=no tcagent@localhost claude setup-token"
```

tcagent's credential store: `C:\Users\tcagent.CAI-HR4ZRK4\.claude\.credentials.json`
(Note: profile is `tcagent.CAI-HR4ZRK4`, NOT `tcagent` — Windows created a suffixed
profile because `C:\Users\tcagent` was already occupied.)

## Pi-as-relay pattern for complex Win CC tasks

When a Win CC task involves a script too complex to pass inline:

```bash
# 1. Write script to Pi
cat > /tmp/tc-task.js << 'JSEOF'
// your Node.js script
JSEOF

# 2. Convert LF to CRLF and copy to Dell
python3 -c "
content = open('/tmp/tc-task.js').read().replace('\n', '\r\n')
with open('/tmp/tc-task.crlf.js', 'wb') as f:
    f.write(content.encode('utf-8'))
"
scp -P 2222 /tmp/tc-task.crlf.js tcagent@localhost:"C:/dev/tc-task.js"

# 3. Execute on Dell
ssh -p 2222 tcagent@localhost "node C:/dev/tc-task.js"
```

Node.js handles encoding correctly. Clean up temp files after use.

## Mac CC tunnel

Mac is reached via Cloudflare Access using the `mac-tc` SSH alias:
```
Host mac-tc
    HostName mac-tc.towncrierapp.com
    User barry
    ProxyCommand cloudflared access ssh --hostname %h
```

cloudflared runs as a system LaunchDaemon on the Mac (`com.cloudflare.cloudflared`).
Watchdog: `~/town-facts-lab/scripts/watchMacTunnel.sh` (Pi cron, every 5 min).
Currently commented out — re-enable Thursday after Mac confirmed stable.

## Hardening changes (Aug 12 2026)

- Win CC stdin delivery (eliminates length/quoting issues)
- Probe-before-kill for stale port 2222 in `runOnDell`
- Pi CC machine identity anchor prepended to every prompt
- Auth error banner in `formatResult` with exact re-auth command (Win CC only)
- Pi CC output discipline + relay pattern documented in `~/town-crier-facts/CLAUDE.md`
