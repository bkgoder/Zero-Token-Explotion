// ══════════════════════════════════════════════════════════════════════════════
// SQLite Database Layer — TTS Cache + Settings (kein Changelog)
// ══════════════════════════════════════════════════════════════════════════════
import initSqlJs from "sql.js";
import * as path from "path";

let db: any = null;
const DB_PATH = "zero-token-tts.db";

export interface SettingsRow {
  key: string;
  value: string;
}

// ══════════════════════════════════════════════════════════════════════════════

export async function initDatabase(storagePath: string): Promise<any> {
  if (db) return db;

  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(__dirname, file),
  });

  const dbPath = path.join(storagePath, DB_PATH);

  const fs = require("fs");
  let buffer: Buffer | null = null;
  try {
    buffer = fs.readFileSync(dbPath);
  } catch {}

  db = new SQL.Database(buffer);

  db.run(`
    CREATE TABLE IF NOT EXISTS tts_cache (
      text_hash TEXT PRIMARY KEY,
      audio_data BLOB,
      engine TEXT NOT NULL DEFAULT 'gtts',
      voice TEXT NOT NULL DEFAULT 'google',
      created_at TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tts_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      text_preview TEXT NOT NULL DEFAULT '',
      engine TEXT NOT NULL DEFAULT '',
      voice TEXT NOT NULL DEFAULT '',
      text_hash TEXT NOT NULL DEFAULT '',
      played_at TEXT DEFAULT (datetime('now')),
      played_count INTEGER DEFAULT 1
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tts_history_played ON tts_history(played_at DESC)`);

  try { setSetting("storagePath", storagePath); } catch {}

  saveDatabase(db, dbPath);

  return db;
}

function saveDatabase(database: any, dbPath: string): void {
  try {
    const data = database.export();
    const fs = require("fs");
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (e) {
    console.error(`[DB] Fehler beim Speichern: ${e}`);
  }
}

export function getDatabase(): any {
  if (!db) throw new Error("Datenbank nicht initialisiert");
  return db;
}

export function closeDatabase(): void {
  if (db) { db.close(); db = null; }
}

// ══════════════════════════════════════════════════════════════════════════════
// TTS Cache
// ══════════════════════════════════════════════════════════════════════════════

export function getTtsCache(textHash: string): Buffer | null {
  const database = getDatabase();
  const stmt = database.prepare("SELECT audio_data FROM tts_cache WHERE text_hash = ?");
  stmt.bind([textHash]);
  if (stmt.step()) {
    const row = stmt.getAsObject() as any;
    stmt.free();
    database.run("UPDATE tts_cache SET access_count = access_count + 1 WHERE text_hash = ?", [textHash]);
    return row.audio_data as Buffer;
  }
  stmt.free();
  return null;
}

export function setTtsCache(textHash: string, audioData: Buffer, engine: string, voice: string): void {
  const database = getDatabase();
  database.run(
    `INSERT OR REPLACE INTO tts_cache (text_hash, audio_data, engine, voice, created_at, access_count)
     VALUES (?, ?, ?, ?, datetime('now'), 1)`,
    [textHash, audioData, engine, voice]
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TTS History (Dashboard)
// ══════════════════════════════════════════════════════════════════════════════

export interface TtsHistoryRow {
  id: number;
  source: string;       // "clipboard", "selection", "http", "git", "manual"
  text: string;
  text_preview: string; // erste 100 Zeichen
  engine: string;       // "piper" | "gtts"
  voice: string;        // "eva" | "thorsten" | "google"
  text_hash: string;
  played_at: string;    // ISO datetime
  played_count: number;
}

export function addTtsHistory(
  source: string,
  text: string,
  engine: string,
  voice: string,
  textHash: string
): void {
  const database = getDatabase();
  const preview = text.length > 100 ? text.slice(0, 100) + "…" : text;
  database.run(
    `INSERT INTO tts_history (source, text, text_preview, engine, voice, text_hash, played_at, played_count)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 1)`,
    [source, text, preview, engine, voice, textHash]
  );
}

export function getTtsHistory(limit = 200, offset = 0): TtsHistoryRow[] {
  const database = getDatabase();
  const stmt = database.prepare(
    "SELECT id, source, text, text_preview, engine, voice, text_hash, played_at, played_count FROM tts_history ORDER BY id DESC LIMIT ? OFFSET ?"
  );
  stmt.bind([limit, offset]);
  const rows: TtsHistoryRow[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as any as TtsHistoryRow);
  stmt.free();
  return rows;
}

export function getTtsHistoryCount(): number {
  const database = getDatabase();
  const result = database.exec("SELECT COUNT(*) as count FROM tts_history");
  if (result.length > 0 && result[0].values.length > 0)
    return parseInt(result[0].values[0][0] as string, 10);
  return 0;
}

export function incrementTtsPlayed(id: number): void {
  const database = getDatabase();
  database.run("UPDATE tts_history SET played_count = played_count + 1 WHERE id = ?", [id]);
}

export function deleteTtsHistoryOlderThan(days: number): void {
  const database = getDatabase();
  database.run(
    `DELETE FROM tts_history WHERE played_at < datetime('now', ?)`,
    [`-${days} days`]
  );
}

export function clearTtsHistory(): void {
  const database = getDatabase();
  database.run("DELETE FROM tts_history");
}

// ══════════════════════════════════════════════════════════════════════════════
// Settings
// ══════════════════════════════════════════════════════════════════════════════

export function getSetting(key: string, defaultValue = ""): string {
  const database = getDatabase();
  const stmt = database.prepare("SELECT value FROM settings WHERE key = ?");
  stmt.bind([key]);
  if (stmt.step()) {
    const row = stmt.getAsObject() as any;
    stmt.free();
    return row.value as string;
  }
  stmt.free();
  return defaultValue;
}

export function setSetting(key: string, value: string): void {
  const database = getDatabase();
  database.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value]);
}

export function persistDatabase(): void {
  if (!db) return;
  const storagePath = getSetting("storagePath");
  if (!storagePath) return;
  const dbPath = path.join(storagePath, DB_PATH);
  saveDatabase(db, dbPath);
}
