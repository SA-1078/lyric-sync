/**
 * ffmpeg-resolver.js — LyricSync
 * Resuelve la ruta a ffplay/ffprobe/ffmpeg con fallback inteligente.
 *
 * Orden de búsqueda:
 *   1. Carpeta bin/ del proyecto (bundled)
 *   2. PATH del sistema
 *
 * Uso:
 *   const { resolveFFplay, resolveFFprobe, resolveFFmpeg } = require("./ffmpeg-resolver");
 *   const ffplay = resolveFFplay();  // retorna ruta o null
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { createLogger } = require("./logger");

const log = createLogger("ffmpeg");

/**
 * Resuelve la ruta a un ejecutable FFmpeg.
 * @param {string} binaryName - "ffplay", "ffprobe", o "ffmpeg"
 * @returns {string|null} - Ruta completa o nombre del binario si está en PATH, null si no se encontró
 */
function resolveFFBinary(binaryName) {
  const projectRoot = path.join(__dirname, "..");

  // 1. Buscar en bin/ del proyecto (bundled)
  const bundledDir = path.join(projectRoot, "bin");
  const exeName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  const bundledPath = path.join(bundledDir, exeName);

  if (fs.existsSync(bundledPath)) {
    log.info(`${binaryName} encontrado (bundled): ${bundledPath}`);
    return bundledPath;
  }

  // 2. Buscar en PATH del sistema
  try {
    const cmd = process.platform === "win32" ? `where ${binaryName}` : `which ${binaryName}`;
    const result = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (result) {
      const firstPath = result.split(/\r?\n/)[0].trim();
      log.info(`${binaryName} encontrado (sistema): ${firstPath}`);
      return binaryName; // usar nombre directo, ya está en PATH
    }
  } catch {}

  // 3. No encontrado
  log.warn(`${binaryName} NO encontrado (ni bundled ni en PATH)`);
  return null;
}

// Shortcuts específicos
function resolveFFplay()  { return resolveFFBinary("ffplay"); }
function resolveFFprobe() { return resolveFFBinary("ffprobe"); }
function resolveFFmpeg()  { return resolveFFBinary("ffmpeg"); }

/**
 * Verifica que FFmpeg esté disponible y retorna un reporte.
 * @returns {object} - { ffplay, ffprobe, ffmpeg, allAvailable }
 */
function checkFFmpegStatus() {
  const ffplay  = resolveFFplay();
  const ffprobe = resolveFFprobe();
  const ffmpeg  = resolveFFmpeg();

  return {
    ffplay,
    ffprobe,
    ffmpeg,
    allAvailable: !!(ffplay && ffprobe),
    playAvailable: !!ffplay,
    probeAvailable: !!ffprobe,
  };
}

module.exports = {
  resolveFFBinary,
  resolveFFplay,
  resolveFFprobe,
  resolveFFmpeg,
  checkFFmpegStatus,
};
