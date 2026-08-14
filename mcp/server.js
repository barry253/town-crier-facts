import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { spawn, execSync } from "child_process";
import { createWriteStream, mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { handleOAuth, isAuthorized } from "./oauth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config -----------------------------------------------------------

const PORT              = process.env.MCP_PORT || 3000;
const TASK_TIMEOUT_MS   = 5 * 60 * 1000;   // 5 minutes per task
const SSH_TIMEOUT_S     = 10;               // seconds for SSH connection attempt
const REVERSE_TUNNEL_PORT = 2222;           // Dell's SSH port as seen from Pi

// Dell SSH details — Pi reaches Dell via the reverse tunnel on localhost
const DELL_SSH = `ssh -o ConnectTimeout=${SSH_TIMEOUT_S} -o BatchMode=yes -o StrictHostKeyChecking=no -p ${REVERSE_TUNNEL_PORT} tcagent@localhost`;
const MAC_SSH_HOST = "mac-tc";           // SSH host in ~/.ssh/config — routes via Cloudflare tunnel
const MAC_CLAUDE   = "/opt/homebrew/bin/claude";

const REPOS = {
  win:         "C:\\\\dev\\\\town-crier",
  ds:          "C:\\\\dev\\\\kokoro-bench",
  menucha:     "C:\\\\dev\\\\menucha",
  pi:          "~/town-crier-facts",
  mac_tc:      "~/dev/town-crier",
  mac_menucha: "~/dev/menucha",
};

const PENDING_DIR = path.join(__dirname, "pending");

// Tools allowed per phase.
// "investigate" = read-only: CC may read files and list directories only.
// "implement"   = adds file writes and bash, scoped to the repo directory.
const ALLOWED_TOOLS = {
  investigate: ["Read", "LS", "Glob", "Grep"],
  implement:   ["Read", "LS", "Glob", "Grep", "Write", "Edit", "MultiEdit", "Bash"],
};

// --- Logging ----------------------------------------------------------

mkdirSync(path.join(__dirname, "logs"),   { recursive: true });
mkdirSync(PENDING_DIR,                    { recursive: true });

function makeLogger(name) {
  const stream = createWriteStream(
    path.join(__dirname, "logs", `${name}.log`),
    { flags: "a" }
  );
  return (line) => {
    const ts = new Date().toISOString();
    stream.write(`[${ts}] ${line}\n`);
  };
}

const log = {
  server:      makeLogger("mcp-server"),
  win:         makeLogger("win-cc"),
  pi:          makeLogger("pi-cc"),
  ds:          makeLogger("ds-cc"),
  menucha:     makeLogger("menucha-cc"),
  mac_tc:      makeLogger("mac-tc-cc"),
  mac_menucha: makeLogger("mac-menucha-cc"),
};

// --- Pending queue ----------------------------------------------------

function savePending({ agent, prompt, phase }) {
  const id   = randomUUID();
  const file = path.join(PENDING_DIR, `${agent}-${id}.json`);
  const record = {
    id,
    agent,
    prompt,
    phase,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(record, null, 2));
  log.server(`[PENDING] saved ${file}`);
  return { id, file };
}

function clearPending(file) {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch (err) {
    log.server(`[PENDING] failed to clear ${file}: ${err.message}`);
  }
}

// --- Core runner ------------------------------------------------------

/**
 * Run `claude -p <prompt>` on Dell via the reverse SSH tunnel.
 * Dell must have the tunnel established (Task Scheduler on login).
 *
 * Returns { stdout, exit_code, duration_ms } or throws on timeout/unreachable.
 */
function runOnDell({ prompt, phase, repoPath, logger }) {
  return new Promise((resolve, reject) => {
    const tools      = ALLOWED_TOOLS[phase];
    const allowedTools = tools.join(",");

    // PowerShell command to run on Dell via SSH.
    // We use cmd /c to invoke powershell so the SSH shell can find it.
    const remoteCmd =
      `powershell.exe -NoProfile -NonInteractive -Command "cd '${repoPath}'; claude -p --allowedTools ${allowedTools} --output-format text"`;

    const sshArgs = [
      "-o", `ConnectTimeout=${SSH_TIMEOUT_S}`,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=no",
      "-p", String(REVERSE_TUNNEL_PORT),
      "tcagent@localhost",
      remoteCmd,
    ];

    logger(`[START] phase=${phase} repo=${repoPath}`);
    logger(`[PROMPT] ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`);

    const start = Date.now();

    // If port 2222 is listening but not accepting connections (stale zombie),
    // kill it so the Dell tunnel can re-bind. Only fuser-kill on probe failure
    // to avoid severing a live connection.
    try {
      execSync(`ssh -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=no -p ${REVERSE_TUNNEL_PORT} tcagent@localhost echo ok 2>/dev/null`, { stdio: "ignore" });
    } catch (_) {
      // Probe failed — port may be stuck. Clear it and let Dell tunnel reconnect.
      try { execSync("sudo fuser -k 2222/tcp 2>/dev/null || true", { stdio: "ignore" }); } catch (__) {}
      // Brief pause to let the Dell auto-restart loop re-establish the tunnel.
      execSync("sleep 3");
    }

    const proc  = spawn("ssh", sshArgs, { shell: false });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { const c = d.toString(); stdout += c; logger(`[OUT] ${c.trimEnd()}`); });
    proc.stderr.on("data", (d) => { const c = d.toString(); stderr += c; logger(`[ERR] ${c.trimEnd()}`); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Task timed out after ${TASK_TIMEOUT_MS / 1000}s`));
    }, TASK_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - start;
      logger(`[DONE] exit=${code} duration=${duration_ms}ms`);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exit_code: code, duration_ms });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run `claude -p <prompt>` locally on the Pi.
 */
function runOnPi({ prompt, phase, logger }) {
  return new Promise((resolve, reject) => {
    const tools        = ALLOWED_TOOLS[phase];
    const allowedTools = tools.join(",");

    prompt = `[You are Pi CC, running on the Raspberry Pi at ~/town-crier-facts. Do not route this task to any other machine.]\n\n` + prompt;

    const args = [
      "-p", prompt,
      "--allowedTools", allowedTools,
      "--output-format", "text",
    ];

    logger(`[START] phase=${phase} repo=${REPOS.pi}`);
    logger(`[PROMPT] ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`);

    const start = Date.now();
    const proc  = spawn("/home/barry/.local/bin/claude", args, {
      shell: false,
      cwd:   path.join(process.env.HOME, "town-crier-facts"),
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { const c = d.toString(); stdout += c; logger(`[OUT] ${c.trimEnd()}`); });
    proc.stderr.on("data", (d) => { const c = d.toString(); stderr += c; logger(`[ERR] ${c.trimEnd()}`); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Task timed out after ${TASK_TIMEOUT_MS / 1000}s`));
    }, TASK_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - start;
      logger(`[DONE] exit=${code} duration=${duration_ms}ms`);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exit_code: code, duration_ms });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run `claude -p <prompt>` on the Mac via Cloudflare Tunnel (SSH host: mac-tc).
 * The ~/.ssh/config entry for mac-tc uses cloudflared as a ProxyCommand.
 */
function runOnMac({ prompt, phase, repoPath, logger }) {
  return new Promise((resolve, reject) => {
    const tools     = ALLOWED_TOOLS[phase].join(",");
    prompt = `[You are Mac CC, running on the MacBook Air at ~/dev/town-crier. Do not route this task to any other machine.]\n\n[Output discipline: when running shell commands, always include the FULL raw output verbatim in your response — never say "output above", "as shown", or "see above". If content is long, include it all in a fenced code block. Never summarize file contents.]\n\n` + prompt;
    const safePrompt = prompt.replace(/'/g, "'\\''");
    const remoteCmd = `cd ${repoPath} && ${MAC_CLAUDE} -p '${safePrompt}' --allowedTools ${tools} --output-format text --dangerously-skip-permissions < /dev/null`;

    const sshArgs = [
      "-o", `ConnectTimeout=${SSH_TIMEOUT_S}`,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=no",
      MAC_SSH_HOST,
      remoteCmd,
    ];

    logger(`[START] phase=${phase} repo=${repoPath} via ${MAC_SSH_HOST}`);
    logger(`[PROMPT] ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`);

    const start = Date.now();
    const proc  = spawn("ssh", sshArgs, { shell: false });
    let stdout  = "";
    let stderr  = "";

    proc.stdout.on("data", (d) => { const c = d.toString(); stdout += c; logger(`[OUT] ${c.trimEnd()}`); });
    proc.stderr.on("data", (d) => { const c = d.toString(); stderr += c; logger(`[ERR] ${c.trimEnd()}`); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timed out after ${TASK_TIMEOUT_MS / 1000}s`));
    }, TASK_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      logger(`[DONE] exit=${code} duration=${Date.now() - start}ms`);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exit_code: code, duration_ms: Date.now() - start });
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// --- Format result for Claude chat ------------------------------------

function formatResult({ result, agent, phase, repoPath }) {
  const mins   = (result.duration_ms / 60000).toFixed(1);
  const header = [
    `## ${agent} CC — ${phase} phase`,
    `Repo: \`${repoPath}\`  |  Duration: ${mins}m  |  Exit: ${result.exit_code}`,
    "",
  ].join("\n");
  const AUTH_ERROR_STRINGS = [
    "OAuth session expired",
    "Failed to authenticate",
    "not logged in",
    "Authentication required",
  ];
  const combined = `${result.stdout} ${result.stderr}`;
  const isAuthError = agent === "Win" && AUTH_ERROR_STRINGS.some(s => combined.toLowerCase().includes(s.toLowerCase()));
  const authBanner = isAuthError
    ? "⚠️ **Win CC auth expired** — re-authenticate tcagent's Claude session by running this from a PowerShell window on the Dell: `ssh -t barry@rosenpi.duckdns.org \"ssh -t -p 2222 -o StrictHostKeyChecking=no tcagent@localhost claude setup-token\"`. Token lasts 1 year.\n\n---\n\n"
    : "";
  const body = authBanner + (result.stdout || "(no output)");
  const warn = result.stderr
    ? `\n\n---\n**stderr:**\n\`\`\`\n${result.stderr}\n\`\`\``
    : "";
  return `${header}${body}${warn}`;
}

// --- MCP server -------------------------------------------------------

function createMcpServer() {
const server = new McpServer({
  name:    "town-crier-agents",
  version: "1.0.0",
});

// Progress heartbeat — fires every 15s while a long-running CC task is in flight.
// Keeps Claude.ai from timing out on tasks that legitimately take 100-260s.
// Wrapped in try/catch so a client that ignores progress never kills the result.
function startProgressHeartbeat(extra, label) {
  if (!extra?.sendNotification || !extra?._meta?.progressToken) return null;
  const progressToken = extra._meta.progressToken;
  const startTime = Date.now();
  const interval = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: elapsed,
          total: 300,
          message: `${label} running… (${elapsed}s)`,
        },
      });
    } catch (_) {}
  }, 15000);
  return interval;
}

// Tool: run_win_cc
server.tool(
  "run_win_cc",
  "Execute a Claude Code task on the Dell Windows machine against the Town Crier app repo at C:\\dev\\town-crier. Use for app code, React Native, Java background service, EAS builds, and deploy scripts. NOT for Pi corpus work, fact generation, or queue management.",
  {
    prompt: z.string().describe("The full prompt to send to Claude Code"),
    phase: z.enum(["investigate", "implement"]).default("investigate").describe(
      '"investigate" = read-only (Phase 1). "implement" = file writes + bash enabled (Phase 2, requires prior approval).'
    ),
  },
  async ({ prompt, phase }, extra) => {
    log.win(`[TOOL] run_win_cc phase=${phase}`);
    const heartbeat = startProgressHeartbeat(extra, "Win CC");
    try {
      const result = await runOnDell({ prompt, phase, repoPath: REPOS.win, logger: log.win });
      clearInterval(heartbeat);
      return { content: [{ type: "text", text: formatResult({ result, agent: "Win", phase, repoPath: REPOS.win }) }] };
    } catch (err) {
      clearInterval(heartbeat);
      log.win(`[OFFLINE] ${err.message} — saving to pending queue`);
      const { id } = savePending({ agent: "win", prompt, phase });
      return {
        content: [{ type: "text", text: [
          `**Dell is unreachable** (reverse tunnel may not be established).`,
          ``,
          `Your prompt has been saved to the pending queue (ID: \`${id}\`).`,
          `It will run automatically when Dell reconnects and the result will be emailed to towncrierdev@gmail.com.`,
          ``,
          `To reissue manually when Dell is back: just resend this same prompt.`,
          `To cancel: the pending task will expire in 24 hours if not run.`,
        ].join("\n") }],
        isError: true,
      };
    }
  }
);

// Tool: run_ds_cc
server.tool(
  "run_ds_cc",
  "Execute a Claude Code task on the Dell machine against the Kokoro TTS synthesis repo at C:\\dev\\kokoro-bench. Use for TTS synthesis, audio generation, and Kokoro pipeline work.",
  {
    prompt: z.string().describe("The full prompt to send to Claude Code"),
    phase: z.enum(["investigate", "implement"]).default("investigate").describe(
      '"investigate" = read-only (Phase 1). "implement" = file writes + bash enabled (Phase 2, requires prior approval).'
    ),
  },
  async ({ prompt, phase }, extra) => {
    const heartbeat = startProgressHeartbeat(extra, "DS CC");
    log.ds(`[TOOL] run_ds_cc phase=${phase}`);
    try {
      const result = await runOnDell({ prompt, phase, repoPath: REPOS.ds, logger: log.ds });
      clearInterval(heartbeat);
      return { content: [{ type: "text", text: formatResult({ result, agent: "DS", phase, repoPath: REPOS.ds }) }] };
    } catch (err) {
      clearInterval(heartbeat);
      log.ds(`[OFFLINE] ${err.message} — saving to pending queue`);
      const { id } = savePending({ agent: "ds", prompt, phase });
      return {
        content: [{ type: "text", text: [
          `**Dell is unreachable** (reverse tunnel may not be established).`,
          ``,
          `Your prompt has been saved to the pending queue (ID: \`${id}\`).`,
          `It will run automatically when Dell reconnects and the result will be emailed to towncrierdev@gmail.com.`,
          ``,
          `To reissue manually when Dell is back: just resend this same prompt.`,
          `To cancel: the pending task will expire in 24 hours if not run.`,
        ].join("\n") }],
        isError: true,
      };
    }
  }
);

// Tool: run_pi_cc
server.tool(
  "run_pi_cc",
  "Execute a Claude Code task on the Raspberry Pi against the Town Crier facts repo at ~/town-crier-facts, or the lab at ~/town-facts-lab. Use for fact corpus work, queue management, synthesis pipeline, and publish-facts. NOT for app code, React Native, Java, Swift, EAS builds, or anything in C:\\dev\\town-crier.",
  {
    prompt: z.string().describe("The full prompt to send to Claude Code"),
    phase: z.enum(["investigate", "implement"]).default("investigate").describe(
      '"investigate" = read-only (Phase 1). "implement" = file writes + bash enabled (Phase 2, requires prior approval).'
    ),
  },
  async ({ prompt, phase }) => {
    log.pi(`[TOOL] run_pi_cc phase=${phase}`);
    try {
      const result = await runOnPi({ prompt, phase, logger: log.pi });
      return { content: [{ type: "text", text: formatResult({ result, agent: "Pi", phase, repoPath: REPOS.pi }) }] };
    } catch (err) {
      log.pi(`[ERROR] ${err.message}`);
      return {
        content: [{ type: "text", text: `**Pi CC error:** ${err.message}\n\nReissue when ready.` }],
        isError: true,
      };
    }
  }
);

// Tool: run_mac_tc_cc
server.tool(
  "run_mac_tc_cc",
  "Execute a Claude Code task on the Mac against the Town Crier repo at ~/dev/town-crier. Use for iOS development, SwiftUI, Xcode builds, CoreLocation, AVSpeechSynthesizer, and iOS-specific native code. NOT for Android, Java, Pi corpus work, or Windows-side tasks.",
  {
    prompt: z.string().describe("The full prompt to send to Claude Code"),
    phase: z.enum(["investigate", "implement"]).default("investigate").describe(
      '"investigate" = read-only (Phase 1). "implement" = file writes + bash enabled (Phase 2, requires prior approval).'
    ),
  },
  async ({ prompt, phase }) => {
    log.mac_tc(`[TOOL] run_mac_tc_cc phase=${phase}`);
    try {
      const result = await runOnMac({ prompt, phase, repoPath: REPOS.mac_tc, logger: log.mac_tc });
      return { content: [{ type: "text", text: formatResult({ result, agent: "Mac TC", phase, repoPath: REPOS.mac_tc }) }] };
    } catch (err) {
      log.mac_tc(`[ERROR] ${err.message}`);
      return {
        content: [{ type: "text", text: `**Mac TC CC error:** ${err.message}\n\nCheck if Mac is awake and tunnel is up.` }],
        isError: true,
      };
    }
  }
);

// Tool: run_mac_menucha_cc
server.tool(
  "run_mac_menucha_cc",
  "Execute a Claude Code task on the Mac against the Menucha repo at ~/dev/menucha. Use for Menucha SwiftUI iOS target and iOS-specific platform layer (UNUserNotificationCenter, Guided Access, Koin DI). Not for Android, KMP shared logic, or Town Crier.",
  {
    prompt: z.string().describe("The full prompt to send to Claude Code"),
    phase: z.enum(["investigate", "implement"]).default("investigate").describe(
      '"investigate" = read-only (Phase 1). "implement" = file writes + bash enabled (Phase 2, requires prior approval).'
    ),
  },
  async ({ prompt, phase }) => {
    log.mac_menucha(`[TOOL] run_mac_menucha_cc phase=${phase}`);
    try {
      const result = await runOnMac({ prompt, phase, repoPath: REPOS.mac_menucha, logger: log.mac_menucha });
      return { content: [{ type: "text", text: formatResult({ result, agent: "Mac Menucha", phase, repoPath: REPOS.mac_menucha }) }] };
    } catch (err) {
      log.mac_menucha(`[ERROR] ${err.message}`);
      return {
        content: [{ type: "text", text: `**Mac Menucha CC error:** ${err.message}\n\nCheck if Mac is awake and tunnel is up.` }],
        isError: true,
      };
    }
  }
);

// Tool: run_menucha_cc
server.tool(
  "run_menucha_cc",
  "Execute a Claude Code task on the Dell machine against the Menucha repo at C:\\dev\\menucha. Use for Menucha Android Jetpack Compose UI, KMP shared logic, AlarmManager, Hilt DI, SQLDelight, Ktor, and Android-specific work. Not for iOS or Town Crier.",
  {
    prompt: z.string().describe("The full prompt to send to Claude Code"),
    phase: z.enum(["investigate", "implement"]).default("investigate").describe(
      '"investigate" = read-only (Phase 1). "implement" = file writes + bash enabled (Phase 2, requires prior approval).'
    ),
  },
  async ({ prompt, phase }) => {
    log.menucha(`[TOOL] run_menucha_cc phase=${phase}`);
    try {
      const result = await runOnDell({ prompt, phase, repoPath: REPOS.menucha, logger: log.menucha });
      return { content: [{ type: "text", text: formatResult({ result, agent: "Menucha", phase, repoPath: REPOS.menucha }) }] };
    } catch (err) {
      log.menucha(`[OFFLINE] ${err.message} — saving to pending queue`);
      const { id } = savePending({ agent: "menucha", prompt, phase });
      return {
        content: [{ type: "text", text: [
          `**Dell is unreachable** (reverse tunnel may not be established).`,
          ``,
          `Your prompt has been saved to the pending queue (ID: \`${id}\`).`,
          `It will run automatically when Dell reconnects.`,
          ``,
          `To reissue manually when Dell is back: just resend this same prompt.`,
        ].join("\n") }],
        isError: true,
      };
    }
  }
);
  return server;
}

// --- HTTP transport (per-session) ------------------------------------
const httpServer = createServer();
const sessions   = new Map();   // sessionId -> StreamableHTTPServerTransport

async function handleMcpRequest(req, res) {
  if (handleOAuth(req, res)) return;
  if (!isAuthorized(req)) {
    res.writeHead(401, {
      "Content-Type":     "application/json",
      "WWW-Authenticate": 'Bearer realm="Town Crier MCP"',
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const sessionId = req.headers["mcp-session-id"];

  // Route to an existing session
  if (sessionId) {
    const t = sessions.get(sessionId);
    if (!t) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }
    if (req.method === "DELETE") {
      await t.close();
      sessions.delete(sessionId);
      res.writeHead(204); res.end();
      return;
    }
    await t.handleRequest(req, res);
    return;
  }

  // New session — only POST (initialize) is valid here
  if (req.method !== "POST") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Request: no session" }));
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res);
  if (transport.sessionId) sessions.set(transport.sessionId, transport);
}

httpServer.on("request", (req, res) => {
  handleMcpRequest(req, res).catch((err) => {
    log.server(`[ERROR] request handler: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});
httpServer.listen(PORT, "127.0.0.1", () => {
  log.server(`MCP server listening on http://127.0.0.1:${PORT}`);
  console.log(`Town Crier MCP server running on port ${PORT}`);
});
httpServer.on("error", (err) => {
  log.server(`[FATAL] ${err.message}`);
  process.exit(1);
});
