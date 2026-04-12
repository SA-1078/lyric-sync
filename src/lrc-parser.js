/**
 * lrc-parser.js — Parser de archivos .lrc
 * Extrae letras sincronizadas con timestamps.
 */

const fs = require("fs");

/**
 * Parsea un archivo .lrc y retorna las letras con timestamps.
 * @param {string} filePath - Ruta al archivo .lrc
 * @returns {{ lyrics: Array<{time: number, text: string}>, songTitle: string }}
 */
function parseLRC(filePath) {
  if (!fs.existsSync(filePath)) {
    return { lyrics: [], songTitle: "LyricSync Player" };
  }

  const data = fs.readFileSync(filePath, "utf-8");
  const lines = data.split("\n");
  const lyrics = [];
  let songTitle = "LyricSync Player";

  for (const line of lines) {
    // Metadata: [ti:Song Title]
    const metaMatch = line.match(/\[ti:(.*?)\]/);
    if (metaMatch) {
      songTitle = metaMatch[1].trim();
      continue;
    }

    // Timestamp: [mm:ss.cc] text
    const timeMatch = line.match(/\[(\d+):(\d+)(?:\.(\d+))?\](.*)/);
    if (!timeMatch) continue;

    const minutes      = parseInt(timeMatch[1]);
    const seconds      = parseInt(timeMatch[2]);
    const centiseconds = timeMatch[3] ? parseInt(timeMatch[3]) / 100 : 0;
    const text         = timeMatch[4].trim();

    if (text) {
      lyrics.push({
        time: minutes * 60 + seconds + centiseconds,
        text,
      });
    }
  }

  return { lyrics, songTitle };
}

/**
 * Formatea segundos como mm:ss
 */
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

module.exports = { parseLRC, formatTime };
