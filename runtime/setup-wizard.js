const vscode = require("vscode");
const http = require("http");

// ── Docker-Health-Check ───────────────────────────────────────────────────────
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

async function runSetupWizard(context, manager, outputChannel, force = false) {
  const ttsPort = vscode.workspace.getConfiguration("zero-token-tts").get("ttsApiPort", 18765);
  const healthy = await checkDockerHealth(ttsPort);

  if (healthy) {
    await context.globalState.update("zeroTokenTts.setupCompleted", true);
    if (force) vscode.window.showInformationMessage("✅ Zero-Token TTS Docker-Container läuft und ist bereit.");
    outputChannel.appendLine("[Setup] Docker-Container erreichbar auf Port " + ttsPort);
    return true;
  }

  const action = await vscode.window.showErrorMessage(
    `❌ Zero-Token TTS Docker-Container nicht erreichbar (Port ${ttsPort}). Bitte starte den Container:`,
    "Befehl kopieren",
    "Abbrechen"
  );

  if (action === "Befehl kopieren") {
    await vscode.env.clipboard.writeText("docker compose up -d");
    vscode.window.showInformationMessage("Befehl kopiert: docker compose up -d");
  }

  outputChannel.appendLine("[Setup] Docker-Container NICHT erreichbar auf Port " + ttsPort);
  return false;
}

module.exports = { runSetupWizard };
