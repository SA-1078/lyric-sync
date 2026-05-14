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
  let offsetSeconds = 0;

  for (const line of lines) {
    // Metadata: [ti:Song Title]
    const metaMatch = line.match(/\[ti:(.*?)\]/);
    if (metaMatch) {
      songTitle = metaMatch[1].trim();
      continue;
    }

    // Offset LRC estandar en milisegundos: [offset:+/-NNN]
    const offsetMatch = line.match(/\[offset:([+-]?\d+)\]/i);
    if (offsetMatch) {
      offsetSeconds = parseInt(offsetMatch[1], 10) / 1000;
      continue;
    }

    // Timestamp(s): [mm:ss.cc] text o [mm:ss.xxx] text
    // Soporta multiples marcas en una misma linea: [00:10.00][00:20.00]Coro
    const timeMatches = [...line.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\]/g)];
    if (timeMatches.length === 0) continue;

    const text = line.replace(/\[(\d+):(\d+)(?:\.(\d+))?\]/g, "").trim();
    if (!text) continue;

    for (const timeMatch of timeMatches) {
      const minutes = parseInt(timeMatch[1], 10);
      const seconds = parseInt(timeMatch[2], 10);
      const fraction = timeMatch[3] ? parseFloat(`0.${timeMatch[3]}`) : 0;
      lyrics.push({
        time: Math.max(0, minutes * 60 + seconds + fraction + offsetSeconds),
        text,
      });
    }
  }

  lyrics.sort((a, b) => a.time - b.time);

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
