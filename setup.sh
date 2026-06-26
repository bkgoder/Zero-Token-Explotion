#!/bin/bash
# Zero-Token TTS — Fresh System Setup Script
# Installiert Dependencies, baut Extension, startet Docker,
# trägt MCP-Server ein und deployt Skills zu allen Agents.

set -e

NODE_REQUIRED_MAJOR=18
NODE_INSTALL_MAJOR=22
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

load_nvm() {
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        # shellcheck disable=SC1090
        . "$NVM_DIR/nvm.sh"
        return 0
    fi

    if ! command -v curl &> /dev/null; then
        echo "❌ curl ist nicht installiert."
        echo "   Bitte curl installieren oder nvm manuell einrichten."
        exit 1
    fi

    echo "⬇️  Installiere nvm..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        echo "❌ nvm konnte nicht installiert werden."
        exit 1
    fi

    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
}

ensure_node() {
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge "$NODE_REQUIRED_MAJOR" ]; then
            echo "✅ Node.js $(node -v) gefunden"
            return 0
        fi

        echo "⚠️  Node.js $(node -v) ist zu alt. Installiere Node.js ${NODE_INSTALL_MAJOR} via nvm..."
    else
        echo "⚠️  Node.js ist nicht installiert. Installiere Node.js ${NODE_INSTALL_MAJOR} via nvm..."
    fi

    load_nvm
    nvm install "$NODE_INSTALL_MAJOR"
    nvm use "$NODE_INSTALL_MAJOR"
    nvm alias default "$NODE_INSTALL_MAJOR" >/dev/null
    echo "✅ Node.js $(node -v) via nvm aktiviert"
}

echo "🚀 Zero-Token TTS — Fresh System Setup"
echo "========================================"
echo ""

# 1. Node.js prüfen
ensure_node

# 2. npm prüfen
if ! command -v npm &> /dev/null; then
    echo "❌ npm ist nicht installiert."
    exit 1
fi
echo "✅ npm $(npm -v) gefunden"

# 3. Git prüfen
if ! command -v git &> /dev/null; then
    echo "❌ Git ist nicht installiert."
    echo "   Installiere Git..."
    sudo apt-get update && sudo apt-get install -y git
fi
echo "✅ Git $(git --version | cut -d' ' -f3) gefunden"

# 4. VS Code prüfen
if ! command -v code &> /dev/null; then
    echo "⚠️  VS Code CLI 'code' nicht gefunden."
    echo "   Bitte installieren Sie VS Code von https://code.visualstudio.com/"
    echo "   und aktivieren Sie die CLI mit 'Shell Command: Install code in PATH'"
fi

# 5. Dependencies installieren
echo ""
echo "📦 Installiere Dependencies..."
npm install

# 6. Extension bauen
echo ""
echo "🔨 Baue Extension..."
npm run build

# 7. VSIX paketieren
echo ""
echo "📦 Paketiere Extension..."
npm run package

# 8. Docker-Container starten
echo ""
echo "🐳 Starte Docker-Container..."
if command -v docker &> /dev/null; then
  cd "$SCRIPT_DIR"
  if docker compose ps 2>/dev/null | grep -q "zero-token-tts"; then
    echo "✅ Docker-Container läuft bereits"
  else
    echo "⬆️  Starte zero-token-tts Container..."
    docker compose up -d --build
    echo -n "⏳ Warte auf Health-Check"
    for i in $(seq 1 30); do
      sleep 2
      STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:18765/health 2>/dev/null || echo "0")
      if [ "$STATUS" = "200" ]; then
        echo ""
        echo "✅ Docker-Container ist bereit (Port 18765)"
        break
      fi
      echo -n "."
      if [ "$i" = "30" ]; then
        echo ""
        echo "⚠️  Container startet noch — bitte warten und erneut prüfen:"
        echo "   docker logs zero-token-tts"
      fi
    done
  fi
else
  echo "⚠️  Docker nicht gefunden. Container nicht gestartet."
  echo "   Installiere Docker: https://docs.docker.com/get-docker/"
fi

# 9. MCP-Server in VS Code eintragen
deploy_mcp() {
  local TARGET="$1"
  local MCP_JSON
  MCP_JSON='{"servers":{"zero-token-tts":{"type":"sse","url":"http://localhost:18764/sse"}}}'

  mkdir -p "$(dirname "$TARGET")"
  if [ -f "$TARGET" ]; then
    # Merge: füge tts-Server hinzu ohne bestehende Einträge zu löschen
    python3 - "$TARGET" "$MCP_JSON" <<'PYEOF'
import sys, json
target, new_entry = sys.argv[1], json.loads(sys.argv[2])
try:
    with open(target) as f:
        data = json.load(f)
except Exception:
    data = {}
data.setdefault("servers", {}).update(new_entry["servers"])
with open(target, "w") as f:
    json.dump(data, f, indent=2)
print(f"  ✅ MCP aktualisiert: {target}")
PYEOF
  else
    echo "$MCP_JSON" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin),indent=2))" > "$TARGET"
    echo "  ✅ MCP erstellt: $TARGET"
  fi
}

echo ""
echo "🔌 Trage MCP-Server ein..."

# Workspace .vscode/mcp.json
deploy_mcp "$SCRIPT_DIR/.vscode/mcp.json"

# Globale VS Code User-Settings
VSCODE_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Code/User"
[ ! -d "$VSCODE_USER_DIR" ] && VSCODE_USER_DIR="$HOME/.vscode-remote/data/User"
if [ -d "$VSCODE_USER_DIR" ]; then
  deploy_mcp "$VSCODE_USER_DIR/mcp.json"
fi

# 10. TTS-Skill zu Agents deployen
deploy_skill() {
  local DEST="$1"
  mkdir -p "$(dirname "$DEST")"
  cp "$SCRIPT_DIR/skills/tts-de/SKILL.md" "$DEST"
  echo "  ✅ Skill deployed: $DEST"
}

echo ""
echo "🤖 Deploye TTS-Skill zu Agents..."

# Workspace Copilot Instructions
deploy_skill "$SCRIPT_DIR/.github/copilot-instructions.md"

# VS Code .instructions.md
deploy_skill "$SCRIPT_DIR/.vscode/tts-de.instructions.md"

# 11. Extension installieren (falls code CLI verfügbar)
echo ""
VSIX_FILE=$(ls "$SCRIPT_DIR"/zero-token-explotion-*.vsix "$SCRIPT_DIR"/zero-token-tts-*.vsix 2>/dev/null | tail -1)
if [ -n "$VSIX_FILE" ] && command -v code &> /dev/null; then
  echo "📥 Installiere Extension..."
  code --install-extension "$VSIX_FILE" --force
  echo "✅ Extension installiert: $(basename "$VSIX_FILE")"
else
  echo "📋 Extension manuell installieren:"
  echo "   code --install-extension $(ls "$SCRIPT_DIR"/*.vsix 2>/dev/null | tail -1 | xargs basename 2>/dev/null || echo 'zero-token-tts-*.vsix')"
fi

# 12. Fertig
echo ""
echo "========================================"
echo "✅ Setup abgeschlossen!"
echo ""
echo "Was wurde eingerichtet:"
echo "  🐳 Docker-Container: docker compose up -d"
echo "  🔌 MCP-Server:       .vscode/mcp.json + User/mcp.json"
echo "  🤖 TTS-Skill:        .github/copilot-instructions.md"
echo "  📦 Extension:        $(ls "$SCRIPT_DIR"/*.vsix 2>/dev/null | tail -1 | xargs basename 2>/dev/null || echo 'nicht gefunden')"
echo ""
echo "VS Code neu laden (Ctrl+Shift+P → 'Developer: Reload Window')"
