// ══════════════════════════════════════════════════════════════════════════════
// TTS Model Dashboard — Webview View (Sidebar) für Server + Model-Management
// ══════════════════════════════════════════════════════════════════════════════
import * as vscode from "vscode";
import { getServerManager, ServerStatus, PiperModel } from "./tts-bootstrap";
import { createApiKey, listApiKeys, revokeApiKey } from "./mcp-server";

// ─── Dashboard Webview Provider (Sidebar) ──────────────────────────────────────

export class TtsDashboardProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ttsModelDashboard";
  private static _instance: TtsDashboardProvider | undefined;

  private _view?: vscode.WebviewView;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _statusInterval: NodeJS.Timeout | undefined;

  static register(context: vscode.ExtensionContext, extensionUri: vscode.Uri): vscode.Disposable {
    const provider = new TtsDashboardProvider(extensionUri);
    TtsDashboardProvider._instance = provider;
    const disposable = vscode.window.registerWebviewViewProvider(
      TtsDashboardProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
    context.subscriptions.push(disposable);
    return disposable;
  }

  private constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  static get instance(): TtsDashboardProvider | undefined {
    return TtsDashboardProvider._instance;
  }

  static show(): void {
    vscode.commands.executeCommand("zeroTokenTts.focus");
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, "resources")],
    };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._refresh();
      }
    });

    this._startStatusPolling();
  }

  private dispose(): void {
    TtsDashboardProvider._instance = undefined;
    if (this._statusInterval) clearInterval(this._statusInterval);
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  refresh(): void {
    this._view?.webview.postMessage({ type: "refresh" });
    this._refresh();
  }

  // ─── Status Polling ────────────────────────────────────────────────────────

  private _startStatusPolling() {
    this._statusInterval = setInterval(() => this._refresh(), 3000);
  }

  private async _refresh() {
    try {
      const serverManager = getServerManager(
        vscode.window.createOutputChannel("_internal_")
      );
      const health = await serverManager.checkHealth();
      const status: ServerStatus = health
        ? { state: "running", port: 18765 }
        : serverManager.status;

      const models = serverManager.getAvailableModels();
      const installed = models.map((m) => ({
        ...m,
        downloaded: serverManager.isModelDownloaded(m),
      }));

      this.postMessage({ type: "updateStatus", status, models: installed });
    } catch {
      // ignore polling errors
    }
  }

  private postMessage(msg: unknown): void {
    this._view?.webview.postMessage(msg);
  }

  // ─── Message Handling ──────────────────────────────────────────────────────

  private async _handleMessage(msg: any) {
    const serverManager = getServerManager(
      vscode.window.createOutputChannel("_internal_")
    );

    switch (msg.command) {
      case "startServer":
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Starte TTS-Server..." },
          async () => {
            const ok = await serverManager.start();
            if (ok) {
              vscode.window.showInformationMessage("TTS-Server gestartet");
            } else {
              vscode.window.showErrorMessage("TTS-Server konnte nicht gestartet werden");
            }
            this._refresh();
          }
        );
        break;

      case "stopServer":
        serverManager.stop();
        vscode.window.showInformationMessage("TTS-Server gestoppt");
        this._refresh();
        break;

      case "restartServer":
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Starte TTS-Server neu..." },
          async () => {
            const ok = await serverManager.restart();
            if (ok) {
              vscode.window.showInformationMessage("TTS-Server neu gestartet");
            } else {
              vscode.window.showErrorMessage("Neustart fehlgeschlagen");
            }
            this._refresh();
          }
        );
        break;

      case "downloadModel": {
        const modelId: string = msg.modelId;
        const model = serverManager.getAvailableModels().find((m) => m.id === modelId);
        if (!model) {
          vscode.window.showErrorMessage(`Modell ${modelId} nicht gefunden`);
          return;
        }
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Lade ${model.label} herunter...`,
            cancellable: false,
          },
          async (progress) => {
            const ok = await serverManager.downloadModel(model, progress);
            if (ok) {
              vscode.window.showInformationMessage(`${model.label} heruntergeladen`);
            } else {
              vscode.window.showErrorMessage(`Download fehlgeschlagen: ${model.label}`);
            }
            this._refresh();
          }
        );
        break;
      }

      case "runBootstrap":
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Richte TTS-Server ein...",
            cancellable: false,
          },
          async (progress) => {
            const ok = await serverManager.downloadAll(progress);
            if (ok) {
              vscode.window.showInformationMessage("TTS-Einrichtung abgeschlossen!");
              await serverManager.start();
            } else {
              vscode.window.showErrorMessage("TTS-Einrichtung fehlgeschlagen");
            }
            this._refresh();
          }
        );
        break;

      case "checkHealth":
        this._refresh();
        break;

      case "createApiKey": {
        const { name, masterKey } = msg;
        if (!masterKey) {
          vscode.window.showErrorMessage("Master-Key erforderlich");
          return;
        }
        const newKey = createApiKey(name);
        vscode.window.showInformationMessage(`Neuer API-Key: ${newKey}`);
        break;
      }

      case "listApiKeys": {
        const { masterKey } = msg;
        if (!masterKey) {
          vscode.window.showErrorMessage("Master-Key erforderlich");
          return;
        }
        const keys = listApiKeys();
        vscode.window.showInformationMessage(`${keys.length} API-Keys gefunden`);
        break;
      }

      case "revokeApiKey": {
        const { key, masterKey } = msg;
        if (!masterKey || !key) {
          vscode.window.showErrorMessage("Master-Key und Key erforderlich");
          return;
        }
        const revoked = revokeApiKey(key);
        vscode.window.showInformationMessage(revoked ? "Key widerrufen" : "Key nicht gefunden");
        break;
      }

      case "getMcpStatus": {
        try {
          const resp = await fetch("http://localhost:18764/status")
            .then((r) => r.json())
            .catch(() => null);
          this.postMessage({ type: "mcpStatus", status: resp });
        } catch {
          this.postMessage({ type: "mcpStatus", status: null });
        }
        break;
      }
    }
  }

  // ─── HTML ──────────────────────────────────────────────────────────────────

  private _getHtml(): string {
    const csp = `default-src 'none'; style-src ${this._view!.webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${this._view!.webview.cspSource} https: data:; font-src ${this._view!.webview.cspSource}; connect-src http://localhost:*;`;
    return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #d4d4d4);
  padding: 12px;
  font-size: 13px;
  line-height: 1.5;
}
h2 { font-size: 15px; font-weight: 600; margin-bottom: 10px; }
h3 { font-size: 13px; font-weight: 600; margin: 12px 0 6px; }

.card {
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-widget-border, #555);
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.status-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.status-dot.running { background: #4ec9b0; }
.status-dot.stopped { background: #888; }
.status-dot.starting { background: #e2b714; animation: pulse 1s infinite; }
.status-dot.error { background: #f14c4c; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
}
.btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.secondary {
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ccc);
}
.btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.btn.danger { background: #c53b3b; }
.btn.danger:hover { background: #d94444; }
.btn-group { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }

.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--vscode-widget-border, #333);
}
.model-item:last-child { border-bottom: none; }
.model-info { flex: 1; }
.model-name { font-weight: 500; }
.model-detail { font-size: 11px; opacity: 0.7; margin-top: 2px; }
.model-status { font-size: 11px; margin-top: 2px; }
.model-status.installed { color: #4ec9b0; }
.model-status.missing { color: #e2b714; }

.bootstrap-section { text-align: center; padding: 20px 12px; }
.bootstrap-section p { margin-bottom: 10px; opacity: 0.8; }
.btn-large { padding: 8px 20px; font-size: 13px; font-weight: 600; }

.hidden { display: none; }
.mt-8 { margin-top: 6px; }
.port-info { font-size: 11px; opacity: 0.6; margin-top: 4px; }
.error-msg { color: #f14c4c; font-size: 12px; margin-top: 4px; }

.loading {
  display: inline-block;
  width: 12px; height: 12px;
  border: 2px solid var(--vscode-editor-foreground, #d4d4d4);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="app">

  <!-- Bootstrap-Wizard (bei erstem Start ohne Modelle) -->
  <div id="bootstrapSection" class="card bootstrap-section">
    <h2>Willkommen bei Zero-Token TTS</h2>
    <p>Der TTS-Server wird für die Sprachausgabe benötigt.<br>
    Klicke unten, um WasmEdge + die deutsche Eva-Stimme automatisch herunterzuladen.</p>
    <button class="btn btn-large" onclick="sendMsg('runBootstrap')">
      TTS-Server einrichten
    </button>
    <p class="port-info mt-8">Lädt WasmEdge v0.14.1 + Piper Eva-Modell (ca. 20 MB) + espeak-ng-Daten herunter</p>
  </div>

  <!-- Dashboard (nach erfolgreichem Bootstrap) -->
  <div id="dashboardSection" class="hidden">

    <!-- Server Status -->
    <div class="card">
      <h2>Server</h2>
      <div class="status-row">
        <span class="status-dot" id="statusDot"></span>
        <span id="statusText">Prüfe...</span>
      </div>
      <div id="serverDetails" class="hidden">
        <div class="port-info" id="portInfo"></div>
        <div class="error-msg hidden" id="errorMsg"></div>
      </div>
      <div class="btn-group">
        <button class="btn" id="btnStart" onclick="sendMsg('startServer')">Start</button>
        <button class="btn secondary" id="btnStop" onclick="sendMsg('stopServer')">Stop</button>
        <button class="btn secondary" id="btnRestart" onclick="sendMsg('restartServer')">Neustart</button>
      </div>
    </div>

    <!-- Modelle -->
    <div class="card">
      <h2>Modelle</h2>
      <div id="modelList">
        <div class="loading"></div> Lade...
      </div>
    </div>

    <!-- Info -->
    <div class="card" style="font-size:11px; opacity:0.6;">
      <strong>TTS-API:</strong> Port 18765 &bull;
      <strong>Extension-Proxy:</strong> Port 18766 &bull;
      <strong>MCP:</strong> Port 18764
    </div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();

function sendMsg(command, extra) {
  vscode.postMessage({ command: command, ...extra });
}

function $(id) { return document.getElementById(id); }

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'updateStatus') {
    render(msg.status, msg.models);
  }
});

function render(status, models) {
  const hasModels = models && models.some(m => m.downloaded);
  const needsBootstrap = !hasModels && status.state === 'stopped';

  if (needsBootstrap && !localStorage.getItem('bootstrapped')) {
    $('bootstrapSection').classList.remove('hidden');
    $('dashboardSection').classList.add('hidden');
    return;
  }

  $('bootstrapSection').classList.add('hidden');
  $('dashboardSection').classList.remove('hidden');

  // Server-Status
  const dot = $('statusDot');
  const text = $('statusText');
  const details = $('serverDetails');
  const errorMsg = $('errorMsg');
  const portInfo = $('portInfo');

  dot.className = 'status-dot ' + status.state;

  switch (status.state) {
    case 'running':
      text.textContent = 'Läuft' + (status.port ? ' auf Port ' + status.port : '');
      details.classList.remove('hidden');
      errorMsg.classList.add('hidden');
      portInfo.textContent = 'PID: ' + (status.pid || '?');
      $('btnStart').disabled = true;
      $('btnStop').disabled = false;
      $('btnRestart').disabled = false;
      break;
    case 'starting':
      text.textContent = 'Starte...';
      details.classList.remove('hidden');
      errorMsg.classList.add('hidden');
      portInfo.textContent = 'Bitte warten...';
      $('btnStart').disabled = true;
      $('btnStop').disabled = true;
      $('btnRestart').disabled = true;
      break;
    case 'error':
      text.textContent = 'Fehler';
      details.classList.remove('hidden');
      errorMsg.classList.remove('hidden');
      errorMsg.textContent = status.message || 'Unbekannter Fehler';
      $('btnStart').disabled = false;
      $('btnStop').disabled = true;
      $('btnRestart').disabled = false;
      break;
    default:
      text.textContent = 'Gestoppt';
      details.classList.add('hidden');
      $('btnStart').disabled = false;
      $('btnStop').disabled = true;
      $('btnRestart').disabled = true;
  }

  // Modelle rendern
  const list = $('modelList');
  if (!models || models.length === 0) {
    list.innerHTML = '<p>Keine Modelle verfügbar</p>';
    return;
  }

  list.innerHTML = models.map(m => {
    const installed = m.downloaded;
    return '<div class="model-item">' +
      '<div class="model-info">' +
        '<div class="model-name">' + escHtml(m.label) + '</div>' +
        '<div class="model-detail">' + escHtml(m.lang) + ' | ' + escHtml(m.quality) + ' | ' + escHtml(m.size) + '</div>' +
        '<div class="model-status ' + (installed ? 'installed' : 'missing') + '">' +
          (installed ? 'Installiert' : 'Nicht installiert') +
        '</div>' +
      '</div>' +
      '<div>' +
        (installed
          ? '<span style="opacity:0.5;font-size:11px;">' + (m.default ? 'Standard' : '') + '</span>'
          : '<button class="btn" onclick="sendMsg(\'downloadModel\', {modelId: \'' + m.id + '\'})">Herunterladen</button>'
        ) +
      '</div>' +
    '</div>';
  }).join('');
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
  }
}
