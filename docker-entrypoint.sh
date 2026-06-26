#!/bin/sh
# Zero-Token TTS — Docker Entrypoint
# Downloads Piper binary and default Eva model on first run if not present.

ASSETS_DIR="${TTS_ASSETS_DIR:-/app/tts-server}"
mkdir -p "$ASSETS_DIR"

# ── Piper binary ──────────────────────────────────────────────────────────────
if [ ! -f "$ASSETS_DIR/piper" ]; then
  echo "[entrypoint] Piper binary nicht gefunden – wird heruntergeladen..."
  ARCH="$(uname -m)"
  case "$ARCH" in
    aarch64) PIPER_ARCHIVE="piper_linux_aarch64.tar.gz" ;;
    *)       PIPER_ARCHIVE="piper_linux_x86_64.tar.gz" ;;
  esac
  PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/${PIPER_ARCHIVE}"

  TMP_DIR="$(mktemp -d)"
  curl -sSfL "$PIPER_URL" | tar -xz -C "$TMP_DIR"
  # Alle Dateien aus dem Piper-Archiv kopieren (Binary + alle .so-Bibliotheken)
  cp -r "$TMP_DIR/piper/." "$ASSETS_DIR/"
  chmod +x "$ASSETS_DIR/piper"

  rm -rf "$TMP_DIR"
  echo "[entrypoint] Piper installiert: $ASSETS_DIR/piper"
fi

# ── Default voice model (Eva, Deutsch) ───────────────────────────────────────
if [ ! -f "$ASSETS_DIR/de_DE-eva_k-x_low.onnx" ]; then
  echo "[entrypoint] Eva-Modell nicht gefunden – wird heruntergeladen (~20 MB)..."
  BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/eva_k/x_low"
  curl -sSfL "${BASE_URL}/de_DE-eva_k-x_low.onnx"      -o "$ASSETS_DIR/de_DE-eva_k-x_low.onnx"
  curl -sSfL "${BASE_URL}/de_DE-eva_k-x_low.onnx.json"  -o "$ASSETS_DIR/de_DE-eva_k-x_low.onnx.json"
  echo "[entrypoint] Eva-Modell installiert"
fi

echo "[entrypoint] Starte Server..."
exec "$@"
