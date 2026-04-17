/**
 * logger.js — LyricSync
 * Sistema de logging profesional con niveles y salida a archivo.
 *
 * Uso:
 *   const { createLogger } = require("./logger");
 *   const log = createLogger("player");
 *   log.info("Reproducción iniciada");
 *   log.warn("Volumen muy alto");
 *   log.error("FFplay no encontrado");
 */

const fs = require("fs");
const path = require("path");

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

class Logger {
  /**
   * @param {string} name - Nombre del módulo (ej: "player", "audio", "config")
   * @param {object} opts - Opciones
   * @param {string} opts.level - Nivel mínimo: DEBUG, INFO, WARN, ERROR
   * @param {boolean} opts.toFile - Guardar en archivo
   * @param {string} opts.logDir - Carpeta de logs
   */
  constructor(name, { level = "INFO", toFile = true, logDir = "logs" } = {}) {
    this.name = name;
    this.level = LEVELS[level] || LEVELS.INFO;
    this.toFile = toFile;
    this.logDir = path.join(__dirname, "..", logDir);

    if (toFile) {
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
      } catch {}
    }
  }

  _log(level, msg) {
    if (LEVELS[level] < this.level) return;

    const now = new Date();
    const ts = now.toISOString().replace("T", " ").slice(0, 19);
    const line = `${ts} │ ${level.padEnd(5)} │ ${this.name} │ ${msg}`;

    // File output (siempre completo)
    if (this.toFile) {
      try {
        const dateStr = now.toISOString().slice(0, 10);
        const file = path.join(this.logDir, `${dateStr}.log`);
        fs.appendFileSync(file, line + "\n", "utf-8");
      } catch {}
    }

    // Console output (NO imprimir en console para no interferir con TUI)
    // Solo imprimir errores críticos que sí necesitan atención inmediata
    if (level === "ERROR") {
      try {
        process.stderr.write(line + "\n");
      } catch {}
    }
  }

  debug(msg) { this._log("DEBUG", msg); }
  info(msg)  { this._log("INFO", msg); }
  warn(msg)  { this._log("WARN", msg); }
  error(msg) { this._log("ERROR", msg); }
}

// Cache de loggers
const _loggers = {};

/**
 * Crea o retorna un logger para el módulo dado.
 * Lee configuración de config.yaml si está disponible.
 */
function createLogger(name) {
  if (_loggers[name]) return _loggers[name];

  let opts = { level: "INFO", toFile: true, logDir: "logs" };

  try {
    const configPath = path.join(__dirname, "..", "config.yaml");
    if (fs.existsSync(configPath)) {
      // Leer YAML con regex simple (evita dependencia js-yaml para el logger)
      const content = fs.readFileSync(configPath, "utf-8");
      const levelMatch = content.match(/^\s*level:\s*"?(\w+)"?/m);
      const toFileMatch = content.match(/^\s*to_file:\s*(true|false)/m);
      const logDirMatch = content.match(/^\s*log_dir:\s*"?([^"\n]+)"?/m);

      if (levelMatch) opts.level = levelMatch[1];
      if (toFileMatch) opts.toFile = toFileMatch[1] === "true";
      if (logDirMatch) opts.logDir = logDirMatch[1].trim();
    }
  } catch {}

  _loggers[name] = new Logger(name, opts);
  return _loggers[name];
}

module.exports = { Logger, createLogger };
