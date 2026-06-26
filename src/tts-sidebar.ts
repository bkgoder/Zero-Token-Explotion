import * as vscode from "vscode";
import { clearTtsHistory, getTtsHistory, getTtsHistoryCount, persistDatabase, type TtsHistoryRow } from "./database";
import { getServerManager, type PiperModel, type ServerStatus } from "./tts-bootstrap";
import { type TtsTreeProvider } from "./tts-tree";

type DashboardTab = "speak" | "voices" | "clone" | "history" | "admin";
type SpeakHandler = (text: string, source?: string) => Promise<void>;

interface ModelSnapshot extends PiperModel {
  downloaded: boolean;
  active: boolean;
}

interface VoiceProfile {
  id: string;
  name: string;
  createdAt: string;
  baseModel: string;
}

interface ApiKeyEntry {
  key: string;
  preview: string;
  name: string;
  createdAt: string;
}

interface DashboardSnapshot {
  status: ServerStatus;
  healthy: boolean;
  models: ModelSnapshot[];
  catalogModels: ModelSnapshot[];
  history: TtsHistoryRow[];
  historyCount: number;
  autoPlay: boolean;
  activeModel: string;
  voice: string;
  language: string;
  proxyPort: number;
  apiPort: number;
  masterKey: string;
  masterKeyClaimed: boolean;
  apiKeys: ApiKeyEntry[];
  voiceProfiles: VoiceProfile[];
}

export class TtsSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "zeroTokenTtsDashboard";

  private view?: vscode.WebviewView;
  private pendingTab: DashboardTab = "speak";
  private refreshTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly treeProvider: TtsTreeProvider,
    private readonly speakHandler: SpeakHandler,
    private readonly context: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "resources")],
    };

    const logoUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "tts-logo.svg"),
    );
    view.webview.html = this.getHtml(view.webview, logoUri);

    this.disposables.push(
      view.webview.onDidReceiveMessage((message) => this.handleMessage(message)),
      view.onDidChangeVisibility(() => {
        if (view.visible) void this.refresh();
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );

    this.startPolling();
    void this.refresh();
    this.post({ type: "selectTab", tab: this.pendingTab });
  }

  async focus(tab: DashboardTab = "speak"): Promise<void> {
    this.pendingTab = tab;
    await vscode.commands.executeCommand("workbench.view.extension.zeroTokenTts");
    await vscode.commands.executeCommand(`${TtsSidebarProvider.viewType}.focus`);
    this.post({ type: "selectTab", tab });
    await this.refresh();
  }

  async replayLatest(): Promise<void> {
    const entry = getTtsHistory(1)[0];
    if (!entry) {
      vscode.window.showInformationMessage("Noch keine TTS-Ausgabe im Verlauf");
      return;
    }
    await this.treeProvider.replayEntry(entry);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    try {
      const snapshot = await this.createSnapshot();
      this.post({ type: "snapshot", payload: snapshot });
    } catch (error: any) {
      this.outputChannel.appendLine(`[Dashboard] Aktualisierung fehlgeschlagen: ${error?.message ?? error}`);
      this.post({ type: "dashboardError", message: error?.message ?? String(error) });
    }
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private startPolling(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      if (this.view?.visible) void this.refresh();
    }, 5000);
  }

  private async createSnapshot(): Promise<DashboardSnapshot> {
    const config = vscode.workspace.getConfiguration("zero-token-tts");
    const apiPort = config.get<number>("ttsApiPort", 18765);
    const proxyPort = config.get<number>("serverPort", 18766);
    const activeModel = config.get<string>("activeModel", "de_DE-eva_k-x_low");
    const serverManager = getServerManager(this.outputChannel);
    const healthy = await serverManager.checkHealth(apiPort);
    const status = healthy ? { state: "running", port: apiPort } as ServerStatus : serverManager.status;
    const models = serverManager.getAvailableModels().map((model) => ({
      ...model,
      downloaded: serverManager.isModelDownloaded(model),
      active: model.id === activeModel,
    }));

    // Fetch catalog + admin data from Docker if healthy
    let catalogModels: ModelSnapshot[] = models;
    let masterKey = this.context.globalState.get<string>("masterApiKey", "");
    let masterKeyClaimed = this.context.globalState.get<boolean>("masterKeyClaimed", false);
    let apiKeys: ApiKeyEntry[] = [];
    let voiceProfiles: VoiceProfile[] = [];

    if (healthy) {
      try {
        const catalogData = await fetchJson(`http://localhost:${apiPort}/api/models/catalog`);
        if (catalogData?.models) {
          catalogModels = catalogData.models;
        }
      } catch { /* Docker API not accessible */ }

      if (masterKey) {
        try {
          const keysData = await fetchJson(`http://localhost:${apiPort}/api/admin/keys`, { "x-master-key": masterKey });
          if (keysData?.keys) apiKeys = keysData.keys;
        } catch { /* ignore */ }
        try {
          const profilesData = await fetchJson(`http://localhost:${apiPort}/api/voice-clone/profiles`);
          if (profilesData?.profiles) voiceProfiles = profilesData.profiles;
        } catch { /* ignore */ }
      }
    }

    return {
      status,
      healthy,
      models,
      catalogModels,
      history: getTtsHistory(60),
      historyCount: getTtsHistoryCount(),
      autoPlay: this.treeProvider.autoPlay,
      activeModel,
      voice: config.get<string>("voice", "eva"),
      language: config.get<string>("language", "de"),
      proxyPort,
      apiPort,
      masterKey,
      masterKeyClaimed,
      apiKeys,
      voiceProfiles,
    };
  }

  private async handleMessage(message: any): Promise<void> {
    const command = message?.command;
    const config = vscode.workspace.getConfiguration("zero-token-tts");
    const serverManager = getServerManager(this.outputChannel);
    const apiPort = config.get<number>("ttsApiPort", 18765);

    try {
      switch (command) {
        case "ready":
        case "refresh":
          await this.refresh();
          return;

        case "speakText": {
          const text = String(message.text ?? "").trim();
          if (!text) {
            vscode.window.showInformationMessage("Bitte zuerst Text eingeben");
            return;
          }
          this.post({ type: "busy", value: true, label: "Sprache wird erzeugt…" });
          await this.speakHandler(text, "dashboard");
          this.post({ type: "busy", value: false });
          await this.refresh();
          return;
        }

        case "speakClipboard": {
          const text = (await vscode.env.clipboard.readText()).trim();
          if (!text) {
            vscode.window.showInformationMessage("Zwischenablage ist leer");
            return;
          }
          await this.speakHandler(text, "clipboard");
          await this.refresh();
          return;
        }

        case "speakSelection": {
          const editor = vscode.window.activeTextEditor;
          const text = editor?.document.getText(editor.selection).trim() ?? "";
          if (!text) {
            vscode.window.showInformationMessage("Kein Text im Editor ausgewählt");
            return;
          }
          await this.speakHandler(text, "selection");
          await this.refresh();
          return;
        }

        case "replayHistory": {
          const id = Number(message.id);
          const entry = getTtsHistory(500).find((item) => item.id === id);
          if (!entry) {
            vscode.window.showWarningMessage("Verlaufseintrag wurde nicht gefunden");
            return;
          }
          await this.treeProvider.replayEntry(entry);
          await this.refresh();
          return;
        }

        case "clearHistory": {
          const choice = await vscode.window.showWarningMessage(
            "Gesamten TTS-Verlauf löschen?",
            { modal: true },
            "Löschen",
          );
          if (choice !== "Löschen") return;
          clearTtsHistory();
          persistDatabase();
          this.treeProvider.refresh();
          await vscode.commands.executeCommand("setContext", "zeroTokenTts:historyCount", 0);
          await this.refresh();
          return;
        }

        case "toggleAutoPlay":
          this.treeProvider.setAutoPlay(Boolean(message.value));
          await this.refresh();
          return;

        case "selectModel": {
          const modelId = String(message.modelId ?? "");
          const model = serverManager.getAvailableModels().find((item) => item.id === modelId);
          if (!model) return;
          await config.update("activeModel", model.id, vscode.ConfigurationTarget.Global);
          await config.update("voice", model.voice, vscode.ConfigurationTarget.Global);
          await config.update("language", model.lang, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`${model.label} ist jetzt aktiv`);
          await this.refresh();
          return;
        }

        case "downloadModel": {
          const modelId = String(message.modelId ?? "");
          const model = serverManager.getAvailableModels().find((item) => item.id === modelId);
          if (!model) return;
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `${model.label} wird installiert`,
              cancellable: false,
            },
            async (progress) => {
              const ok = await serverManager.downloadModel(model, progress);
              if (!ok) throw new Error(`Download fehlgeschlagen: ${model.label}`);
            },
          );
          vscode.window.showInformationMessage(`${model.label} wurde installiert`);
          await this.refresh();
          return;
        }

        case "bootstrap":
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Zero-Token TTS wird eingerichtet",
              cancellable: false,
            },
            async (progress) => {
              const ok = await serverManager.downloadAll(progress);
              if (!ok) throw new Error("TTS-Einrichtung fehlgeschlagen");
              await serverManager.start(apiPort);
            },
          );
          await this.refresh();
          return;

        case "startServer":
          await serverManager.start(apiPort);
          await this.refresh();
          return;

        case "stopServer":
          serverManager.stop();
          await this.refresh();
          return;

        case "restartServer":
          await serverManager.restart(apiPort);
          await this.refresh();
          return;

        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:forgefabrik.zero-token-tts");
          return;

        case "openModelDashboard":
          await vscode.commands.executeCommand("zero-token-tts.openModelDashboard");
          return;

        case "openOutput":
          this.outputChannel.show(true);
          return;

        // ── Admin: API Key Management ─────────────────────────────────────────
        case "claimMasterKey": {
          try {
            const res = await fetchJson(`http://localhost:${apiPort}/api/setup`);
            if (res?.masterKey) {
              await this.context.globalState.update("masterApiKey", res.masterKey);
              await this.context.globalState.update("masterKeyClaimed", true);
              this.post({ type: "masterKeyRevealed", key: res.masterKey });
              vscode.window.showInformationMessage("Master-Key erfolgreich gespeichert!");
            } else {
              vscode.window.showWarningMessage(res?.error || "Master-Key konnte nicht abgerufen werden.");
            }
          } catch (e: any) {
            vscode.window.showErrorMessage(`Fehler beim Claimen: ${e.message}`);
          }
          await this.refresh();
          return;
        }

        case "copyMasterKey": {
          const key = this.context.globalState.get<string>("masterApiKey", "");
          if (key) {
            await vscode.env.clipboard.writeText(key);
            vscode.window.showInformationMessage("Master-Key in Zwischenablage kopiert");
          }
          return;
        }

        case "createApiKey": {
          const name = await vscode.window.showInputBox({ prompt: "Name für den neuen API-Key", placeHolder: "z.B. mein-agent" });
          if (!name) return;
          const masterKey = this.context.globalState.get<string>("masterApiKey", "");
          const res = await fetch(`http://localhost:${apiPort}/api/admin/keys`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-master-key": masterKey },
            body: JSON.stringify({ name }),
          });
          const data = await res.json() as any;
          if (data?.key) {
            await vscode.env.clipboard.writeText(data.key);
            vscode.window.showInformationMessage(`Key "${name}" erstellt & in Zwischenablage kopiert`);
          }
          await this.refresh();
          return;
        }

        case "revokeApiKey": {
          const keyToRevoke = String(message.key ?? "");
          const keyName = String(message.name ?? keyToRevoke.substring(0, 12));
          const confirm = await vscode.window.showWarningMessage(`Key "${keyName}" wirklich widerrufen?`, { modal: true }, "Widerrufen");
          if (confirm !== "Widerrufen") return;
          const masterKey = this.context.globalState.get<string>("masterApiKey", "");
          await fetch(`http://localhost:${apiPort}/api/admin/keys`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json", "x-master-key": masterKey },
            body: JSON.stringify({ key: keyToRevoke }),
          });
          vscode.window.showInformationMessage("Key widerrufen");
          await this.refresh();
          return;
        }

        // ── Model Catalog ─────────────────────────────────────────────────────
        case "downloadModelFromCatalog": {
          const modelId = String(message.modelId ?? "");
          this.post({ type: "downloadStarted", modelId });
          try {
            const res = await fetch(`http://localhost:${apiPort}/api/models/download`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ modelId }),
            });
            const data = await res.json() as any;
            if (data.status === "started" || data.status === "already downloading") {
              vscode.window.showInformationMessage(`Download gestartet: ${modelId}`);
              // Poll until done
              void this.pollModelDownload(modelId, apiPort);
            }
          } catch (e: any) {
            this.post({ type: "downloadError", modelId, error: e.message });
          }
          return;
        }

        case "activateModel": {
          const modelId = String(message.modelId ?? "");
          await fetch(`http://localhost:${apiPort}/api/models/activate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelId }),
          });
          await config.update("activeModel", modelId, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Stimme aktiviert: ${modelId}`);
          await this.refresh();
          return;
        }

        // ── Voice Clone ───────────────────────────────────────────────────────
        case "uploadVoiceSample": {
          const voiceName = String(message.name ?? "Meine Stimme");
          const audioBase64 = String(message.audioBase64 ?? "");
          if (!audioBase64) { vscode.window.showWarningMessage("Kein Audio empfangen"); return; }
          const buf = Buffer.from(audioBase64.replace(/\s/g, ""), "base64");
          try {
            const res = await fetch(`http://localhost:${apiPort}/api/voice-clone/upload`, {
              method: "POST",
              headers: { "Content-Type": "audio/wav", "x-voice-name": voiceName },
              body: buf,
            });
            const data = await res.json() as any;
            if (data.success) {
              vscode.window.showInformationMessage(`Stimmprofil "${voiceName}" gespeichert!`);
            } else {
              vscode.window.showErrorMessage(`Upload fehlgeschlagen: ${data.error}`);
            }
          } catch (e: any) {
            vscode.window.showErrorMessage(`Upload-Fehler: ${e.message}`);
          }
          await this.refresh();
          return;
        }

        case "deleteVoiceProfile": {
          const profileId = String(message.profileId ?? "");
          const confirm = await vscode.window.showWarningMessage("Stimmprofil löschen?", { modal: true }, "Löschen");
          if (confirm !== "Löschen") return;
          await fetch(`http://localhost:${apiPort}/api/voice-clone/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
          await this.refresh();
          return;
        }
      }
    } catch (error: any) {
      this.post({ type: "busy", value: false });
      this.outputChannel.appendLine(`[Dashboard] ${command}: ${error?.stack ?? error}`);
      vscode.window.showErrorMessage(error?.message ?? String(error));
      await this.refresh();
    }
  }

  public postMessage(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async pollModelDownload(modelId: string, apiPort: number): Promise<void> {
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const prog = await fetchJson(`http://localhost:${apiPort}/api/models/progress/${encodeURIComponent(modelId)}`);
        this.post({ type: "downloadProgress", modelId, ...prog });
        if (prog?.status === "done" || prog?.status === "error") {
          if (prog.status === "done") vscode.window.showInformationMessage(`✅ Modell heruntergeladen: ${modelId}`);
          await this.refresh();
          return;
        }
      } catch { break; }
    }
  }

  private getHtml(webview: vscode.Webview, logoUri: vscode.Uri): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      "font-src data:",
      "media-src blob:",
    ].join("; ");

    return `<!doctype html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Zero-Token TTS</title>
  <style>
    /* ══ Design Tokens ═══════════════════════════════════════════════════════ */
    :root {
      color-scheme: light dark;
      --r1: 5px; --r2: 8px; --r3: 13px;
      --accent: var(--vscode-focusBorder);
      --surface: color-mix(in srgb, var(--vscode-editor-background) 84%, transparent);
      --surface2: color-mix(in srgb, var(--vscode-sideBar-background) 85%, var(--vscode-editor-background));
      --bd: var(--vscode-widget-border);
      --muted: var(--vscode-descriptionForeground);
      --dur: 110ms;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-width: 190px; overflow-x: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: 12px/1.5 var(--vscode-font-family);
      -webkit-font-smoothing: antialiased;
    }
    button, textarea, input, select { font: inherit; }
    :focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
    img { display: block; }

    /* ══ Hero ════════════════════════════════════════════════════════════════ */
    .hero {
      padding: clamp(10px,3vw,15px) clamp(10px,3vw,14px) 10px;
      border-bottom: 1px solid var(--bd);
      background:
        radial-gradient(ellipse 70% 60% at 110% -10%, color-mix(in srgb,#7c3aed 22%, transparent), transparent),
        linear-gradient(160deg,
          color-mix(in srgb, var(--vscode-sideBar-background) 88%, #2563eb 12%),
          var(--vscode-sideBar-background) 65%);
    }
    .brand { display: flex; gap: clamp(8px,2.5vw,12px); align-items: center; }
    .logo-wrap {
      width: clamp(34px,10vw,42px); height: clamp(34px,10vw,42px); flex: 0 0 clamp(34px,10vw,42px);
      display: grid; place-items: center; border-radius: var(--r3);
      background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
      border: 1px solid color-mix(in srgb, #7c3aed 30%, transparent);
      box-shadow: 0 4px 18px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.06);
    }
    .logo { width: clamp(22px,6vw,30px); height: clamp(22px,6vw,30px); }
    .brand-text h1 { font-size: clamp(12px,4vw,15px); font-weight: 700; line-height: 1.2; }
    .brand-text .sub { margin-top: 2px; font-size: clamp(9px,2.5vw,11px); color: var(--muted); }
    .hero-bottom { display: flex; align-items: center; justify-content: space-between; margin-top: 9px; gap: 6px; }
    .status-pill {
      display: inline-flex; align-items: center; gap: 5px; min-width: 0;
      padding: 3px clamp(7px,2vw,10px); border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-badge-background) 50%, transparent);
      color: var(--vscode-badge-foreground); font-size: 10px; font-weight: 600;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    }
    .dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--muted); }
    .dot.running { background: #22c55e; box-shadow: 0 0 0 2.5px rgba(34,197,94,.2); }
    .dot.starting { background: #f59e0b; animation: blink .9s infinite; }
    .dot.error   { background: #ef4444; }
    @keyframes blink { 50% { opacity: .2; } }
    .hero-btns { display: flex; gap: 4px; flex-shrink: 0; }

    /* ══ Tabs ════════════════════════════════════════════════════════════════ */
    .tabs {
      position: sticky; top: 0; z-index: 10;
      display: grid; grid-template-columns: repeat(5, 1fr); gap: 2px;
      padding: 5px 5px 4px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 93%, transparent);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--bd);
    }
    .tab {
      min-width: 0; padding: 5px 1px; border: 0; border-radius: var(--r1);
      color: var(--muted); background: transparent; cursor: pointer;
      font-size: clamp(8px,2.3vw,10px); line-height: 1.3;
      transition: background var(--dur), color var(--dur);
      overflow: hidden;
    }
    .tab:hover  { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); font-weight: 600; }
    .tab-icon   { display: block; font-size: clamp(11px,3.5vw,14px); margin-bottom: 2px; }

    /* ══ Layout ══════════════════════════════════════════════════════════════ */
    main { padding: clamp(6px,2vw,10px); }
    .panel { display: none; }
    .panel.active { display: block; animation: enter .1s ease-out; }
    @keyframes enter { from { opacity: 0; transform: translateY(3px); } }

    /* ══ Card ════════════════════════════════════════════════════════════════ */
    .card {
      margin-bottom: 8px; padding: clamp(9px,2.5vw,12px);
      border: 1px solid var(--bd); border-radius: var(--r2);
      background: var(--surface);
    }
    .card-title { font-size: clamp(11px,3vw,12.5px); font-weight: 700; margin-bottom: 7px; }
    .card-sub   { font-size: 10px; color: var(--muted); margin: -4px 0 8px; }
    .card-hd    { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; margin-bottom: 8px; }
    .card-hd .card-title { margin-bottom: 2px; }

    /* ══ Type ════════════════════════════════════════════════════════════════ */
    .muted  { color: var(--muted); }
    .small  { font-size: 10px; }
    .xsmall { font-size: 9px; }
    .trunc  { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

    /* ══ Forms ═══════════════════════════════════════════════════════════════ */
    textarea {
      width: 100%; min-height: 92px; resize: vertical;
      padding: clamp(7px,2vw,9px); border-radius: var(--r1);
      border: 1px solid var(--vscode-input-border, var(--bd));
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      transition: border-color var(--dur);
    }
    textarea:focus { border-color: var(--accent); }
    textarea::placeholder { color: var(--muted); }
    input[type=text], input[type=password] {
      width: 100%; padding: 6px 8px; border-radius: var(--r1);
      border: 1px solid var(--vscode-input-border, var(--bd));
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      transition: border-color var(--dur);
    }
    input[type=text]:focus, input[type=password]:focus { border-color: var(--accent); }
    input[type=range] { width: 100%; accent-color: var(--accent); cursor: pointer; }
    .counter { text-align: right; font-size: 10px; color: var(--muted); margin-top: 3px; }

    /* ══ Flex/Grid helpers ════════════════════════════════════════════════════ */
    .row     { display: flex; align-items: center; gap: 6px; }
    .row.wrap { flex-wrap: wrap; }
    .row.between { justify-content: space-between; }
    .stack   { display: grid; gap: 6px; }
    .g2      { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 6px; }
    .mg { display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 6px; margin-top: 8px; }

    /* ══ Buttons ═════════════════════════════════════════════════════════════ */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      min-height: clamp(26px,7vw,30px); padding: 4px clamp(8px,2.5vw,12px);
      border: 1px solid transparent; border-radius: var(--r1);
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      cursor: pointer; font-weight: 600; font-size: clamp(10.5px,2.8vw,12px);
      white-space: nowrap; transition: background var(--dur), opacity var(--dur);
      -webkit-tap-highlight-color: transparent;
    }
    .btn:hover:not(:disabled)  { background: var(--vscode-button-hoverBackground); }
    .btn:active:not(:disabled) { opacity: .8; }
    .btn.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .btn.sec:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.ghost { color: var(--vscode-foreground); background: transparent; border-color: var(--bd); }
    .btn.ghost:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    .btn.danger {
      color: var(--vscode-errorForeground); background: transparent;
      border-color: color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent);
    }
    .btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); }
    .btn.w { width: 100%; }
    .btn.xs { min-height: 22px; padding: 2px 7px; font-size: 10px; }
    .btn.sm { min-height: 25px; padding: 3px 9px; font-size: 10.5px; }
    .btn.speak { min-height: 36px; font-size: 13px; letter-spacing: .2px; }
    .btn:disabled { opacity: .36; cursor: not-allowed; }

    /* ══ Metric tiles ════════════════════════════════════════════════════════ */
    .metric {
      padding: clamp(7px,2vw,10px); border-radius: var(--r1);
      background: var(--vscode-textBlockQuote-background);
      border: 1px solid var(--bd);
    }
    .metric .lbl { font-size: 9.5px; color: var(--muted); }
    .metric strong { display: block; font-size: clamp(12px,3.5vw,15px); font-weight: 700; margin-top: 2px; }

    /* ══ Speed slider ════════════════════════════════════════════════════════ */
    .speed-row { display: flex; align-items: center; gap: 7px; }
    .speed-lbl { font-size: 10px; color: var(--muted); white-space: nowrap; }
    .speed-val { min-width: 33px; text-align: right; font-size: 10px; font-weight: 700; color: var(--accent); }

    /* ══ Voice cards ═════════════════════════════════════════════════════════ */
    .vc {
      padding: clamp(8px,2.5vw,11px);
      border: 1px solid var(--bd); border-radius: var(--r2);
      background: var(--surface2);
      transition: border-color var(--dur), box-shadow var(--dur);
    }
    .vc:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--bd)); }
    .vc.active {
      border-color: var(--accent);
      box-shadow: inset 3px 0 0 var(--accent), 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .vc.dl { border-color: #f59e0b; }
    .vc-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; }
    .vc-name { font-weight: 650; font-size: clamp(11px,3vw,12.5px); }
    .vc-id   { font-size: 9px; color: var(--muted); margin-top: 1px; word-break: break-all; }

    /* ══ Chips ═══════════════════════════════════════════════════════════════ */
    .chips { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px; }
    .chip {
      padding: 1px 5px; border-radius: 999px; white-space: nowrap;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      font-size: 9px; font-weight: 600;
    }
    .chip.ok   { background: color-mix(in srgb,#22c55e 18%,transparent); color: #22c55e; }
    .chip.inf  { background: color-mix(in srgb,#3b82f6 18%,transparent); color: #3b82f6; }
    .chip.warn { background: color-mix(in srgb,#f59e0b 18%,transparent); color: #f59e0b; }
    .chip.err  { background: color-mix(in srgb,#ef4444 18%,transparent); color: #ef4444; }

    /* ══ Progress ════════════════════════════════════════════════════════════ */
    .pbar { height: 3px; background: var(--bd); border-radius: 2px; margin-top: 6px; overflow: hidden; }
    .pfill {
      height: 100%; border-radius: 2px;
      background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 55%, white));
      background-size: 200% 100%;
      animation: shimmer 1.3s linear infinite;
    }
    @keyframes shimmer { from { background-position:-200% 0; } to { background-position:200% 0; } }

    /* ══ Lang filter ═════════════════════════════════════════════════════════ */
    .lf { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
    .lbtn {
      padding: 2px 9px; border-radius: 999px;
      border: 1px solid var(--bd); background: transparent;
      color: var(--vscode-foreground); font-size: 10px; cursor: pointer;
      transition: background var(--dur);
    }
    .lbtn:hover  { background: var(--vscode-toolbar-hoverBackground); }
    .lbtn.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: transparent; font-weight: 600; }

    /* ══ History ═════════════════════════════════════════════════════════════ */
    .hi {
      padding: clamp(7px,2vw,9px);
      border: 1px solid var(--bd); border-radius: var(--r2);
      background: var(--surface2);
    }
    .hi-text { margin: 5px 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; font-size: 11.5px; }
    .hi-meta { font-size: 9.5px; color: var(--muted); }
    .empty {
      padding: clamp(16px,6vw,28px) 12px; text-align: center;
      color: var(--muted); font-size: clamp(10px,2.5vw,12px); line-height: 1.7;
    }
    .empty-ico { font-size: clamp(24px,8vw,32px); margin-bottom: 8px; opacity: .45; }

    /* ══ Clone zone ══════════════════════════════════════════════════════════ */
    .zone {
      border: 2px dashed var(--bd); border-radius: var(--r2);
      padding: clamp(14px,5vw,22px); text-align: center; cursor: pointer;
      transition: border-color var(--dur), background var(--dur);
    }
    .zone:hover, .zone.over {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 5%, transparent);
    }
    .zone-ico { font-size: clamp(24px,7vw,32px); margin-bottom: 8px; }
    .zone p   { font-size: clamp(10px,2.5vw,11.5px); color: var(--muted); margin-top: 4px; }
    .pc {
      display: flex; align-items: center; gap: clamp(6px,2vw,10px);
      padding: clamp(7px,2vw,10px); border: 1px solid var(--bd);
      border-radius: var(--r2); background: var(--surface2);
    }
    .pav {
      width: clamp(28px,8vw,34px); height: clamp(28px,8vw,34px); flex: 0 0 clamp(28px,8vw,34px);
      border-radius: 50%; background: linear-gradient(135deg,#7c3aed,#2563eb);
      display: grid; place-items: center; font-size: 14px;
    }

    /* ══ Admin ═══════════════════════════════════════════════════════════════ */
    .kr {
      display: grid; grid-template-columns: 1fr auto auto; gap: 5px; align-items: center;
      padding: 7px 9px; border-radius: var(--r1);
      background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 80%, transparent);
      border: 1px solid var(--bd);
    }
    .kn  { font-size: 11px; font-weight: 600; }
    .kpv { font-family: monospace; font-size: 9.5px; color: var(--muted); word-break: break-all; }
    .mkbox {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: clamp(9px,2.5vw,11px); word-break: break-all; line-height: 1.6;
      padding: clamp(7px,2vw,10px); border-radius: var(--r1);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--bd));
      color: var(--vscode-input-foreground); user-select: text;
    }
    .mkbox.hidden { filter: blur(6px); cursor: pointer; user-select: none; }
    .kactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }

    /* ══ Notice ══════════════════════════════════════════════════════════════ */
    .notice {
      padding: clamp(8px,2.5vw,11px); border-radius: var(--r2);
      border: 1px solid; font-size: clamp(9.5px,2.5vw,11px); line-height: 1.55;
    }
    .notice.warn { border-color: color-mix(in srgb,#f59e0b 40%, transparent); background: color-mix(in srgb,#f59e0b 6%, transparent); color: var(--vscode-foreground); }
    .notice strong { display: block; margin-bottom: 3px; }

    /* ══ Toggle switch ═══════════════════════════════════════════════════════ */
    .sw { position: relative; width: 34px; height: 18px; flex: 0 0 34px; }
    .sw input { opacity: 0; width: 0; height: 0; }
    .sl {
      position: absolute; inset: 0; border-radius: 999px;
      background: var(--vscode-input-background); border: 1px solid var(--bd);
      cursor: pointer; transition: background var(--dur);
    }
    .sl::before {
      content: ""; position: absolute;
      width: 12px; height: 12px; left: 2px; top: 2px;
      border-radius: 50%; background: var(--muted);
      transition: transform var(--dur), background var(--dur);
    }
    input:checked + .sl { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    input:checked + .sl::before { transform: translateX(16px); background: var(--vscode-button-foreground); }

    /* ══ Busy overlay ════════════════════════════════════════════════════════ */
    .busy { display: none; position: fixed; inset: 0; z-index: 20; place-items: center; background: color-mix(in srgb, var(--vscode-sideBar-background) 70%, transparent); backdrop-filter: blur(6px); }
    .busy.show { display: grid; }
    .busy-card { padding: clamp(12px,4vw,16px) clamp(14px,5vw,20px); border-radius: var(--r2); border: 1px solid var(--bd); background: var(--vscode-editor-background); box-shadow: 0 16px 44px rgba(0,0,0,.35); display: flex; align-items: center; gap: 8px; }
    .spin { width: 14px; height: 14px; flex: 0 0 14px; border: 2px solid var(--bd); border-top-color: var(--accent); border-radius: 50%; animation: spin .65s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    hr { border: none; border-top: 1px solid var(--bd); margin: 8px 0; }

    /* ══ Responsive ══════════════════════════════════════════════════════════ */
    @media (max-width: 255px) {
      .brand-text h1 { font-size: 11px; }
      .tab { font-size: 7.5px; }
      .tab-icon { font-size: 10px; }
    }
  </style>
</head>
<body>
<div class="shell">
  <header class="hero">
    <div class="brand">
      <div class="logo-wrap"><img class="logo" src="${logoUri}" alt="ZT"></div>
      <div class="brand-text"><h1>Zero-Token TTS</h1>
        <div class="sub">Local Voice Studio · Docker Edition</div>
      </div>
    </div>
    <div class="hero-bottom">
      <div class="status-pill"><span id="statusDot" class="dot"></span><span id="statusText">wird geprüft…</span></div>
      <div class="hero-btns">
        <button class="btn ghost xs" id="refresh" title="Aktualisieren">↻</button>
        <button class="btn ghost xs" id="openSettings" title="Einstellungen">⚙</button>
      </div>
    </div>
  </header>

  <nav class="tabs">
    <button class="tab active" data-tab="speak"><span class="tab-icon">🎙</span>Sprechen</button>
    <button class="tab" data-tab="voices"><span class="tab-icon">🎭</span>Stimmen</button>
    <button class="tab" data-tab="clone"><span class="tab-icon">🧬</span>Klonen</button>
    <button class="tab" data-tab="history"><span class="tab-icon">📜</span>Verlauf</button>
    <button class="tab" data-tab="admin"><span class="tab-icon">🔑</span>Admin</button>
  </nav>

  <main>
    <!-- ── SPEAK ── -->
    <section id="panel-speak" class="panel active">
      <div class="card">
        <h2 class="card-title">Text vorlesen</h2>
        <textarea id="speechText" maxlength="12000" placeholder="Text eingeben… (Strg+Enter zum Sprechen)"></textarea>
        <div id="charCount" class="counter">0 / 12.000</div>
        <div style="margin-top:8px">
          <div class="small muted" style="margin-bottom:3px">Geschwindigkeit</div>
          <div class="speed-row">
            <span class="muted small">0.5×</span>
            <input type="range" id="speedSlider" min="50" max="200" value="100" step="5">
            <span class="muted small">2×</span>
            <span class="speed-val" id="speedVal">1.0×</span>
          </div>
        </div>
        <div class="stack" style="margin-top:10px">
          <button id="speakButton" class="btn w">▶ Jetzt sprechen</button>
          <div class="g2">
            <button id="clipboardButton" class="btn sec">📋 Zwischenablage</button>
            <button id="selectionButton" class="btn sec">✂ Auswahl</button>
          </div>
        </div>
      </div>
      <div class="mg">
        <div class="metric"><div class="lbl">Aktive Stimme</div><strong id="activeVoice">–</strong></div>
        <div class="metric"><div class="lbl">Ausgaben</div><strong id="historyCount">0</strong></div>
        <div class="metric"><div class="lbl">TTS Port</div><strong id="apiPort">18765</strong></div>
        <div class="metric"><div class="lbl">Proxy Port</div><strong id="proxyPort">18766</strong></div>
      </div>
      <div class="card" style="margin-top:8px">
        <div class="row between">
          <span class="small" style="font-weight:600">Autoplay</span><div class="xsmall muted">Agent-Modus</div>
          <label class="sw"><input id="autoPlay" type="checkbox"><span class="sl"></span></label>
        </div>
      </div>
    </section>

    <!-- ── VOICES ── -->
    <section id="panel-voices" class="panel">
      <div class="card">
        <h2 class="card-title">Stimmenbibliothek</h2>
        <div class="card-sub" id="catalogSubtitle">Lade Katalog…</div>
        <div class="lf" id="langFilter"></div>
      </div>
      <div id="catalogList" class="stack"></div>
    </section>

    <!-- ── CLONE ── -->
    <section id="panel-clone" class="panel">
      <div class="card">
        <h2 class="card-title">🧬 Voice Cloning</h2>
        <div class="card-sub">Lade eine Sprachprobe hoch (10–60 Sek WAV/MP3)</div>
        <div class="zone" id="cloneZone">
          <div class="zone-ico">🎤</div>
          <p><strong>WAV oder MP3 hier ablegen</strong></p>
          <p style="margin-top:4px">oder</p>
          <button class="btn sec" style="margin-top:8px" id="cloneUploadBtn">Datei auswählen</button>
          <input type="file" id="cloneFileInput" accept=".wav,.mp3,audio/*" style="display:none">
        </div>
        <div id="cloneFileName" class="small muted" style="margin-top:6px;text-align:center"></div>
        <div id="cloneNameRow" style="margin-top:10px;display:none" class="stack">
          <input type="text" id="cloneVoiceName" placeholder="Name für diese Stimme (z.B. Max)" maxlength="40">
          <button class="btn w" id="cloneSubmitBtn">🧬 Stimmprofil erstellen</button>
        </div>
      </div>
      <div class="card">
        <div class="row between" style="margin-bottom:8px">
          <h2 class="card-title" style="margin:0">Meine Stimmen</h2>
        </div>
        <div id="profileList" class="stack">
          <div class="empty">Noch keine Stimmen geklont.<br>Lade eine Aufnahme hoch.</div>
        </div>
      </div>
      <div class="card" style="border-color: color-mix(in srgb, #eab308 40%, transparent)">
        <div class="small" style="color: #eab308; font-weight:600; margin-bottom:4px">ℹ️ Hinweis</div>
        <div class="small muted">Voice Cloning verwendet die hochgeladene Stimme als Referenz und erzeugt Sprache mit dem Basisprofil + angepassten Parametern. Für tiefes neuronales Klonen kann Coqui XTTS als separater Service aktiviert werden.</div>
      </div>
    </section>

    <!-- ── HISTORY ── -->
    <section id="panel-history" class="panel">
      <div class="card row between">
        <div>
          <h2 class="card-title" style="margin:0">Verlauf</h2>
          <div id="historyCaption" class="small muted">Keine Einträge</div>
        </div>
        <button id="clearHistory" class="btn danger xs">🗑 Löschen</button>
      </div>
      <div id="historyList" class="stack"></div>
    </section>

    <!-- ── ADMIN ── -->
    <section id="panel-admin" class="panel">
      <!-- Master Key -->
      <div class="card">
        <h2 class="card-title">🔑 Master-Key</h2>
        <div class="card-sub">Einmal-Passwort für den Admin-Zugriff</div>
        <div id="masterKeyBox" class="mkbox hidden" title="Klicken zum Anzeigen">••••••••••••••••••••••••••••••••</div>
        <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:5px">
          <button class="btn sec xs" id="toggleKeyVisible">👁 Anzeigen</button>
          <button class="btn ghost xs" id="copyMasterKey">📋 Kopieren</button>
          <button class="btn ghost xs" id="claimMasterKeyBtn">🔓 Key claimen</button>
        </div>
        <div id="masterKeyHint" class="small muted" style="margin-top:6px"></div>
      </div>

      <!-- API Keys -->
      <div class="card">
        <div class="row between" style="margin-bottom:8px">
          <div>
            <h2 class="card-title" style="margin:0">API-Keys</h2>
            <div class="card-sub" style="margin:0">Für externen Zugriff auf TTS</div>
          </div>
          <button class="btn xs" id="createApiKeyBtn">+ Neu</button>
        </div>
        <div id="apiKeyList" class="stack">
          <div class="empty small">Keine API-Keys erstellt.</div>
        </div>
      </div>

      <!-- Server Control -->
      <div class="card">
        <h2 class="card-title">Serversteuerung</h2>
        <div class="row wrap">
          <button id="startServer" class="btn xs">▶ Starten</button>
          <button id="restartServer" class="btn sec xs">↺ Neu starten</button>
          <button id="stopServer" class="btn danger xs">■ Stoppen</button>
        </div>
        <button id="bootstrap" class="btn ghost w" style="margin-top:8px">🔧 Einrichtung ausführen</button>
        <button id="openOutput" class="btn ghost w" style="margin-top:5px">🔍 Diagnose-Log öffnen</button>
      </div>
    </section>
  </main>
</div>
<div id="busy" class="busy">
  <div class="busy-card"><span class="spin"></span><span id="busyLabel">Bitte warten…</span></div>
</div>

<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || { tab: 'speak', draft: '', speed: 100, langFilter: 'all' };
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const cmd = (command, payload = {}) => vscode.postMessage({ command, ...payload });
  const fmtDate = v => { const d = new Date(String(v||'').replace(' ','T')+'Z'); return isNaN(d) ? '' : new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short'}).format(d); };

  let snapshot = null;
  let masterKeyVisible = false;
  let cloneFile = null;
  let downloadStates = {};

  // ── Tab Navigation ──────────────────────────────────────────────────────────
  function selectTab(tab) {
    const allowed = ['speak','voices','clone','history','admin'];
    if (!allowed.includes(tab)) tab = 'speak';
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
    state.tab = tab; vscode.setState(state);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function renderStatus(data) {
    const state2 = data.healthy ? 'running' : (data.status?.state || 'stopped');
    $('statusDot').className = 'dot ' + state2;
    $('statusText').textContent = state2 === 'running' ? 'Docker bereit' : state2 === 'starting' ? 'startet…' : state2 === 'error' ? 'Fehler' : 'gestoppt';
  }

  function renderCatalog(models) {
    const langFilter = state.langFilter || 'all';
    $('catalogSubtitle').textContent = models.length + ' Modelle verfügbar';

    // Build lang buttons
    const langs = ['all', ...new Set(models.map(m => m.lang))];
    $('langFilter').innerHTML = langs.map(l => \`<button class="lbtn \${l === langFilter ? 'active' : ''}" data-lang="\${esc(l)}">\${l === 'all' ? '🌍 Alle' : l.toUpperCase()}</button>\`).join('');

    const filtered = langFilter === 'all' ? models : models.filter(m => m.lang === langFilter);

    $('catalogList').innerHTML = filtered.map(m => {
      const dl = downloadStates[m.id];
      const isDownloading = dl?.status === 'downloading';
      const isDone = m.downloaded || dl?.status === 'done';
      const isError = dl?.status === 'error';
      const qualityColor = m.quality === 'high' ? 'ok' : m.quality === 'medium' ? 'inf' : 'warn';

      let actions = '';
      if (isDone) {
        actions = m.active
          ? \`<span class="chip ok">✓ AKTIV</span>\`
          : \`<button class="btn xs" data-activate="\${esc(m.id)}">Verwenden</button>\`;
      } else if (isDownloading) {
        actions = \`<span class="chip warn"><span class="spin" style="width:8px;height:8px;margin-right:3px"></span>Download…</span>\`;
      } else if (isError) {
        actions = \`<button class="btn danger xs" data-catalog-dl="\${esc(m.id)}">↺ Erneut</button>\`;
      } else {
        actions = \`<button class="btn xs" data-catalog-dl="\${esc(m.id)}">⬇ Laden (\${esc(m.size)})</button>\`;
      }

      return \`<article class="vc \${m.active ? 'active' : ''} \${isDownloading ? 'dl' : ''}">
        <div class="row between">
          <div><div class="vc-name">\${esc(m.label)}</div><div class="xsmall muted">\${esc(m.id)}</div></div>
          <div class="hero-btns">\${actions}</div>
        </div>
        <div class="chips">
          <span class="chip">\${esc(m.lang.toUpperCase())}</span>
          <span class="chip \${qualityColor}">\${esc(m.quality)}</span>
          <span class="chip">\${esc(m.size)}</span>
        </div>
        \${isDownloading ? '<div class="pbar"><div class="pfill" style="width:100%"></div></div>' : ''}
        \${isError ? '<div class="xsmall" style="color:#ef4444;margin-top:4px">Fehler: ' + esc(dl.error||'unbekannt') + '</div>' : ''}
      </article>\`;
    }).join('') || '<div class="empty">Keine Modelle für diese Sprache.</div>';
  }

  function renderHistory(items, count) {
    $('historyCaption').textContent = count === 1 ? '1 Ausgabe' : count + ' Ausgaben';
    $('historyList').innerHTML = items.map(item =>
      \`<article class="hi">
        <div class="row between"><span class="chip">\${esc(item.source||'manual')}</span><span class="hi-meta">\${esc(fmtDate(item.played_at))}</span></div>
        <div class="hi-text">\${esc(item.text_preview||item.text||'')}</div>
        <div class="row between"><span class="hi-meta">\${esc(item.voice)} · \${Number(item.played_count||1)}×</span><button class="btn sec xs" data-replay="\${Number(item.id)}">▶ Nochmal</button></div>
      </article>\`
    ).join('') || '<div class="empty">Noch keine Ausgaben.<br>Sprich deinen ersten Text!</div>';
  }

  function renderProfiles(profiles) {
    $('profileList').innerHTML = (profiles||[]).map(p =>
      \`<div class="pc">
        <div class="pav">🎤</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:650;font-size:12px">\${esc(p.name)}</div>
          <div class="xsmall muted">\${esc(fmtDate(p.createdAt))} · \${esc(p.baseModel||'')}</div>
        </div>
        <button class="btn danger xs" data-del-profile="\${esc(p.id)}">🗑</button>
      </div>\`
    ).join('') || '<div class="empty">Keine Stimmen geklont.</div>';
  }

  function renderAdmin(data) {
    // Master key
    const mk = data.masterKey || '';
    $('masterKeyBox').textContent = masterKeyVisible ? (mk || '(nicht gesetzt)') : (mk ? '••••••••••••••••••••••••••••••••' : '⚠ Noch nicht geclaimed');
    $('masterKeyBox').classList.toggle('hidden', !masterKeyVisible);
    $('masterKeyHint').textContent = data.masterKeyClaimed
      ? '✓ Key ist aktiv und gespeichert'
      : mk ? '⚠ Key noch nicht geclaimed (Docker muss laufen)' : '⚠ Docker starten, dann "Key claimen"';

    // API Keys
    const keys = data.apiKeys || [];
    $('apiKeyList').innerHTML = keys.length ? keys.map(k =>
      \`<div class="kr">
        <div><div class="kn">\${esc(k.name||'unnamed')}</div><div class="kpv">\${esc(k.preview||k.key?.substring(0,14)+'...')}</div></div>
        <button class="btn ghost xs" data-copy-key="\${esc(k.key)}">📋</button>
        <button class="btn danger xs" data-revoke-key="\${esc(k.key)}" data-revoke-name="\${esc(k.name)}">×</button>
      </div>\`
    ).join('') : '<div class="small muted">Keine API-Keys. Erstelle einen mit "+ Neu".</div>';
  }

  function render(data) {
    snapshot = data;
    renderStatus(data);
    renderCatalog(data.catalogModels || data.models || []);
    renderHistory(data.history || [], Number(data.historyCount || 0));
    renderProfiles(data.voiceProfiles || []);
    renderAdmin(data);
    $('activeVoice').textContent = data.voice || '–';
    $('historyCount').textContent = String(data.historyCount || 0);
    $('autoPlay').checked = Boolean(data.autoPlay);
    $('apiPort').textContent = String(data.apiPort || 18765);
    $('proxyPort').textContent = String(data.proxyPort || 18766);
  }

  // ── Event Listeners ─────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  $('speechText').value = state.draft || '';
  $('speechText').addEventListener('input', e => {
    state.draft = e.target.value;
    $('charCount').textContent = e.target.value.length.toLocaleString('de-DE') + ' / 12.000';
    vscode.setState(state);
  });
  $('speechText').dispatchEvent(new Event('input'));
  $('speechText').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') cmd('speakText', { text: $('speechText').value, speed: getSpeed() });
  });

  const speedSlider = $('speedSlider');
  speedSlider.value = state.speed || 100;
  function getSpeed() { return (Number(speedSlider.value) / 100).toFixed(1); }
  $('speedVal').textContent = getSpeed() + '×';
  speedSlider.addEventListener('input', () => {
    state.speed = Number(speedSlider.value);
    $('speedVal').textContent = getSpeed() + '×';
    vscode.setState(state);
  });

  $('speakButton').addEventListener('click', () => cmd('speakText', { text: $('speechText').value, speed: getSpeed() }));
  $('clipboardButton').addEventListener('click', () => cmd('speakClipboard'));
  $('selectionButton').addEventListener('click', () => cmd('speakSelection'));
  $('clearHistory').addEventListener('click', () => cmd('clearHistory'));
  $('autoPlay').addEventListener('change', e => cmd('toggleAutoPlay', { value: e.target.checked }));
  $('startServer').addEventListener('click', () => cmd('startServer'));
  $('stopServer').addEventListener('click', () => cmd('stopServer'));
  $('restartServer').addEventListener('click', () => cmd('restartServer'));
  $('bootstrap').addEventListener('click', () => cmd('bootstrap'));
  $('openSettings').addEventListener('click', () => cmd('openSettings'));
  $('openOutput').addEventListener('click', () => cmd('openOutput'));
  $('refresh').addEventListener('click', () => cmd('refresh'));

  // Admin
  $('toggleKeyVisible').addEventListener('click', () => {
    masterKeyVisible = !masterKeyVisible;
    $('toggleKeyVisible').textContent = masterKeyVisible ? '🙈 Verbergen' : '👁 Anzeigen';
    if (snapshot) renderAdmin(snapshot);
  });
  $('copyMasterKey').addEventListener('click', () => cmd('copyMasterKey'));
  $('claimMasterKeyBtn').addEventListener('click', () => cmd('claimMasterKey'));
  $('createApiKeyBtn').addEventListener('click', () => cmd('createApiKey'));

  // Lang filter
  $('langFilter').addEventListener('click', e => {
    const btn = e.target.closest('[data-lang]');
    if (!btn) return;
    state.langFilter = btn.dataset.lang;
    vscode.setState(state);
    if (snapshot) renderCatalog(snapshot.catalogModels || snapshot.models || []);
  });

  // Voice clone
  $('cloneUploadBtn').addEventListener('click', () => $('cloneFileInput').click());
  $('cloneFileInput').addEventListener('change', e => {
    cloneFile = e.target.files?.[0];
    if (cloneFile) {
      $('cloneFileName').textContent = cloneFile.name + ' (' + (cloneFile.size / 1024).toFixed(1) + ' KB)';
      $('cloneNameRow').style.display = 'grid';
      $('cloneVoiceName').value = cloneFile.name.replace(/\\.(wav|mp3)$/i,'');
    }
  });
  const cloneZone = $('cloneZone');
  cloneZone.addEventListener('dragover', e => { e.preventDefault(); cloneZone.classList.add('over'); });
  cloneZone.addEventListener('dragleave', () => cloneZone.classList.remove('over'));
  cloneZone.addEventListener('drop', e => {
    e.preventDefault(); cloneZone.classList.remove('over');
    cloneFile = e.dataTransfer.files?.[0];
    if (cloneFile) {
      $('cloneFileName').textContent = cloneFile.name;
      $('cloneNameRow').style.display = 'grid';
      $('cloneVoiceName').value = cloneFile.name.replace(/\\.(wav|mp3)$/i,'');
    }
  });
  $('cloneSubmitBtn').addEventListener('click', () => {
    if (!cloneFile) return;
    const reader = new FileReader();
    reader.onload = e2 => {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(e2.target.result)));
      cmd('uploadVoiceSample', { name: $('cloneVoiceName').value || cloneFile.name, audioBase64: b64 });
    };
    reader.readAsArrayBuffer(cloneFile);
  });

  // Delegated clicks
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-activate],[data-catalog-dl],[data-replay],[data-copy-key],[data-revoke-key],[data-del-profile],[data-lang]');
    if (!t) return;
    if (t.dataset.activate) cmd('activateModel', { modelId: t.dataset.activate });
    if (t.dataset.catalogDl) cmd('downloadModelFromCatalog', { modelId: t.dataset.catalogDl });
    if (t.dataset.replay) cmd('replayHistory', { id: Number(t.dataset.replay) });
    if (t.dataset.copyKey) { navigator.clipboard?.writeText(t.dataset.copyKey); }
    if (t.dataset.revokeKey) cmd('revokeApiKey', { key: t.dataset.revokeKey, name: t.dataset.revokeName });
    if (t.dataset.delProfile) cmd('deleteVoiceProfile', { profileId: t.dataset.delProfile });
  });

  // Messages from extension
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'snapshot') render(msg.payload);
    if (msg.type === 'selectTab') selectTab(msg.tab);
    if (msg.type === 'busy') {
      $('busy').classList.toggle('show', Boolean(msg.value));
      $('busyLabel').textContent = msg.label || 'Bitte warten…';
    }
    if (msg.type === 'masterKeyRevealed') {
      masterKeyVisible = true;
      if (snapshot) { snapshot.masterKey = msg.key; snapshot.masterKeyClaimed = true; renderAdmin(snapshot); }
    }
    if (msg.type === 'downloadStarted') {
      downloadStates[msg.modelId] = { status: 'downloading' };
      if (snapshot) renderCatalog(snapshot.catalogModels || snapshot.models || []);
    }
    if (msg.type === 'downloadProgress') {
      downloadStates[msg.modelId] = { status: msg.status, error: msg.error };
      if (snapshot) renderCatalog(snapshot.catalogModels || snapshot.models || []);
    }
    if (msg.type === 'speakAudio' && msg.audioBase64) {
      try {
        const b64 = String(msg.audioBase64).replace(/\\s/g, '');
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play().catch(err => console.error('TTS play()', err));
      } catch(err) { console.error('TTS speakAudio', err); }
    }
  });

  selectTab(state.tab || 'speak');
  cmd('ready');
})();
</script>
</body>
</html>`;
  }
}
function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const http = require("http") as typeof import("http");
    const urlObj = new URL(url);
    const req = http.request({ hostname: urlObj.hostname, port: Number(urlObj.port), path: urlObj.pathname + urlObj.search, method: "GET", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}
