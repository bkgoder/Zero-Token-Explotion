const vscode = require("vscode");
const fs = require("fs");
const { installRuntime, installWasmEdgeLocal, loadManifest } = require("./runtime-installer");

async function runSetupWizard(context, manager, outputChannel, force = false) {
  let manifest;
  try {
    manifest = await loadManifest();
  } catch (error) {
    vscode.window.showErrorMessage(`Runtime-Manifest nicht erreichbar: ${error.message || error}`);
    return false;
  }

  const detectedPlatform = process.platform;
  const detectedArchitecture = process.arch === "arm64" ? "arm64" : "x64";
  const detectedDistribution = detectDistribution();

  const platform = await pick("Welches Betriebssystem nutzt du?", [
    option(detectedPlatform === "linux" ? "$(check) Linux (erkannt)" : "Linux", "Ubuntu, Debian, Fedora, Arch und kompatible Systeme", "linux"),
    option(detectedPlatform === "win32" ? "$(check) Windows (erkannt)" : "Windows", "Windows 10 oder 11", "windows"),
    option(detectedPlatform === "darwin" ? "$(check) macOS (erkannt)" : "macOS", "Intel oder Apple Silicon", "darwin"),
  ]);
  if (!platform) return false;

  let distribution = "other";
  if (platform === "linux") {
    distribution = await pick("Welche Linux-Distribution nutzt du?", [
      option(detectedDistribution === "ubuntu" ? "$(check) Ubuntu (erkannt)" : "Ubuntu", "Debian-basiert", "ubuntu"),
      option(detectedDistribution === "debian" ? "$(check) Debian (erkannt)" : "Debian", "Debian GNU/Linux", "debian"),
      option(detectedDistribution === "fedora" ? "$(check) Fedora (erkannt)" : "Fedora", "Fedora Linux", "fedora"),
      option(detectedDistribution === "rhel" ? "$(check) RHEL / Rocky / CentOS (erkannt)" : "RHEL / Rocky / CentOS", "Enterprise-Linux-Familie", "rhel"),
      option(detectedDistribution === "arch" ? "$(check) Arch Linux (erkannt)" : "Arch Linux", "Arch-basiert", "arch"),
      option(detectedDistribution === "manjaro" ? "$(check) Manjaro (erkannt)" : "Manjaro", "Arch-basiert", "manjaro"),
      option("Andere Linux-Distribution", "Kompatibilitätsmodus", "other"),
    ]);
    if (!distribution) return false;
  }

  const architecture = await pick("Welche CPU-Architektur nutzt dein System?", [
    option(detectedArchitecture === "x64" ? "$(check) x86_64 / AMD64 (erkannt)" : "x86_64 / AMD64", "Intel und AMD 64 Bit", "x64"),
    option(detectedArchitecture === "arm64" ? "$(check) ARM64 / aarch64 (erkannt)" : "ARM64 / aarch64", "ARM 64 Bit", "arm64"),
  ]);
  if (!architecture) return false;

  const backendOptions = Object.entries(manifest.backends).map(([id, backend]) => option(
    `${backend.status === "stable" ? "$(check)" : "$(beaker)"} ${id}`,
    backend.status === "stable" ? "Stabiles lokales Backend" : `Experimentell · ${backend.sourceRepository || "noch nicht veröffentlicht"}`,
    id,
  ));
  const backendId = await pick("Welches TTS-Backend möchtest du verwenden?", backendOptions);
  if (!backendId) return false;
  const backend = manifest.backends[backendId];
  if (backend.status !== "stable") {
    await vscode.window.showWarningMessage(
      `${backendId} ist noch experimentell und besitzt noch kein freigegebenes Runtime-Paket. Quelle: ${backend.sourceRepository || "unbekannt"}/${backend.sourcePath || ""}`,
      { modal: true },
    );
    return false;
  }

  const targetId = `${platform}-${architecture}`;
  if (!backend.targets || !backend.targets[targetId]) {
    await vscode.window.showWarningMessage(
      `Im Runtime-Git ${manifest.repository} ist noch kein stabiles Paket für ${targetId} freigegeben. Es wurde nichts installiert.`,
      { modal: true },
    );
    return false;
  }

  const installWasmEdge = await pick("Soll WasmEdge zusätzlich lokal eingerichtet werden?", [
    option("$(check) Ja, vollständig einrichten", "Lokale WASM-Kompatibilität ohne sudo", true),
    option("Nein, nur das native TTS-Backend", "Für Piper ausreichend", false),
  ]);
  if (installWasmEdge === undefined) return false;

  const modelId = backend.defaultModel;
  const model = manifest.models && manifest.models[modelId];
  const confirmation = await vscode.window.showInformationMessage(
    [
      `Installationsquelle: ${manifest.repository}`,
      `Manifest: ${manifest.manifestVersion}`,
      `System: ${platform}/${architecture}`,
      platform === "linux" ? `Distribution: ${distribution}` : null,
      `Backend: ${backendId}`,
      `Stimme: ${model ? `${model.voice} (${model.language})` : modelId}`,
      `WasmEdge: ${installWasmEdge ? "ja" : "nein"}`,
    ].filter(Boolean).join("\n"),
    { modal: true },
    force ? "Neu installieren" : "Jetzt installieren",
  );
  if (!confirmation) return false;

  try {
    const apiPort = vscode.workspace.getConfiguration("zero-token-tts").get("ttsApiPort", 18765);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Zero-Token TTS wird vollständig eingerichtet",
      cancellable: false,
    }, async (progress) => {
      await installRuntime(context, backendId, progress, outputChannel, force);
      if (installWasmEdge) await installWasmEdgeLocal(context, progress, outputChannel, force);

      await vscode.workspace.getConfiguration("zero-token-tts").update("activeModel", modelId, vscode.ConfigurationTarget.Global);
      if (model) {
        await vscode.workspace.getConfiguration("zero-token-tts").update("voice", model.voice, vscode.ConfigurationTarget.Global);
        await vscode.workspace.getConfiguration("zero-token-tts").update("language", String(model.language).split("-")[0], vscode.ConfigurationTarget.Global);
      }
      await vscode.workspace.getConfiguration("zero-token-tts").update("installWasmEdge", installWasmEdge, vscode.ConfigurationTarget.Global);

      await context.globalState.update("zeroTokenTts.setupCompleted", true);
      await vscode.commands.executeCommand("zero-token-tts.startServer");
      let healthy = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await manager.checkHealth(apiPort)) {
          healthy = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!healthy) throw new Error("Healthcheck des TTS-Servers fehlgeschlagen");
    });

    const state = {
      sourceRepository: manifest.repository,
      manifestVersion: manifest.manifestVersion,
      platform,
      architecture,
      distribution,
      backendId,
      modelId,
      installWasmEdge,
      completedAt: new Date().toISOString(),
    };
    await context.globalState.update("zeroTokenTts.setupCompleted", true);
    await context.globalState.update("zeroTokenTts.setupSelection", state);
    outputChannel.appendLine(`[Setup] Erfolgreich: ${JSON.stringify(state)}`);
    vscode.window.showInformationMessage("Zero-Token TTS wurde vollständig eingerichtet und gestartet.");
    return true;
  } catch (error) {
    await context.globalState.update("zeroTokenTts.setupCompleted", false);
    outputChannel.appendLine(`[Setup] Fehler: ${error && error.stack ? error.stack : error}`);
    outputChannel.show(true);
    vscode.window.showErrorMessage(`TTS-Einrichtung fehlgeschlagen: ${error && error.message ? error.message : error}`);
    return false;
  }
}

function detectDistribution() {
  if (process.platform !== "linux") return "other";
  try {
    const text = fs.readFileSync("/etc/os-release", "utf8");
    const id = ((text.match(/^ID=(.+)$/m) || [])[1] || "other").replace(/["']/g, "").toLowerCase();
    const like = ((text.match(/^ID_LIKE=(.+)$/m) || [])[1] || "").replace(/["']/g, "").toLowerCase();
    const all = `${id} ${like}`;
    if (all.includes("ubuntu")) return "ubuntu";
    if (all.includes("debian")) return "debian";
    if (all.includes("fedora")) return "fedora";
    if (all.includes("rhel") || all.includes("centos") || all.includes("rocky")) return "rhel";
    if (id.includes("manjaro")) return "manjaro";
    if (all.includes("arch")) return "arch";
    return id;
  } catch {
    return "other";
  }
}

function option(label, description, value) {
  return { label, description, value };
}

async function pick(placeHolder, items) {
  const selected = await vscode.window.showQuickPick(items, { placeHolder, ignoreFocusOut: true });
  return selected ? selected.value : undefined;
}

module.exports = { runSetupWizard };
