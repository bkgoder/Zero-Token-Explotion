// ══════════════════════════════════════════════════════════════════════════════
// TTS Bootstrap — WasmEdge + Modelle herunterladen, Server starten/stoppen
// ══════════════════════════════════════════════════════════════════════════════
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";
import { spawn, ChildProcess } from "child_process";
import { getSetting, setSetting } from "./database";

// ─── Server-Manager (Singleton) ──────────────────────────────────────────────

class TtsServerManager {
  private process: ChildProcess | null = null;
  private _outputChannel: vscode.OutputChannel;
  private _onStatusChange = new vscode.EventEmitter<ServerStatus>();
  readonly onStatusChange = this._onStatusChange.event;

  private _status: ServerStatus = { state: "stopped" };

  get status(): ServerStatus {
    return { ...this._status };
  }

  constructor(outputChannel: vscode.OutputChannel) {
    this._outputChannel = outputChannel;
  }

  // ─── Health-Check ────────────────────────────────────────────────────────

  async checkHealth(port = 18765): Promise<boolean> {
    return new Promise((resolve) => {
      // LlamaEdge hat nur /v1/audio/speech – prüfe ob Port antwortet
      const body = JSON.stringify({ model: "piper", input: "", voice: "alloy", response_format: "wav", speed: 1.0 });
      const req = http.request(
        {
          hostname: "localhost",
          port,
          path: "/v1/audio/speech",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 3000,
        },
        (res) => {
          // Jede Antwort (auch 400/422) bedeutet Server läuft
          resolve(res.statusCode !== undefined);
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  }

  // ─── Server starten ──────────────────────────────────────────────────────

  async start(port = 18765): Promise<boolean> {
    if (this.process) {
      this.log("Server läuft bereits");
      return true;
    }

    // Prüfen ob schon ein externer Server läuft
    const alreadyRunning = await this.checkHealth(port);
    if (alreadyRunning) {
      this._setStatus({ state: "running", port, pid: 0 });
      this.log("Externer TTS-Server läuft bereits auf Port " + port);
      return true;
    }

    const binDir = this.getBinDir();
    const serverBinary = this.findServerBinary();

    if (!serverBinary) {
      this._setStatus({ state: "error", message: "TTS-Server Binary nicht gefunden" });
      return false;
    }

    this._setStatus({ state: "starting", port });

    // Start the unified TTS+MCP server binary
    this.process = spawn(serverBinary, [], {
      cwd: binDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TTS_PORT: String(port),
        TTS_ASSETS_DIR: binDir,
      },
    });

    this.process.stdout?.on("data", (d) => this.log(`[server] ${d.toString().trim()}`));
    this.process.stderr?.on("data", (d) => this.log(`[server] ${d.toString().trim()}`));

    this.process.on("error", (err) => {
      this.log(`Fehler: ${err.message}`);
      this._setStatus({ state: "error", message: err.message });
      this.process = null;
    });

    this.process.on("exit", (code, signal) => {
      this.log(`Prozess exit (code=${code}, signal=${signal})`);
      this.process = null;
      this._setStatus({ state: "stopped" });
    });

    // Warten bis Server antwortet
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await this.checkHealth(port)) {
        this._setStatus({ state: "running", port, pid: this.process?.pid });
        this.log("TTS-Server läuft auf Port " + port);
        return true;
      }
      if (!this.process) break; // abgestürzt
    }

    // Timeout
    this.stop();
    this._setStatus({ state: "error", message: "Server-Start timeout (30s)" });
    return false;
  }

  // ─── Server stoppen ──────────────────────────────────────────────────────

  stop(): void {
    if (this.process) {
      this.log("Stoppe TTS-Server...");
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process) {
          this.process.kill("SIGKILL");
          this.process = null;
        }
      }, 5000);
      this._setStatus({ state: "stopped" });
    }
  }

  // ─── Restart ─────────────────────────────────────────────────────────────

  async restart(port = 18765): Promise<boolean> {
    this.stop();
    await sleep(2000);
    return this.start(port);
  }

  // ─── Verzeichnisse ───────────────────────────────────────────────────────

  getBinDir(): string {
    // Speicherort für TTS-Server-Binaries (im Extension-Ordner)
    const storagePath = getSetting("storagePath");
    if (storagePath) {
      const dir = path.join(storagePath, "tts-server");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    // Fallback: neben der Extension
    const dir = path.join(__dirname, "..", "tts-server");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private findServerBinary(): string | null {
    const binDir = this.getBinDir();
    
    // Look for the bundled binary (platform-specific)
    const binaryName = process.platform === "win32" 
      ? "zero-token-tts-server.exe" 
      : "zero-token-tts-server-" + (process.arch === "arm64" ? "arm64" : "x64");
    
    // 1. In extension root (for VSIX)
    const rootPath = path.join(binDir, "..", "..", binaryName);
    if (fs.existsSync(rootPath)) return rootPath;
    
    // 2. In bin/ directory
    const binPath = path.join(binDir, "..", "bin", binaryName);
    if (fs.existsSync(binPath)) return binPath;
    
    // 3. In binDir itself
    const inBinDir = path.join(binDir, binaryName);
    if (fs.existsSync(inBinDir)) return inBinDir;
    
    return null;
  }

  // ─── Downloads ──────────────────────────────────────────────────────────

  /** Lädt WasmEdge + Plugin + ONNX Runtime herunter */
  async downloadWasmEdge(progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<boolean> {
    const binDir = this.getBinDir();
    const homeDir = process.env.HOME || "/root";
    const wasmedgeBin = path.join(homeDir, ".wasmedge", "bin");

    try {
      progress.report({ message: "Lade WasmEdge v0.14.1 herunter..." });

      // WasmEdge install script
      const scriptPath = path.join(binDir, "install-wasmedge.sh");
      const script = `#!/bin/bash
set -e
curl -sSf https://raw.githubusercontent.com/WasmEdge/WasmEdge/master/utils/install_v2.sh \
  | bash -s -- -v 0.14.1
`;

      fs.writeFileSync(scriptPath, script, { mode: 0o755 });

      const result = spawnSync("bash", [scriptPath], { cwd: binDir });
      if (result.status !== 0) {
        this.log("WasmEdge-Installation fehlgeschlagen: " + (result.stderr || result.stdout));
        return false;
      }

      progress.report({ message: "Installiere Piper Plugin...", increment: 30 });

      // Piper Plugin
      const pluginDir = path.join(homeDir, ".wasmedge", "plugin");
      fs.mkdirSync(pluginDir, { recursive: true });
      const pluginUrl = "https://github.com/WasmEdge/WasmEdge/releases/download/0.14.1/WasmEdge-plugin-wasi_nn-piper-0.14.1-ubuntu20.04_x86_64.tar.gz";
      await downloadAndExtract(pluginUrl, pluginDir);

      progress.report({ message: "Installiere ONNX Runtime...", increment: 20 });

      // ONNX Runtime
      const onnxUrl = "https://github.com/microsoft/onnxruntime/releases/download/v1.14.1/onnxruntime-linux-x64-1.14.1.tgz";
      const onnxTmp = path.join(binDir, "onnx.tgz");
      await downloadFile(onnxUrl, onnxTmp);
      spawnSync("tar", ["-xz", "-C", "/tmp", "-f", onnxTmp]);
      spawnSync("sudo", ["cp", "/tmp/onnxruntime-linux-x64-1.14.1/lib/libonnxruntime.so*", "/usr/lib/"]);
      spawnSync("sudo", ["ldconfig"]);
      fs.unlinkSync(onnxTmp);

      // Source env
      const envFile = path.join(homeDir, ".wasmedge", "env");
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, "utf-8");
        for (const line of envContent.split("\n")) {
          if (line.startsWith("export ")) {
            const match = line.match(/export\s+(\w+)=(.*)/);
            if (match) {
              process.env[match[1]] = match[2].replace(/["']/g, "");
            }
          }
        }
      }

      progress.report({ message: "WasmEdge installiert", increment: 10 });
      return true;
    } catch (e: any) {
      this.log("Download fehlgeschlagen: " + e.message);
      return false;
    }
  }

  /** Liste aller verfügbaren Piper-Modelle */
  getAvailableModels(): PiperModel[] {
    return AVAILABLE_MODELS;
  }

  /** Prüft ob ein Modell lokal vorhanden ist */
  isModelDownloaded(model: PiperModel): boolean {
    const binDir = this.getBinDir();
    return fs.existsSync(path.join(binDir, model.onnxFile));
  }

  /** Zeigt installierte Modelle an */
  getInstalledModels(): PiperModel[] {
    return AVAILABLE_MODELS.filter((m) => this.isModelDownloaded(m));
  }

  /** Lädt ein einzelnes Modell herunter */
  async downloadModel(
    model: PiperModel,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<boolean> {
    const binDir = this.getBinDir();

    try {
      progress.report({ message: `Lade ${model.label} (${model.size})...` });

      // .onnx
      const onnxPath = path.join(binDir, model.onnxFile);
      if (!fs.existsSync(onnxPath)) {
        await downloadFile(model.onnxUrl, onnxPath);
      }

      // .onnx.json
      const jsonPath = path.join(binDir, model.onnxFile + ".json");
      if (!fs.existsSync(jsonPath) && model.jsonUrl) {
        await downloadFile(model.jsonUrl, jsonPath);
      }

      progress.report({ message: `${model.label} fertig`, increment: 100 });

      // espeak-ng-data (nur einmal)
      const espeakDir = path.join(binDir, "espeak-ng-data");
      if (!fs.existsSync(espeakDir)) {
        progress.report({ message: "Lade espeak-ng-Daten..." });
        await downloadAndExtract(model.espeakUrl, binDir);
      }

      return true;
    } catch (e: any) {
      this.log(`Download fehlgeschlagen: ${model.label} – ${e.message}`);
      return false;
    }
  }

  /** Prüft ob der unified TTS-Server Binary vorhanden ist */
  async downloadAll(
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<boolean> {
    const binDir = this.getBinDir();
    const serverBinary = this.findServerBinary();
    
    if (!serverBinary) {
      progress.report({ message: "TTS-Server Binary nicht gefunden. Bitte Extension neu installieren." });
      return false;
    }

    // Prüfe ob Piper-Modelle vorhanden sind
    const modelPath = path.join(binDir, "de_DE-eva_k-x_low.onnx");
    if (!fs.existsSync(modelPath)) {
      progress.report({ message: "Lade Piper-Modell (Eva-Stimme)..." });
      const evaModel = AVAILABLE_MODELS[0];
      const ok = await this.downloadModel(evaModel, progress);
      if (!ok) return false;
    }

    progress.report({ message: "TTS-Server bereit" });
    return true;
  }

  // ─── Hilfsfunktionen ─────────────────────────────────────────────────────

  private log(msg: string): void {
    this._outputChannel.appendLine(`[Bootstrap] ${msg}`);
  }

  private _setStatus(status: ServerStatus): void {
    this._status = status;
    this._onStatusChange.fire(status);
  }
}

// ─── Typen ──────────────────────────────────────────────────────────────────

export interface ServerStatus {
  state: "stopped" | "starting" | "running" | "error";
  port?: number;
  pid?: number;
  message?: string;
}

export interface PiperModel {
  id: string;
  label: string;
  voice: string;
  lang: string;
  quality: string;
  onnxFile: string;
  onnxUrl: string;
  jsonUrl?: string;
  espeakUrl: string;
  size: string;
  default: boolean;
}

// ─── Verfügbare Piper-Modelle ────────────────────────────────────────────────

const AVAILABLE_MODELS: PiperModel[] = [
  {
    id: "de_DE-eva_k-x_low",
    label: "Eva (weiblich, Deutsch)",
    voice: "eva",
    lang: "de",
    quality: "x_low",
    onnxFile: "de_DE-eva_k-x_low.onnx",
    onnxUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/eva_k/x_low/de_DE-eva_k-x_low.onnx",
    jsonUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/eva_k/x_low/de_DE-eva_k-x_low.onnx.json",
    espeakUrl: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz",
    size: "20 MB",
    default: true,
  },
  {
    id: "de_DE-thorsten_emotional-medium",
    label: "Thorsten emotional (männlich, Deutsch)",
    voice: "thorsten",
    lang: "de",
    quality: "medium",
    onnxFile: "de_DE-thorsten_emotional-medium.onnx",
    onnxUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx",
    jsonUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium.onnx.json",
    espeakUrl: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz",
    size: "42 MB",
    default: false,
  },
  {
    id: "en_GB-alan-medium",
    label: "Alan (männlich, Englisch UK)",
    voice: "alan",
    lang: "en",
    quality: "medium",
    onnxFile: "en_GB-alan-medium.onnx",
    onnxUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx",
    jsonUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json",
    espeakUrl: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz",
    size: "30 MB",
    default: false,
  },
  {
    id: "en_US-amy-medium",
    label: "Amy (weiblich, Englisch US)",
    voice: "amy",
    lang: "en",
    quality: "medium",
    onnxFile: "en_US-amy-medium.onnx",
    onnxUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx",
    jsonUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json",
    espeakUrl: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz",
    size: "37 MB",
    default: false,
  },
];

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnSync(cmd: string, args: string[], opts?: any): any {
  const cp = require("child_process");
  return cp.spawnSync(cmd, args, { timeout: 120000, ...opts });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const mod = url.startsWith("https") ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Redirect folgen
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} für ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

function downloadAndExtract(url: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(destDir, ".tmp-"));
    const tmpFile = path.join(tmpDir, "archive.tar.gz");

    downloadFile(url, tmpFile)
      .then(() => {
        const result = spawnSync("tar", ["-xz", "-C", tmpDir, "-f", tmpFile]);
        if (result.status !== 0) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return reject(new Error("Extract fehlgeschlagen"));
        }

        // Verschiebe alles aus tmpDir nach destDir
        const entries = fs.readdirSync(tmpDir);
        for (const entry of entries) {
          if (entry.endsWith(".tgz") || entry.endsWith(".tar.gz")) continue;
          const src = path.join(tmpDir, entry);
          const dst = path.join(destDir, entry);
          if (fs.existsSync(dst)) {
            // Bei piper: nur espeak-ng-data brauchen wir
            if (entry === "espeak-ng-data") {
              fs.rmSync(dst, { recursive: true, force: true });
              fs.renameSync(src, dst);
            }
          } else {
            try { fs.renameSync(src, dst); } catch {}
          }
        }

        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      })
      .catch(reject);
  });
}

// ─── Singleton Export ────────────────────────────────────────────────────────

let _instance: TtsServerManager | null = null;

export function getServerManager(outputChannel: vscode.OutputChannel): TtsServerManager {
  if (!_instance) {
    _instance = new TtsServerManager(outputChannel);
  }
  return _instance;
}
