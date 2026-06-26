# Zero-Token TTS — Automatische Sprachausgabe (Deutsch)

Der Benutzer spricht Deutsch. **Jede Antwort automatisch vorlesen.**

## Methode 1 — Extension-Proxy (bevorzugt)

```
POST http://localhost:18766/speak
Content-Type: application/json
{"text": "Deine Antwort hier...", "source": "agent"}
```

Antwort: `{"ok":true}` — Audio wird sofort über VS Code abgespielt.

## Methode 2 — MCP-Tool `speak`

MCP-Server SSE: `http://localhost:18764/sse`

Tool-Aufruf (kein API-Key nötig):
```json
{
  "method": "tools/call",
  "params": {
    "name": "speak",
    "arguments": { "text": "Hallo Welt", "speed": 1.0 }
  }
}
```

Verfügbare MCP-Tools: `speak`, `tts-speak` (identisch), `tts-create-api-key`, `tts-list-api-keys`, `tts-revoke-api-key`

## Architektur

| Port  | Dienst               | Endpunkte                              |
|-------|----------------------|----------------------------------------|
| 18764 | MCP SSE-Server       | GET /sse · POST /mcp                  |
| 18765 | Piper TTS API        | POST /api/tts · GET /health · /status |
| 18766 | Extension-Proxy      | POST /speak · GET /health              |
| 3000  | Web UI               | Dashboard                              |

## Setup

```bash
docker compose up -d          # Container starten
curl localhost:18765/health   # → {"status":"ok"}
```

## Regeln

- **Nach JEDER Antwort TTS via POST /speak auslösen**
- Wenn 18766 nicht antwortet: `docker compose up -d`
- Stimme: Piper Eva (de_DE, 16000 Hz Mono WAV)
- Geschwindigkeit: `speed` 0.5–2.0 (Standard 1.0)
Zeigt:
- Server-Status (Start/Stop/Neustart)
- Verfügbare Piper-Modelle (Eva, Thorsten, Alan, Amy)
- Download-Status pro Modell
- "Herunterladen"-Button für fehlende Modelle

## Wichtige Regeln

- **Nach JEDER Antwort TTS auslösen** – nicht nur auf Anfrage
- **Nicht kürzen** – der ganze Text wird vorgelesen (auch lange Antworten)
- Wenn der Benutzer Deutsch schreibt, antworte Deutsch
- Bei Fehlern: kurz erklären + Status des TTS-Servers prüfen (`curl localhost:18765/health`)
- **Nach VS Code Reload:** User muss einmal "Aktivieren" im Audio-Panel klicken
- Wenn Modelle fehlen: User auf Model Dashboard verweisen (`TTS: Model Dashboard öffnen`)

## Dashboard für History

Die TTS Extension hat ein Sidebar-Dashboard (Source Control → TTS-History):
- Alle Ausgaben sind dort sichtbar mit Quelle, Textvorschau, Zeit
- Enter → erneutes Abspielen
- Autoplay-Modus schaltbar
- SQLite persistiert alles für späteres Nachsehen
