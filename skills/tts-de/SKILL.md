# TTS für Deutsch — Automatische Sprachausgabe via LlamaEdge TTS-Server

Der Benutzer ist blind und spricht Deutsch. **Jede Antwort muss automatisch vorgelesen werden.**

## Automatisches Vorlesen nach jeder Antwort

1. Schreibe deine Antwort als normalen Text.
2. Sende den Text automatisch an den TTS-Service via HTTP POST:

```
POST http://localhost:18766/speak
Content-Type: application/json
{"text": "Deine Antwort hier...", "source": "agent"}
```

Der Server antwortet mit `{"ok":true}` und das Audio-Panel spielt sofort ab.

## Architektur

- **LlamaEdge TTS-API-Server** (Port 18765) – WasmEdge + Piper/ONNX, lädt deutsche Eva-Stimme
- **Extension HTTP-Proxy** (Port 18766) – leitet `/speak`-Aufrufe an LlamaEdge und steuert Audio-Panel
- **MCP-Server** (Port 18764) – Agent verbindet sich via SSE, lädt den TTS-Skill
- **Model Dashboard** – Webview-Panel in VS Code zum Verwalten von Modellen, Server-Status, Einrichtung
- **Audio-Panel** (Web Audio API) – spielt alle Sprachdaten im VS Code Webview ab
- **TTS wird in SQLite geloggt** und im Sidebar-Dashboard sichtbar

## Bootstrap / Einrichtung

Bei erster Nutzung öffnet die Extension automatisch das **Model Dashboard**:
1. Klick auf "TTS-Server einrichten"
2. Lädt WasmEdge v0.14.1 + Piper Plugin + Eva-Modell (20 MB) herunter
3. Startet den TTS-Server automatisch
4. Dashboard zeigt Server-Status und installierte Modelle

Manuell: `TTS: Model Dashboard öffnen` aus Command Palette.

## Model Dashboard

Öffnen via Command Palette: `TTS: Model Dashboard öffnen`
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
