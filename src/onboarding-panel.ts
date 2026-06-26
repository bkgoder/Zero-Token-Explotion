// ══════════════════════════════════════════════════════════════════════════════
// Zero-Token TTS — Onboarding Panel für Erstinstallation
// ══════════════════════════════════════════════════════════════════════════════
import * as vscode from "vscode";

// ─── Onboarding Panel ────────────────────────────────────────────────────────

export class OnboardingPanel {
  public static currentPanel: OnboardingPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.html = this._getHtml();
    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables
    );
  }

  static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (OnboardingPanel.currentPanel) {
      OnboardingPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "zeroTokenOnboarding",
      "Willkommen bei Zero-Token TTS",
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "resources"),
        ],
      }
    );

    OnboardingPanel.currentPanel = new OnboardingPanel(panel, extensionUri);
  }

  private dispose() {
    OnboardingPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private _handleMessage(msg: any) {
    switch (msg.command) {
      case "openDashboard": {
        this.dispose();
        vscode.commands.executeCommand("zero-token-tts.openModelDashboard");
        break;
      }
      case "installExtension": {
        vscode.env.openExternal(vscode.Uri.parse("https://marketplace.visualstudio.com/items?itemName=zero-token.zero-token-tts"));
        break;
      }
      case "configureOpencode": {
        vscode.commands.executeCommand("zero-token-tts.showMcpConfig");
        vscode.window.showInformationMessage(
          "📋 MCP-Konfiguration kopiert! In opencode.json einfügen."
        );
        break;
      }
    }
  }

  private _getHtml(): string {
     const csp = `default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${this._panel.webview.cspSource} https: data:; font-src ${this._panel.webview.cspSource}; connect-src http://localhost:*;`;
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
      padding: 20px;
      font-size: 14px;
      line-height: 1.6;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    .card {
      background: var(--vscode-input-background, #3c3c3c);
      border: 1px solid var(--vscode-widget-border, #555);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--vscode-foreground, #fff);
    }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin: 20px 0 12px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-family: inherit;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      text-decoration: none;
      margin: 8px 8px 8px 0;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .btn.secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .btn:disabled { opacity: 0.5; cursor: default; }
    .step {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      margin: 16px 0;
    }
    .step-number {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      flex-shrink: 0;
    }
    .step-content { flex: 1; }
    .step-title { font-weight: 600; margin-bottom: 4px; }
    .step-desc { opacity: 0.8; font-size: 13px; }
    .code-block {
      background: var(--vscode-textCodeBlock-background, #2d2d2d);
      border: 1px solid var(--vscode-widget-border, #555);
      border-radius: 4px;
      padding: 12px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 12px;
      margin: 8px 0;
      overflow-x: auto;
    }
    .icon { margin-right: 8px; }
    .welcome-icon { font-size: 32px; margin-bottom: 16px; display: block; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <span class="welcome-icon">🎤</span>
      <h1>Willkommen bei Zero-Token TTS</h1>
      
      <p>Zero-Token TTS ermöglicht Sprachausgabe direkt in VS Code mit lokalem WasmEdge TTS und integriertem AI-Agent.</p>
      
      <h2>Erste Schritte</h2>
      
      <div class="step">
        <div class="step-number">1</div>
        <div class="step-content">
          <div class="step-title">Extension installieren</div>
          <div class="step-desc">Die Extension ist bereits installiert. Klicken Sie auf den Statusleisten-Button $(megaphone) TTS, um zu starten.</div>
        </div>
      </div>
      
      <div class="step">
        <div class="step-number">2</div>
        <div class="step-content">
          <div class="step-title">Modelle herunterladen</div>
          <div class="step-desc">Öffnen Sie das Modelldashboard, um WasmEdge + die deutsche Eva-Stimme herunterzuladen (≈20 MB).</div>
        </div>
      </div>
      
      <div class="step">
        <div class="step-number">3</div>
        <div class="step-content">
          <div class="step-title">AI-Agent verbinden</div>
          <div class="step-desc">Fügen Sie die MCP-Konfiguration zu opencode.json hinzu, um den TTS-Skill zu aktivieren.</div>
        </div>
      </div>
      
      <h2>Schnellzugriff</h2>
      
      <button class="btn" onclick="sendMsg('openDashboard')">
        <span>📊</span> Modelldashboard öffnen
      </button>
      
      <button class="btn secondary" onclick="sendMsg('configureOpencode')">
        <span>📋</span> MCP-Konfiguration kopieren
      </button>
      
      <h2>Konfiguration</h2>
      
      <div class="code-block">{
  "mcpServers": {
    "tts-skill": {
      "url": "http://localhost:18764/sse"
    }
  }
}</div>
      
      <p><small>Fügen Sie diese Konfiguration zu <code>~/.opencode/opencode.json</code> hinzu, um den TTS-Skill zu aktivieren.</small></p>
      
      <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--vscode-widget-border, #555);">
        <small>Zero-Token TTS v1.4.2 • WasmEdge + Piper Eva • Port 18765 (TTS-API) • Port 18766 (Extension-Proxy) • Port 18764 (MCP)</small>
      </div>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    function sendMsg(command, extra) {
      vscode.postMessage({ command: command, ...extra });
    }
  </script>
</body>
</html>`;
  }
}