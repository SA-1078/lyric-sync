/**
 * spectrum-renderer.js — Renderizado ASCII del espectro arcoíris
 *
 * Dibuja barras verticales con gradiente RGB continuo usando chalk.rgb().
 * Soporta: simetría, indicadores de pico, efectos de beat, letras LRC.
 *
 * Técnica de render: ANSI cursor control (sin console.clear).
 * Escribe todo el frame como un único string y hace flush atómico.
 */

const chalk = require("chalk");
const { formatTime } = require("../lrc-parser");
const cfg = require("./config");
const os = require("os");

// ─── Geometry Cache (mismo sistema que renderer.js) ────────────────────
const isWindows = os.platform() === "win32";
let fixedWidth = null;
let fixedHeight = null;

function getTerminalSize() {
  let w = process.stdout.columns || 110;
  let h = process.stdout.rows || 30;

  if (isWindows) {
    if (!fixedWidth || w < fixedWidth - 5 || w > fixedWidth + 5) fixedWidth = w;
    if (!fixedHeight || h < fixedHeight - 3 || h > fixedHeight + 3) fixedHeight = h;
    return { width: fixedWidth, height: fixedHeight };
  }
  return { width: w, height: h };
}

// ─── Gradient System ───────────────────────────────────────────────────

/**
 * Genera una tabla de colores RGB para N filas (de abajo=0 hacia arriba=N-1).
 * Interpola linealmente entre los GRADIENT_STOPS.
 */
function buildGradientTable(numRows, colorShift = 0) {
  const stops = cfg.GRADIENT_STOPS;
  const numStops = stops.length;
  const table = [];

  for (let row = 0; row < numRows; row++) {
    // t va de 0 (base) a 1 (cima)
    const t = numRows > 1 ? row / (numRows - 1) : 0;

    // Aplicar color shift (rotación del gradiente por beats)
    const shiftedT = (t + colorShift / numStops) % 1;

    // Encontrar los dos stops entre los que interpolamos
    const scaledIdx = shiftedT * (numStops - 1);
    const idx = Math.floor(scaledIdx);
    const frac = scaledIdx - idx;

    const c1 = stops[Math.min(idx, numStops - 1)];
    const c2 = stops[Math.min(idx + 1, numStops - 1)];

    table.push({
      r: Math.round(c1.r + (c2.r - c1.r) * frac),
      g: Math.round(c1.g + (c2.g - c1.g) * frac),
      b: Math.round(c1.b + (c2.b - c1.b) * frac),
    });
  }

  return table;
}

// ─── Renderer State ────────────────────────────────────────────────────
let previousLineCount = 0;
let initialized = false;
let lastLayoutWidth = -1;
let lastLayoutHeight = -1;

function resetSpectrumRenderer() {
  initialized = false;
  previousLineCount = 0;
  lastLayoutWidth = -1;
  lastLayoutHeight = -1;
  fixedWidth = null;
  fixedHeight = null;
}

function truncate(str, max) {
  return str.length > max ? str.substring(0, max - 1) + "…" : str;
}

function getCurrentLineIdx(lyrics, elapsed) {
  let low = 0;
  let high = lyrics.length - 1;
  let idx = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (elapsed >= lyrics[mid].time) {
      idx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return idx;
}

/**
 * Renderiza un frame completo del visualizador.
 *
 * @param {object} state — Estado del reproductor
 * @param {Array<number>} state.bands — Alturas normalizadas [0..1]
 * @param {Array<number>} state.peaks — Alturas de pico [0..1]
 * @param {number} state.numBands — Número de bandas
 * @param {object} state.beat — Estado del beat detector
 * @param {number} state.elapsed — Tiempo transcurrido (s)
 * @param {Array} state.lyrics — Array de {time, text}
 * @param {string} state.songTitle — Título
 * @param {number} state.totalDuration — Duración total (s)
 * @param {boolean} state.playing — Si está reproduciendo
 * @param {boolean} state.finished — Si terminó
 * @param {number} state.volume — Volumen actual
 */
function renderSpectrum(state) {
  const {
    bands = [],
    peaks = [],
    numBands = 0,
    beat = {},
    elapsed = 0,
    lyrics = [],
    songTitle = "LyricSync Visualizer",
    totalDuration = 0,
    playing = false,
    finished = false,
    volume = 100,
  } = state;

  const lineIdx = getCurrentLineIdx(lyrics, elapsed);
  const { width: termWidth, height: termHeight } = getTerminalSize();

  // Detección de resize
  if (lastLayoutWidth !== -1 && (termWidth !== lastLayoutWidth || termHeight !== lastLayoutHeight)) {
    initialized = false;
    previousLineCount = 0;
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  }
  lastLayoutWidth = termWidth;
  lastLayoutHeight = termHeight;

  const innerWidth = Math.max(60, Math.min(termWidth - 6, 140));
  // Reservar espacio para: header(4) + baseline(2) + progreso(2) + letras(9) + controles(3) = 20
  const maxHeight = Math.min(cfg.MAX_HEIGHT, Math.max(6, termHeight - 20));

  // Altura fija — NO variar entre frames para evitar glitches ANSI
  const effectiveHeight = maxHeight;

  // ─── Construir gradiente para este frame ───────────────────
  const gradient = buildGradientTable(effectiveHeight, beat.colorShift || 0);

  // ─── Construir barras del espectro ─────────────────────────
  // Convertir alturas normalizadas [0..1] → filas [0..effectiveHeight]
  const barHeights = bands.map((v) => Math.round(v * effectiveHeight));
  const peakHeights = peaks.map((v) => Math.round(v * effectiveHeight));

  // Aplicar simetría si está habilitada
  let displayBars = barHeights;
  let displayPeaks = peakHeights;
  if (cfg.SYMMETRIC && barHeights.length > 0) {
    const reversed = [...barHeights].reverse();
    displayBars = [...reversed, ...barHeights];
    const reversedPeaks = [...peakHeights].reverse();
    displayPeaks = [...reversedPeaks, ...peakHeights];
  }

  // Centrar el espectro en la terminal
  const spectrumWidth = displayBars.length;
  const padLeft = Math.max(0, Math.floor((termWidth - spectrumWidth) / 2));
  const padding = " ".repeat(padLeft);

  const lines = [];

  // ─── Header ────────────────────────────────────────────────
  const headerPad = Math.max(0, Math.floor((termWidth - innerWidth - 4) / 2));
  const hp = " ".repeat(headerPad);
  lines.push(hp + chalk.cyan("╔" + "═".repeat(innerWidth) + "╗"));
  lines.push(hp + chalk.cyan("║") + chalk.bold.white(`  🎵 ${truncate(songTitle, innerWidth - 6).padEnd(innerWidth - 3)}`) + chalk.cyan("║"));
  lines.push(hp + chalk.cyan("╚" + "═".repeat(innerWidth) + "╝"));
  lines.push("");

  // ─── Espectro (dibujado de arriba hacia abajo) ─────────────
  for (let row = effectiveHeight - 1; row >= 0; row--) {
    let rowStr = padding;
    const color = gradient[row];

    for (let col = 0; col < spectrumWidth; col++) {
      const height = displayBars[col];
      const peak = displayPeaks[col];

      if (row < height) {
        // Barra sólida
        if (beat.bassBeat && row < 3) {
          // Pulso de bass: iluminar el color existente (no blanco puro)
          const br = Math.min(255, color.r + 80);
          const bg = Math.min(255, color.g + 80);
          const bb = Math.min(255, color.b + 80);
          rowStr += chalk.rgb(br, bg, bb)(cfg.BAR_CHARS.FULL);
        } else {
          rowStr += chalk.rgb(color.r, color.g, color.b)(cfg.BAR_CHARS.FULL);
        }
      } else if (row === Math.max(0, peak - 1)) {
        // Indicador de pico
        rowStr += chalk.rgb(color.r, color.g, color.b)(cfg.BAR_CHARS.PEAK);
      } else {
        rowStr += " ";
      }
    }

    lines.push(rowStr);
  }

  // ─── Línea base del espectro ───────────────────────────────
  const baseLine = padding + chalk.gray("▁".repeat(spectrumWidth));
  lines.push(baseLine);
  lines.push("");

  // ─── Barra de progreso ─────────────────────────────────────
  const timeInfoLength = 22;
  const barWidth = Math.max(10, innerWidth - timeInfoLength);
  const progress = Math.min(elapsed / (totalDuration || 1), 1);
  const filled = Math.round(progress * barWidth);
  const empty = barWidth - filled;
  const bar = chalk.cyan("█".repeat(filled)) + chalk.gray("░".repeat(empty));
  const statusIcon = finished ? "⏹" : playing ? "▶" : "⏸";
  const statusColor = finished ? chalk.gray : playing ? chalk.green : chalk.yellow;

  lines.push(`  ${statusColor(statusIcon)}  ${bar}  ${chalk.yellow(formatTime(elapsed))} / ${chalk.gray(formatTime(totalDuration))}`);
  lines.push("");

  // ─── Letras ────────────────────────────────────────────────
  const volStr = `[Vol: ${String(volume).padStart(3)}%]`;
  const dashesCount = innerWidth + 2 - 12 - volStr.length - 1;
  lines.push(chalk.cyan("  ── Letras " + "─".repeat(Math.max(0, dashesCount)) + " ") + chalk.cyan.dim(volStr));
  lines.push("");

  // 5 slots fijos para letras
  const lyricSlots = ["", "", "", "", ""];
  if (lineIdx >= 0) {
    if (lineIdx > 1)
      lyricSlots[0] = chalk.gray.dim(`      ${truncate(lyrics[lineIdx - 2].text, innerWidth - 8)}`);
    if (lineIdx > 0)
      lyricSlots[1] = chalk.gray(`      ${truncate(lyrics[lineIdx - 1].text, innerWidth - 8)}`);

    const lyricColors = [chalk.bold.white, chalk.bold.cyan, chalk.bold.yellow, chalk.bold.magenta];
    lyricSlots[2] = lyricColors[lineIdx % lyricColors.length](`  ♪   ${lyrics[lineIdx].text}`);

    if (lineIdx < lyrics.length - 1)
      lyricSlots[3] = chalk.gray(`      ${truncate(lyrics[lineIdx + 1].text, innerWidth - 8)}`);
    if (lineIdx < lyrics.length - 2)
      lyricSlots[4] = chalk.gray.dim(`      ${truncate(lyrics[lineIdx + 2].text, innerWidth - 8)}`);
  } else {
    lyricSlots[2] = chalk.gray.italic(`  ♪   Esperando que comience la letra...`);
  }
  for (const slot of lyricSlots) lines.push(slot);

  lines.push("");
  lines.push(chalk.cyan("  " + "─".repeat(innerWidth + 2)));

  // ─── Controles ─────────────────────────────────────────────
  if (finished) {
    lines.push(chalk.bold.green("  ✅ ¡Canción terminada!"));
    lines.push(chalk.gray("     👉 Pulsa [Enter] o [Espacio] para volver al menú principal..."));
  } else {
    const footerStr = playing
      ? `[Espacio] Pausar   [← →] ±10 seg   [↑ ↓] Volumen   [Q/Esc] Salir`
      : `[Espacio] Reanudar   [← →] ±10 seg   [↑ ↓] Volumen   [Q/Esc] Salir`;
    lines.push(chalk.gray("  " + footerStr));
    lines.push("");
  }

  // ─── Rellenar hasta altura segura ──────────────────────────
  const maxSafeHeight = Math.max(5, termHeight - 1);
  if (lines.length > maxSafeHeight) {
    lines.length = maxSafeHeight;
  }

  // ─── Flush atómico ─────────────────────────────────────────
  let output = "";

  if (!initialized) {
    output += "\n".repeat(lines.length);
    output += `\x1b[${lines.length}A\x1b[1G`;
    initialized = true;
  } else if (previousLineCount > 0) {
    output += `\x1b[${previousLineCount}A\x1b[1G`;
  }

  for (const line of lines) {
    output += line + "\x1b[K\n";
  }

  output += "\x1b[J\r\x1b[1G";
  process.stdout.write(output);

  previousLineCount = lines.length;
  return lineIdx;
}

module.exports = { renderSpectrum, resetSpectrumRenderer, getCurrentLineIdx };
