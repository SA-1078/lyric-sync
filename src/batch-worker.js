/**
 * batch-worker.js — LyricSync
 * Pool de workers para procesamiento batch en paralelo.
 *
 * Usa child_process (no worker_threads) porque cada tarea es un
 * proceso Python independiente con su propio uso de memoria.
 *
 * Uso:
 *   const { BatchProcessor } = require("./batch-worker");
 *   const batch = new BatchProcessor(2);
 *   batch.addTask({ audioPath, model, language });
 *   await batch.processAll(onProgress);
 */

const { spawn } = require("child_process");
const path = require("path");
const { createLogger } = require("./logger");

const log = createLogger("batch");

class BatchProcessor {
  /**
   * @param {number} maxWorkers - Número máximo de procesos paralelos (2-4 recomendado)
   * @param {object} systemEnv - Variables de entorno con PATH extendido
   */
  constructor(maxWorkers = 2, systemEnv = process.env) {
    this.maxWorkers = Math.max(1, Math.min(maxWorkers, 8)); // Limitar 1-8
    this.systemEnv = systemEnv;
    this.queue = [];
    this.results = [];
  }

  /**
   * Agrega una tarea a la cola.
   */
  addTask({ audioPath, outputPath, model = "small", language = "es" }) {
    this.queue.push({ audioPath, outputPath, model, language });
  }

  /**
   * Procesa todas las tareas en paralelo con hasta maxWorkers workers.
   *
   * @param {function} onProgress - callback(index, total, fileName, status, detail)
   *   status: "starting" | "running" | "done" | "error"
   * @returns {Promise<Array>} - Array de resultados {audioPath, success, error}
   */
  async processAll(onProgress = null) {
    const total = this.queue.length;
    if (total === 0) return [];

    log.info(`Batch iniciado: ${total} tareas, ${this.maxWorkers} workers paralelos`);

    const results = [];
    let nextIdx = 0;
    let completed = 0;

    return new Promise((resolve) => {
      const startNext = () => {
        while (nextIdx < total && getActiveCount() < this.maxWorkers) {
          const idx = nextIdx++;
          const task = this.queue[idx];
          const fileName = path.basename(task.audioPath, path.extname(task.audioPath));

          if (onProgress) onProgress(idx + 1, total, fileName, "starting", "");

          log.info(`[${idx + 1}/${total}] Iniciando: ${fileName}`);

          this._runSingleTask(task, (status, detail) => {
            if (onProgress) onProgress(idx + 1, total, fileName, status, detail);
          })
            .then(() => {
              results[idx] = { audioPath: task.audioPath, success: true };
              if (onProgress) onProgress(idx + 1, total, fileName, "done", "✅");
              log.info(`[${idx + 1}/${total}] Completado: ${fileName}`);
            })
            .catch((err) => {
              results[idx] = { audioPath: task.audioPath, success: false, error: err.message };
              if (onProgress) onProgress(idx + 1, total, fileName, "error", err.message);
              log.error(`[${idx + 1}/${total}] Error: ${fileName} — ${err.message}`);
            })
            .finally(() => {
              completed++;
              activeWorkers--;

              if (completed >= total) {
                resolve(results);
              } else {
                startNext(); // Lanzar siguiente worker disponible
              }
            });

          activeWorkers++;
        }
      };

      let activeWorkers = 0;
      const getActiveCount = () => activeWorkers;

      startNext();
    });
  }

  /**
   * Ejecuta una sola tarea de transcripción como proceso Python.
   */
  _runSingleTask(task, onProgressCallback = null) {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, "..", "whisper_transcribe.py");

      const args = [
        scriptPath,
        task.audioPath,
        "--output", task.outputPath || "",
        "--model", task.model,
        "--language", task.language,
      ].filter(Boolean);

      const proc = spawn("python", args, {
        stdio: "pipe",
        env: this.systemEnv,
      });

      let stderr = "";

      proc.stdout.on("data", (data) => {
        const text = data.toString();
        // Detectar si está descargando el modelo o transcribiendo por primera vez
        if (text.includes("descargará automáticamente")) {
          if (onProgressCallback) {
            onProgressCallback("downloading", "⏳ Descargando modelo (puede tomar unos minutos)...");
          }
          log.info(`[WORKER] Descargando modelo para: ${task.audioPath}`);
        }
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `Exit code: ${code}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Spawn error: ${err.message}`));
      });
    });
  }
}

module.exports = { BatchProcessor };
