// ══════════════════════════════════════════════════════════════════════════════
// TTS History TreeView — Sidebar-Dashboard für Sprachausgaben
// Zeigt alle TTS-Ausgaben gruppiert nach Datum, mit Replay per Enter
// ══════════════════════════════════════════════════════════════════════════════
import * as vscode from "vscode";
import * as http from "http";
import { getTtsHistory, type TtsHistoryRow } from "./database";
import { speak } from "./tts-engine";

// ─── Quell-Icons ──────────────────────────────────────────────────────────────

const SOURCE_ICONS: Record<string, string> = {
  clipboard: "$(clippy)",
  selection: "$(symbol-text)",
  http:      "$(globe)",
  git:       "$(git-commit)",
  manual:    "$(megaphone)",
};
const SOURCE_LABELS: Record<string, string> = {
  clipboard: "Zwischenablage",
  selection: "Auswahl",
  http:      "HTTP",
  git:       "Git",
  manual:    "Manuell",
};

// ─── Gruppen ──────────────────────────────────────────────────────────────────

type GroupKey = "today" | "yesterday" | "thisWeek" | "older";

interface GroupMeta {
  key: GroupKey;
  label: string;
  icon: string;
}

const GROUPS: GroupMeta[] = [
  { key: "today",     label: "Heute",       icon: "$(clock)" },
  { key: "yesterday", label: "Gestern",     icon: "$(history)" },
  { key: "thisWeek",  label: "Diese Woche", icon: "$(calendar)" },
  { key: "older",     label: "Älter",       icon: "$(archive)" },
];

// ─── Root-Kategorie: TTS-Skill ────────────────────────────────────────────────

interface AgentInfo {
  name: string;
  version?: string;
}

let _currentAgent: AgentInfo | null = null;

/** Wird von extension.ts gesetzt, wenn sich der MCP-Status ändert */
export function setConnectedAgent(agent: AgentInfo | null) {
  _currentAgent = agent;
}

class TtsSkillItem extends vscode.TreeItem {
  constructor() {
    const connected = _currentAgent !== null;
    const label = connected
      ? `🎤 TTS-Skill aktiv (${_currentAgent!.name})`
      : "🎤 TTS-Skill aktivieren";
    const desc = connected
      ? "✅ Agent liest automatisch vor"
      : "⏳ Agent noch nicht verbunden";
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "ttsSkillItem";
    this.description = desc;
    this.tooltip = connected
      ? `${_currentAgent!.name} ist verbunden und nutzt den TTS-Skill`
      : "MCP-Server läuft – aber kein Agent verbunden. Bitte opencode.json konfigurieren:\n" +
        '  "mcpServers": { "tts-skill": { "url": "http://localhost:18764/sse" } }';
    this.iconPath = new vscode.ThemeIcon(connected ? "check" : "book");
  }
}

// ─── TreeItem-Typen ───────────────────────────────────────────────────────────

class TtsDateGroupItem extends vscode.TreeItem {
  constructor(
    public readonly group: GroupMeta,
    public readonly itemCount: number
  ) {
    super(`${group.icon} ${group.label} (${itemCount})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "ttsDateGroup";
    this.description = itemCount === 1 ? "1 Eintrag" : `${itemCount} Einträge`;
    this.tooltip = `${group.label}: ${itemCount} TTS-Ausgabe${itemCount !== 1 ? "n" : ""}`;
  }
}

class TtsHistoryItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TtsHistoryRow
  ) {
    const sourceIcon = SOURCE_ICONS[entry.source] || "$(megaphone)";
    const sourceLabel = SOURCE_LABELS[entry.source] || entry.source;
    const time = entry.played_at
      ? new Date(entry.played_at + "Z").toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
      : "?";

    // Label = Quelle + Textvorschau (für Screenreader)
    super(entry.text_preview || "(leer)", vscode.TreeItemCollapsibleState.None);

    this.contextValue = "ttsHistoryEntry";
    this.description = `${sourceIcon} ${sourceLabel} · ${time} · (${entry.played_count}x)`;
    this.id = String(entry.id);

    // Tooltip: vollständiger Text
    this.tooltip = [
      `Quelle:    ${sourceLabel}`,
      `Engine:    ${entry.engine}`,
      `Stimme:    ${entry.voice}`,
      `Gesprochen: ${entry.played_at || "?"}`,
      `Abgespielt: ${entry.played_count}x`,
      ``,
      entry.text,
    ].join("\n");

    this.iconPath = new vscode.ThemeIcon("megaphone");
  }
}

// ─── TreeDataProvider ─────────────────────────────────────────────────────────

export class TtsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _autoPlay = false;

  get autoPlay(): boolean { return this._autoPlay; }

  setAutoPlay(val: boolean): void {
    this._autoPlay = val;
    this.refresh();
    vscode.commands.executeCommand("setContext", "zeroTokenTts:autoPlay", val);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
  try {
    if (element) {
      if (element instanceof TtsDateGroupItem) {
        return this.getEntriesForGroup(element.group.key);
      }
      return [];
    }
    const skillItem = new TtsSkillItem();
    const groups = this.buildGroups();
    return [skillItem, ...groups];
  } catch (e: any) {
    console.error("[TtsTree] getChildren error:", e);
    return [];
  }
}

  /** Eintrag per ID finden */
  getEntryById(id: number): TtsHistoryRow | undefined {
    const entries = getTtsHistory(500);
    return entries.find((e) => e.id === id);
  }

  /** Eintrag erneut abspielen */
  async replayEntry(entry: TtsHistoryRow): Promise<void> {
    if (!entry.text.trim()) return;
    try {
      const audioData = await speak(entry.text);
      // Immer an Audio-Panel senden
      vscode.commands.executeCommand("zero-token-tts.speakAudioData", audioData.toString("base64"));
      // Play-Count erhöhen
      const { incrementTtsPlayed } = require("./database");
      incrementTtsPlayed(entry.id);
      this.refresh();
    } catch (e: any) {
      vscode.window.showErrorMessage(`TTS-Fehler: ${e.message}`);
    }
  }

  // ─── Privat ──────────────────────────────────────────────────────────────

  private buildGroups(): TtsDateGroupItem[] {
    const entries = getTtsHistory(500);
    const grouped = this.groupByDate(entries);

    return GROUPS
      .map((g) => {
        const items = grouped.get(g.key);
        return items && items.length > 0 ? new TtsDateGroupItem(g, items.length) : null;
      })
      .filter(Boolean) as TtsDateGroupItem[];
  }

  private getEntriesForGroup(groupKey: GroupKey): TtsHistoryItem[] {
    const entries = getTtsHistory(500);
    const grouped = this.groupByDate(entries);
    const items = grouped.get(groupKey) || [];
    return items.map((e) => new TtsHistoryItem(e));
  }

  private groupByDate(entries: TtsHistoryRow[]): Map<GroupKey, TtsHistoryRow[]> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const weekStart = new Date(today);
    const dayOfWeek = weekStart.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart.setDate(weekStart.getDate() - diff);

    const groups: Record<GroupKey, TtsHistoryRow[]> = {
      today: [], yesterday: [], thisWeek: [], older: [],
    };

    for (const e of entries) {
      let d: Date;
      try {
        d = new Date((e.played_at || "") + "Z");
      } catch { d = new Date(); }
      if (isNaN(d.getTime())) d = new Date();

      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());

      if (day.getTime() === today.getTime()) {
        groups.today.push(e);
      } else if (day.getTime() === yesterday.getTime()) {
        groups.yesterday.push(e);
      } else if (day >= weekStart) {
        groups.thisWeek.push(e);
      } else {
        groups.older.push(e);
      }
    }

    const result = new Map<GroupKey, TtsHistoryRow[]>();
    for (const [key, rows] of Object.entries(groups)) {
      if (rows.length > 0) result.set(key as GroupKey, rows);
    }
    return result;
  }
}
