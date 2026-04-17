/**
 * api-client.js — LyricSync
 * Cliente HTTP para consumir la API local FastAPI.
 *
 * Modo híbrido: intenta la API primero, si no está corriendo hace fallback
 * al spawn directo de Python.
 *
 * Uso:
 *   const { LyricSyncAPI } = require("./api-client");
 *   const api = new LyricSyncAPI();
 *   if (await api.isRunning()) { ... }
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { createLogger } = require("./logger");

const log = createLogger("api-client");

class LyricSyncAPI {
  constructor(host = "127.0.0.1", port = 8642) {
    this.host = host;
    this.port = port;

    // Leer config si existe
    try {
      const configPath = path.join(__dirname, "..", "config.yaml");
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, "utf-8");
        const hostMatch = content.match(/^\s*host:\s*"?([^"\n]+)"?/m);
        const portMatch = content.match(/^\s*port:\s*(\d+)/m);
        if (hostMatch) this.host = hostMatch[1].trim();
        if (portMatch) this.port = parseInt(portMatch[1]);
      }
    } catch {}
  }

  /**
   * Hace una petición HTTP a la API local.
   * @returns {Promise<object>} - Respuesta JSON parseada
   */
  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: { "Content-Type": "application/json" },
        timeout: 5000,
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON: ${data}`));
          }
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout"));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Verifica si la API está corriendo.
   */
  async isRunning() {
    try {
      const res = await this._request("GET", "/health");
      return res.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Inicia transcripción async. Retorna task_id.
   */
  async transcribe(audioPath, model = "small", language = "es") {
    return this._request("POST", "/transcribe", {
      audio_path: audioPath,
      model,
      language,
    });
  }

  /**
   * Inicia forced alignment async. Retorna task_id.
   */
  async align(audioPath, lyricsText, model = "base", language = "es") {
    return this._request("POST", "/align", {
      audio_path: audioPath,
      lyrics_text: lyricsText,
      model,
      language,
    });
  }

  /**
   * Post-procesa un .lrc (sincrónico).
   */
  async postprocess(lrcPath, threshold = 85) {
    return this._request("POST", "/postprocess", {
      lrc_path: lrcPath,
      threshold,
    });
  }

  /**
   * Consulta el estado de una tarea.
   */
  async getStatus(taskId) {
    return this._request("GET", `/status/${taskId}`);
  }

  /**
   * Polling de estado con timeout.
   * @param {string} taskId
   * @param {function} onProgress - callback(status, progress)
   * @param {number} intervalMs - intervalo de polling
   * @param {number} timeoutMs - timeout total
   */
  async waitForCompletion(taskId, onProgress = null, intervalMs = 2000, timeoutMs = 1800000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const status = await this.getStatus(taskId);

        if (onProgress) onProgress(status.status, status.progress);

        if (status.status === "done") return status;
        if (status.status === "error") throw new Error(status.error || "Task failed");
      } catch (err) {
        if (err.message !== "Timeout") throw err;
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error("Timeout waiting for task completion");
  }
}

module.exports = { LyricSyncAPI };
