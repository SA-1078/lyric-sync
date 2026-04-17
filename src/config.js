/**
 * config.js — Configuración compartida de LyricSync
 * Constantes, rutas, variables de entorno y utilidades comunes.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── Constantes ─────────────────────────────────────────────────────────────
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".wma", ".mp4", ".mkv", ".webm"];
const LRC_DIR = path.join(__dirname, "..", "lrc");
const DEFAULT_MUSIC_FOLDER = path.join(process.env.USERPROFILE || "C:\\Users\\Public", "Music");

// Asegurar que la carpeta lrc/ exista
if (!fs.existsSync(LRC_DIR)) fs.mkdirSync(LRC_DIR, { recursive: true });

// ─── PATH del sistema (para ffplay / ffmpeg) ────────────────────────────────
function getSystemPath() {
  try {
    const m = execSync(
      'powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\',\'Machine\')"',
      { encoding: "utf-8" }
    ).trim();
    const u = execSync(
      'powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\',\'User\')"',
      { encoding: "utf-8" }
    ).trim();
    return `${m};${u}`;
  } catch {
    return process.env.PATH;
  }
}

const SYSTEM_ENV = { 
  ...process.env, 
  PATH: getSystemPath(),
  PYTHONDONTWRITEBYTECODE: "1", // Evita que Python genere la carpeta __pycache__ y archivos .pyc
  PYTHONIOENCODING: "utf-8"     // Fuerza UTF-8 para evitar errores con caracteres especiales (especialmente en batch)
};

// ─── Utilidades ─────────────────────────────────────────────────────────────

function isAudioFile(file) {
  return AUDIO_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

function getLrcPath(audioPath) {
  const baseName = path.basename(audioPath, path.extname(audioPath));
  return path.join(LRC_DIR, baseName + ".lrc");
}

function hasLrc(audioPath) {
  return fs.existsSync(getLrcPath(audioPath));
}

function formatFileName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function truncate(str, max = 55) {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function scanFolder(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && isAudioFile(e.name))
      .map((e) => path.join(folderPath, e.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  } catch {
    return [];
  }
}

module.exports = {
  AUDIO_EXTENSIONS,
  LRC_DIR,
  DEFAULT_MUSIC_FOLDER,
  SYSTEM_ENV,
  isAudioFile,
  getLrcPath,
  hasLrc,
  formatFileName,
  truncate,
  scanFolder,
};
