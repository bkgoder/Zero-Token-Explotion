// ══════════════════════════════════════════════════════════════════════════════
// TTS Engine — HTTP-Client für LlamaEdge TTS-API-Server (Piper/ONNX via WasmEdge)
// Port 18765 | OpenAI-kompatibel: POST /v1/audio/speech
// ══════════════════════════════════════════════════════════════════════════════
import { request } from "http";
import { createHash } from "crypto";
import { getTtsCache, setTtsCache } from "./database";

export type TtsVoice = "eva";

const DEFAULT_TTS_API_PORT = 18765;

// ══════════════════════════════════════════════════════════════════════════════

/** TTS-Ausgabe mit Cache – ruft LlamaEdge TTS-API-Server auf */
export async function speak(
  text: string,
  _voice?: TtsVoice,
  _lang?: string,
  apiPort?: number
): Promise<Buffer> {
  const textHash = createHash("sha256").update(text).digest("hex").slice(0, 16);

  // Cache prüfen
  try {
    const cached = getTtsCache(textHash);
    if (cached) return cached;
  } catch {}

  // LlamaEdge TTS-API aufrufen
  const audioData = await callTtsApi(text, apiPort || DEFAULT_TTS_API_PORT);

  // Cache speichern (nicht-blocking)
  try {
    setTtsCache(textHash, audioData, "llamaedge", "eva");
  } catch {}

  return audioData;
}

// ══════════════════════════════════════════════════════════════════════════════
// LlamaEdge TTS-API (OpenAI-kompatibel)
// ══════════════════════════════════════════════════════════════════════════════

async function callTtsApi(text: string, apiPort = 18765): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "piper",
      input: text,
      voice: "alloy",       // wird ignoriert – das geladene Eva-Modell wird verwendet
      response_format: "wav",
      speed: 1.0,
    });

    const url = new URL(`http://localhost:${apiPort}/v1/audio/speech`);
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode === 200) {
            resolve(buf);
          } else {
            const msg = buf.toString("utf-8").slice(0, 200);
            reject(new Error(`TTS API ${res.statusCode}: ${msg}`));
          }
        });
      }
    );

    req.on("error", (e) => reject(new Error(`TTS-Verbindung fehlgeschlagen: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("TTS-API-Timeot (30s)")); });

    req.write(body);
    req.end();
  });
}
