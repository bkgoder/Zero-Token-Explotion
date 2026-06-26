const vscode = require("vscode");
const http = require("http");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const MODELS = [
  { id: "de_DE-eva_k-x_low",               label: "🇩🇪 Eva — Deutsch weiblich (20 MB, schnell)",   voice: "eva",      lang: "de" },
  { id: "de_DE-thorsten_emotional-medium",  label: "🇩🇪 Thorsten — Deutsch männlich (42 MB)",       voice: "thorsten", lang: "de" },
  { id: "en_GB-alan-medium",                label: "🇬🇧 Alan — English UK male (30 MB)",            voice: "alan",     lang: "en" },
  { id: "en_US-amy-medium",                 label: "🇺🇸 Amy — English US female (37 MB)",           voice: "amy",      lang: "en" },
];

function checkDockerHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "localhost", port, path: "/health", timeout: 3000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function startDocker(workspaceDir, outputChannel) {
  return new Promise((resolve) => {
    outputChannel.appendLine("[Setup] docker compose up -d...");
    exec(`cd "${workspaceDir}" && docker compose up -d 2>&1`, { timeout: 120000 }, (err, stdout) => {
      outputChannel.appendLine("[Docker] " + String(stdout || "").slice(0, 400));
      resolve(!err);
    });
  });
}

function deployMcp(targetPath, outputChannel) {
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    let data = {};
    if (fs.existsSync(targetPath)) {
      try { data = JSON.parse(fs.readFileSync(targetPath, "utf8")); } catch {}
    }
    if (!data.servers) data.servers = {};
    data.servers["zero-token-tts"] = { type: "sse", url: "http://localhost:18764/sse" };
    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2));
    outputChannel.appendLine("[Setup] MCP: " + targetPath);
  } catch (e) {
    outputChannel.appendLine("[Setup] MCP-Fehler: " + e.message);
  }
}

function deploySkill(src, dest, outputChannel) {
  try {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    outputChannel.appendLine("[Setup] Skill: " + dest);
  } catch (e) {
    outputChannel.appendLine("[Setup] Skill-Fehler: " + e.message);
  }
}

async function runSetupWizard(context, manager, outputChannel, force = false) {
  const config = vscode.workspace.getConfiguration("zero-token-tts");
  const ttsPort = config.get("ttsApiPort", 18765);
  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || "";
  const alreadySetup = context.globalState.get("zeroTokenTts.setupCompleted");

  // 1. Stimme wählen (beim ersten Start oder force)
  if (!alreadySetup || force) {
    const chosen = await vscode.window.showQuickPick(
      MODELS.map((m) => ({ label: m.label, description: m.id, model: m })),
      {
        title: "🔊 Zero-Token TTS — Stimme wählen",
        placeHolder: "Welche Sprache / Stimme möchtest du verwenden?",
        ignoreFocusOut: true,
      }
    );
    if (!chosen) {
      outputChannel.appendLine("[Setup] Abgebrochen");
      return false;
    }
    const m = chosen.model;
    await config.update("activeModel", m.id, vscode.ConfigurationTarget.Global);
    await config.update("voice", m.voice, vscode.ConfigurationTarget.Global);
    await config.update("language", m.lang, vscode.ConfigurationTarget.Global);
    outputChannel.appendLine("[Setup] Stimme: " + m.label);
  }

  // 2. Docker starten falls nötig
  let healthy = await checkDockerHealth(ttsPort);
  if (!healthy && workspaceDir) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "🐳 Docker wird gestartet…", cancellable: false },
      async (progress) => {
        await startDocker(workspaceDir, outputChannel);
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          healthy = await checkDockerHealth(ttsPort);
          if (healthy) break;
          progress.report({ message: `Warte… ${(i + 1) * 2}s` });
        }
      }
    );
  }

  if (!healthy) {
    vscode.window.showErrorMessage(
      `❌ Docker-Container antwortet nicht (Port ${ttsPort}). Manuell starten: docker compose up -d`,
      "In Zwischenablage"
    ).then((a) => { if (a) vscode.env.clipboard.writeText("docker compose up -d"); });
    return false;
  }

  // 3. MCP überall eintragen
  if (workspaceDir) {
    deployMcp(path.join(workspaceDir, ".vscode", "mcp.json"), outputChannel);
    const skillSrc = path.join(workspaceDir, "skills", "tts-de", "SKILL.md");
    deploySkill(skillSrc, path.join(workspaceDir, ".github", "copilot-instructions.md"), outputChannel);
    deploySkill(skillSrc, path.join(workspaceDir, ".vscode", "tts-de.instructions.md"), outputChannel);
  }
  const home = process.env.HOME || "";
  for (const dir of [path.join(home, ".config", "Code", "User"), path.join(home, ".vscode-remote", "data", "User")]) {
    if (fs.existsSync(dir)) deployMcp(path.join(dir, "mcp.json"), outputChannel);
  }

  // 4. Fertig
  await context.globalState.update("zeroTokenTts.setupCompleted", true);
  vscode.window.showInformationMessage(
    "✅ Zero-Token TTS bereit — MCP + Skill registriert.",
    "Voice Studio öffnen"
  ).then((b) => { if (b) vscode.commands.executeCommand("zero-token-tts.openDashboard"); });

  return true;
}

module.exports = { runSetupWizard };
