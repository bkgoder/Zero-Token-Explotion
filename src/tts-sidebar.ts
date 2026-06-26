import * as vscode from "vscode";
import { clearTtsHistory, getTtsHistory, getTtsHistoryCount, persistDatabase, type TtsHistoryRow } from "./database";
import { getServerManager, type PiperModel, type ServerStatus } from "./tts-bootstrap";
import { type TtsTreeProvider } from "./tts-tree";

type DashboardTab = "speak" | "voices" | "history" | "system";
type SpeakHandler = (text: string, source?: string) => Promise<void>;

interface ModelSnapshot extends PiperModel {
  downloaded: boolean;
  active: boolean;
}

interface DashboardSnapshot {
  status: ServerStatus;
  healthy: boolean;
  models: ModelSnapshot[];
  history: TtsHistoryRow[];
  historyCount: number;
  autoPlay: boolean;
  activeModel: string;
  voice: string;
  language: string;
  proxyPort: number;
  apiPort: number;
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

    return {
      status,
      healthy,
      models,
      history: getTtsHistory(60),
      historyCount: getTtsHistoryCount(),
      autoPlay: this.treeProvider.autoPlay,
      activeModel,
      voice: config.get<string>("voice", "eva"),
      language: config.get<string>("language", "de"),
      proxyPort,
      apiPort,
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
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 210px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: 12px/1.45 var(--vscode-font-family);
    }
    button, textarea, input { font: inherit; }
    button:focus-visible, textarea:focus-visible, input:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .shell { min-height: 100vh; }
    .hero {
      position: relative;
      overflow: hidden;
      padding: 16px 14px 12px;
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
      background:
        radial-gradient(circle at 88% -10%, color-mix(in srgb, var(--vscode-textLink-foreground) 30%, transparent), transparent 48%),
        linear-gradient(145deg, color-mix(in srgb, var(--vscode-sideBar-background) 90%, #7c5cff 10%), var(--vscode-sideBar-background));
    }
    .brand { display: flex; gap: 10px; align-items: center; }
    .logo-wrap {
      width: 44px; height: 44px; flex: 0 0 44px;
      display: grid; place-items: center;
      border-radius: 13px;
      background: color-mix(in srgb, var(--vscode-editor-background) 80%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 45%, transparent);
      box-shadow: 0 8px 28px rgba(0,0,0,.2);
    }
    .logo { width: 34px; height: 34px; }
    h1 { margin: 0; font-size: 15px; line-height: 1.2; letter-spacing: .1px; }
    .subtitle { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .status-pill {
      display: inline-flex; align-items: center; gap: 6px;
      margin-top: 10px; padding: 4px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-badge-background) 55%, transparent);
      color: var(--vscode-badge-foreground);
      font-size: 10px; font-weight: 600;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .dot.running { background: #38d996; box-shadow: 0 0 0 3px rgba(56,217,150,.15); }
    .dot.starting { background: #ffca5c; animation: pulse 1s infinite; }
    .dot.error { background: #ff6b6b; }
    @keyframes pulse { 50% { opacity: .35; } }

    .tabs {
      position: sticky; top: 0; z-index: 5;
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 3px; padding: 7px 6px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 94%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
    }
    .tab {
      min-width: 0; padding: 7px 3px;
      border: 0; border-radius: 6px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      cursor: pointer; font-size: 10px;
    }
    .tab:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .tab-icon { display: block; font-size: 14px; line-height: 1; margin-bottom: 3px; }

    main { padding: 10px; }
    .panel { display: none; }
    .panel.active { display: block; animation: enter .14s ease-out; }
    @keyframes enter { from { opacity: 0; transform: translateY(3px); } }
    .card {
      margin-bottom: 9px; padding: 11px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 9px;
      background: color-mix(in srgb, var(--vscode-editor-background) 84%, transparent);
    }
    .card-title { margin: 0 0 8px; font-size: 12px; font-weight: 650; }
    .muted { color: var(--vscode-descriptionForeground); }
    .small { font-size: 10px; }
    textarea {
      width: 100%; min-height: 116px; resize: vertical;
      padding: 9px; border-radius: 7px;
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .counter { margin: 5px 1px 0; text-align: right; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .row { display: flex; align-items: center; gap: 7px; }
    .row.wrap { flex-wrap: wrap; }
    .row.between { justify-content: space-between; }
    .stack { display: grid; gap: 7px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      min-height: 29px; padding: 5px 10px;
      border: 1px solid transparent; border-radius: 6px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer; font-weight: 600;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.ghost { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-widget-border); }
    .btn.danger { color: var(--vscode-errorForeground); background: transparent; border-color: color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent); }
    .btn.wide { width: 100%; }
    .btn:disabled { opacity: .45; cursor: default; }

    .quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    .metric { padding: 8px; border-radius: 7px; background: var(--vscode-textBlockQuote-background); }
    .metric strong { display: block; font-size: 13px; }

    .model, .history-item {
      padding: 9px; border: 1px solid var(--vscode-widget-border);
      border-radius: 8px; background: color-mix(in srgb, var(--vscode-sideBar-background) 82%, var(--vscode-editor-background));
    }
    .model.active { border-color: var(--vscode-focusBorder); box-shadow: inset 3px 0 0 var(--vscode-focusBorder); }
    .model-name { font-weight: 650; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .chip { padding: 2px 6px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 9px; }
    .history-text { margin: 5px 0 7px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .history-meta { color: var(--vscode-descriptionForeground); font-size: 9px; }
    .empty { padding: 22px 10px; text-align: center; color: var(--vscode-descriptionForeground); }
    .switch { position: relative; width: 34px; height: 18px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; border-radius: 999px; background: var(--vscode-input-background); border: 1px solid var(--vscode-widget-border); cursor: pointer; }
    .slider:before { content: ""; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px; border-radius: 50%; background: var(--vscode-descriptionForeground); transition: .15s; }
    input:checked + .slider { background: var(--vscode-button-background); }
    input:checked + .slider:before { transform: translateX(16px); background: var(--vscode-button-foreground); }
    .busy {
      display: none; position: fixed; inset: 0; z-index: 20;
      place-items: center; background: color-mix(in srgb, var(--vscode-sideBar-background) 80%, transparent);
      backdrop-filter: blur(4px);
    }
    .busy.show { display: grid; }
    .busy-card { padding: 14px 16px; border-radius: 9px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); box-shadow: 0 12px 35px rgba(0,0,0,.35); }
    .spinner { display: inline-block; width: 12px; height: 12px; margin-right: 7px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: var(--vscode-focusBorder); border-radius: 50%; animation: spin .75s linear infinite; vertical-align: -2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
<div class="shell">
  <header class="hero">
    <div class="brand">
      <div class="logo-wrap"><img class="logo" src="${logoUri}" alt="Zero-Token TTS Logo"></div>
      <div>
        <h1>Zero-Token TTS</h1>
        <div class="subtitle">Local Voice Studio</div>
      </div>
    </div>
    <div class="status-pill"><span id="statusDot" class="dot"></span><span id="statusText">Status wird geprüft…</span></div>
  </header>

  <nav class="tabs" aria-label="Dashboard-Bereiche">
    <button class="tab active" data-tab="speak"><span class="tab-icon">◉</span>Sprechen</button>
    <button class="tab" data-tab="voices"><span class="tab-icon">≋</span>Stimmen</button>
    <button class="tab" data-tab="history"><span class="tab-icon">↻</span>Verlauf</button>
    <button class="tab" data-tab="system"><span class="tab-icon">⚙</span>System</button>
  </nav>

  <main>
    <section id="panel-speak" class="panel active">
      <div class="card">
        <h2 class="card-title">Text vorlesen</h2>
        <textarea id="speechText" maxlength="12000" placeholder="Text eingeben, den Zero-Token vorlesen soll …"></textarea>
        <div id="charCount" class="counter">0 / 12.000</div>
        <div class="stack" style="margin-top:8px">
          <button id="speakButton" class="btn wide">▶ Jetzt sprechen</button>
          <div class="quick-grid">
            <button id="clipboardButton" class="btn secondary">Zwischenablage</button>
            <button id="selectionButton" class="btn secondary">Editor-Auswahl</button>
          </div>
        </div>
      </div>
      <div class="metric-grid">
        <div class="metric"><span class="small muted">Aktive Stimme</span><strong id="activeVoice">–</strong></div>
        <div class="metric"><span class="small muted">Ausgaben</span><strong id="historyCount">0</strong></div>
      </div>
    </section>

    <section id="panel-voices" class="panel">
      <div class="card">
        <div class="row between">
          <div><h2 class="card-title" style="margin:0">Stimmenbibliothek</h2><div class="small muted">Lokal installierte Piper-Modelle</div></div>
          <button id="openModelDashboard" class="btn ghost" title="Großes Model Dashboard öffnen">↗</button>
        </div>
      </div>
      <div id="modelList" class="stack"></div>
    </section>

    <section id="panel-history" class="panel">
      <div class="card row between">
        <div><h2 class="card-title" style="margin:0">Verlauf</h2><div id="historyCaption" class="small muted">Keine Einträge</div></div>
        <button id="clearHistory" class="btn danger">Löschen</button>
      </div>
      <div id="historyList" class="stack"></div>
    </section>

    <section id="panel-system" class="panel">
      <div class="card stack">
        <div class="row between"><span>Autoplay</span><label class="switch"><input id="autoPlay" type="checkbox"><span class="slider"></span></label></div>
        <div class="row between"><span>TTS API</span><code id="apiPort">:18765</code></div>
        <div class="row between"><span>Extension Proxy</span><code id="proxyPort">:18766</code></div>
      </div>
      <div class="card">
        <h2 class="card-title">Serversteuerung</h2>
        <div class="row wrap">
          <button id="startServer" class="btn">Starten</button>
          <button id="restartServer" class="btn secondary">Neu starten</button>
          <button id="stopServer" class="btn danger">Stoppen</button>
        </div>
        <button id="bootstrap" class="btn secondary wide" style="margin-top:7px">Modelle und Server einrichten</button>
      </div>
      <div class="card stack">
        <button id="openSettings" class="btn ghost wide">Extension-Einstellungen</button>
        <button id="openOutput" class="btn ghost wide">Diagnose-Ausgabe</button>
        <button id="refresh" class="btn ghost wide">Status aktualisieren</button>
      </div>
    </section>
  </main>
</div>
<div id="busy" class="busy"><div class="busy-card"><span class="spinner"></span><span id="busyLabel">Bitte warten…</span></div></div>

<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || { tab: 'speak', draft: '' };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  let snapshot = null;

  function selectTab(tab) {
    const allowed = ['speak', 'voices', 'history', 'system'];
    if (!allowed.includes(tab)) tab = 'speak';
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'panel-' + tab));
    state.tab = tab;
    vscode.setState(state);
  }

  function command(command, payload = {}) { vscode.postMessage({ command, ...payload }); }
  function formatDate(value) {
    const date = new Date(String(value || '').replace(' ', 'T') + 'Z');
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(date);
  }

  function renderStatus(data) {
    const status = data.status || { state: 'stopped' };
    const stateName = data.healthy ? 'running' : status.state;
    $('statusDot').className = 'dot ' + stateName;
    $('statusText').textContent = stateName === 'running' ? 'Server bereit' : stateName === 'starting' ? 'Server startet…' : stateName === 'error' ? 'Serverfehler' : 'Server gestoppt';
  }

  function renderModels(models) {
    $('modelList').innerHTML = models.map((model) => {
      const action = model.downloaded
        ? '<button class="btn ' + (model.active ? 'secondary' : '') + '" data-model-select="' + escapeHtml(model.id) + '" ' + (model.active ? 'disabled' : '') + '>' + (model.active ? 'Ausgewählt' : 'Verwenden') + '</button>'
        : '<button class="btn" data-model-download="' + escapeHtml(model.id) + '">Installieren</button>';
      return '<article class="model ' + (model.active ? 'active' : '') + '">' +
        '<div class="row between">' +
          '<div><div class="model-name">' + escapeHtml(model.label) + '</div><div class="small muted">' + escapeHtml(model.id) + '</div></div>' +
          (model.active ? '<span class="chip">AKTIV</span>' : '') +
        '</div>' +
        '<div class="chips"><span class="chip">' + escapeHtml(model.lang.toUpperCase()) + '</span><span class="chip">' + escapeHtml(model.quality) + '</span><span class="chip">' + escapeHtml(model.size) + '</span></div>' +
        '<div class="row wrap" style="margin-top:8px">' + action + '</div>' +
      '</article>';
    }).join('') || '<div class="empty">Keine Stimmen verfügbar</div>';
  }

  function renderHistory(items, count) {
    $('historyCaption').textContent = count === 1 ? '1 Ausgabe' : count + ' Ausgaben';
    $('historyList').innerHTML = items.map((item) =>
      '<article class="history-item">' +
        '<div class="row between"><span class="chip">' + escapeHtml(item.source || 'manual') + '</span><span class="history-meta">' + escapeHtml(formatDate(item.played_at)) + '</span></div>' +
        '<div class="history-text">' + escapeHtml(item.text_preview || item.text || '') + '</div>' +
        '<div class="row between"><span class="history-meta">' + escapeHtml(item.voice) + ' · ' + Number(item.played_count || 1) + '×</span><button class="btn secondary" data-history-replay="' + Number(item.id) + '">▶ Nochmal</button></div>' +
      '</article>'
    ).join('') || '<div class="empty">Noch nichts vorgelesen.<br>Der Verlauf erscheint nach der ersten Ausgabe.</div>';
  }

  function render(data) {
    snapshot = data;
    renderStatus(data);
    renderModels(data.models || []);
    renderHistory(data.history || [], Number(data.historyCount || 0));
    $('activeVoice').textContent = data.voice || '–';
    $('historyCount').textContent = String(data.historyCount || 0);
    $('autoPlay').checked = Boolean(data.autoPlay);
    $('apiPort').textContent = ':' + data.apiPort;
    $('proxyPort').textContent = ':' + data.proxyPort;
  }

  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
  $('speechText').value = state.draft || '';
  $('speechText').addEventListener('input', (event) => {
    state.draft = event.target.value;
    $('charCount').textContent = event.target.value.length.toLocaleString('de-DE') + ' / 12.000';
    vscode.setState(state);
  });
  $('speechText').dispatchEvent(new Event('input'));
  $('speakButton').addEventListener('click', () => command('speakText', { text: $('speechText').value }));
  $('clipboardButton').addEventListener('click', () => command('speakClipboard'));
  $('selectionButton').addEventListener('click', () => command('speakSelection'));
  $('clearHistory').addEventListener('click', () => command('clearHistory'));
  $('autoPlay').addEventListener('change', (event) => command('toggleAutoPlay', { value: event.target.checked }));
  $('startServer').addEventListener('click', () => command('startServer'));
  $('stopServer').addEventListener('click', () => command('stopServer'));
  $('restartServer').addEventListener('click', () => command('restartServer'));
  $('bootstrap').addEventListener('click', () => command('bootstrap'));
  $('openSettings').addEventListener('click', () => command('openSettings'));
  $('openOutput').addEventListener('click', () => command('openOutput'));
  $('refresh').addEventListener('click', () => command('refresh'));
  $('openModelDashboard').addEventListener('click', () => command('openModelDashboard'));
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-model-select],[data-model-download],[data-history-replay]');
    if (!target) return;
    if (target.dataset.modelSelect) command('selectModel', { modelId: target.dataset.modelSelect });
    if (target.dataset.modelDownload) command('downloadModel', { modelId: target.dataset.modelDownload });
    if (target.dataset.historyReplay) command('replayHistory', { id: Number(target.dataset.historyReplay) });
  });
  $('speechText').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') command('speakText', { text: $('speechText').value });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'snapshot') render(message.payload);
    if (message.type === 'selectTab') selectTab(message.tab);
    if (message.type === 'busy') {
      $('busy').classList.toggle('show', Boolean(message.value));
      $('busyLabel').textContent = message.label || 'Bitte warten…';
    }
    if (message.type === 'dashboardError') $('statusText').textContent = message.message || 'Dashboard-Fehler';
    if (message.type === 'speakAudio' && message.audioBase64) {
      try {
        const binary = atob(message.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.onerror = () => URL.revokeObjectURL(url);
        audio.play().catch(() => {});
      } catch (e) {}
    }
  });

  selectTab(state.tab || 'speak');
  command('ready');
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
