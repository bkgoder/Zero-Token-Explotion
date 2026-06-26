const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const core = require("../dist/extension.js");
const { getServerManager } = require("../dist/bootstrap.js");
const { runSetupWizard } = require("./setup-wizard.js");

let outputChannel;

async function activate(context) {
  fs.mkdirSync(context.globalStoragePath, { recursive: true });
  outputChannel = vscode.window.createOutputChannel("Zero-Token TTS Setup");
  context.subscriptions.push(outputChannel);

  const manager = getServerManager(outputChannel);
  const config = vscode.workspace.getConfiguration("zero-token-tts");
  const firstRun = !context.globalState.get("zeroTokenTts.setupCompleted", false);
  const autoBootstrap = config.get("autoBootstrap", true);
  const oldMarker = path.join(context.globalStoragePath, "firstRun.txt");
  if (!fs.existsSync(oldMarker)) fs.writeFileSync(oldMarker, "managed-by-runtime-wizard", "utf8");

  context.subscriptions.push(vscode.commands.registerCommand("zero-token-tts.bootstrap", async () => {
    await runSetupWizard(context, manager, outputChannel, true);
  }));

  if (firstRun && autoBootstrap) {
    await config.update("autoBootstrap", false, vscode.ConfigurationTarget.Global);
  }

  let coreError;
  try {
    await core.activate(context);
  } catch (error) {
    coreError = error;
    outputChannel.appendLine(`[Activation] Kern konnte nicht vollständig geladen werden: ${error && error.stack ? error.stack : error}`);
    outputChannel.show(true);
  } finally {
    if (firstRun && autoBootstrap) {
      await config.update("autoBootstrap", true, vscode.ConfigurationTarget.Global);
    }
  }

  const commands = new Set(await vscode.commands.getCommands(true));
  if (!commands.has("zero-token-tts.startServer")) {
    context.subscriptions.push(vscode.commands.registerCommand("zero-token-tts.startServer", async () => {
      if (!context.globalState.get("zeroTokenTts.setupCompleted", false)) {
        const ready = await runSetupWizard(context, manager, outputChannel, false);
        if (!ready) return;
      }
      const apiPort = vscode.workspace.getConfiguration("zero-token-tts").get("ttsApiPort", 18765);
      const started = await manager.start(apiPort);
      if (started) vscode.window.showInformationMessage(`TTS-Server läuft auf Port ${apiPort}`);
      else vscode.window.showErrorMessage("TTS-Server konnte nicht gestartet werden. Bitte vollständige Einrichtung ausführen.");
    }));
  }

  if (!commands.has("zero-token-tts.stopServer")) {
    context.subscriptions.push(vscode.commands.registerCommand("zero-token-tts.stopServer", () => manager.stop()));
  }

  if (firstRun && autoBootstrap) {
    setTimeout(() => void runSetupWizard(context, manager, outputChannel, false), coreError ? 200 : 700);
  }
}

function deactivate() {
  try {
    if (core && typeof core.deactivate === "function") core.deactivate();
  } finally {
    if (outputChannel) outputChannel.dispose();
  }
}

module.exports = { activate, deactivate };
