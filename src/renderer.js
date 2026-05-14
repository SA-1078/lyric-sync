/**
 * renderer.js — Renderizado del reproductor en terminal
 * Dibuja la interfaz del reproductor sobreescribiendo líneas (sin parpadeo).
 */

const chalk = require("chalk");
const { formatTime } = require("./lrc-parser");
const os = require('os');

// ─── SAFE MODE GEOMETRÍA ─────────────────────────────────────
const isWindows = os.platform() === 'win32';
const isCmd = !process.env.WT_SESSION && !process.env.TERM_PROGRAM;

const isVSCode = 
  process.env.TERM_PROGRAM === 'vscode' ||
  process.env.VSCODE_PID !== undefined ||
  process.env.VSCODE_INJECTION === '1';

const FORCE_SAFE_MODE = process.env.SAFE_MODE === 'true' || isWindows;
const SAFE_MODE = FORCE_SAFE_MODE || isVSCode || isCmd;

let fixedWidth = null;
let fixedHeight = null;

function getTerminalSize() {
  let w = process.stdout.columns || 110;
  let h = process.stdout.rows || 30;

  if (SAFE_MODE) {
    // En SAFE_MODE (especialmente Windows CMD) usamos tamaño "fijo" pero lo actualizamos siempre
    if (!fixedWidth || w < fixedWidth - 5 || w > fixedWidth + 5) {  // tolerancia de 5 columnas
      fixedWidth = w;
    }
    if (!fixedHeight || h < fixedHeight - 3 || h > fixedHeight + 3) {
      fixedHeight = h;
    }
    return { width: fixedWidth, height: fixedHeight };
  }

  return { width: w, height: h };
}

let previousLineCount = 0;
let initialized = false;
let lastLayoutWidth = -1;
let lastLayoutHeight = -1;

/**
 * Trunca un string a un máximo de caracteres.
 */
function truncate(str, max) {
  return str.length > max ? str.substring(0, max - 1) + "…" : str;
}

/**
 * Encuentra el índice de la línea de letras activa según el tiempo transcurrido.
 */
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
 * Renderiza el reproductor completo en la terminal.
 * Usa \x1b[H para mover el cursor al inicio y sobreescribir (sin console.clear).
 *
 * @param {object} state - Estado actual del reproductor
 * @param {number} state.elapsed       - Tiempo transcurrido en segundos
 * @param {Array}  state.lyrics        - Array de {time, text}
 * @param {string} state.songTitle     - Título de la canción
 * @param {number} state.totalDuration - Duración total en segundos
 * @param {boolean} state.playing      - Si está reproduciendo
 * @param {boolean} state.finished     - Si la canción terminó
 * @returns {number} Índice de la línea actual de letras
 */
function render(state) {
  const { elapsed, lyrics, songTitle, totalDuration, playing, finished, volume } = state;

  const lineIdx = getCurrentLineIdx(lyrics, elapsed);

  // Detección dinámica o fija según el SAFE_MODE
  const { width: termWidth, height: termHeight } = getTerminalSize();

  // Detección inline de reflow + resize (Cura fuerte para Windows CMD)
  if (lastLayoutWidth !== -1 && (termWidth !== lastLayoutWidth || termHeight !== lastLayoutHeight)) {
    initialized = false;
    previousLineCount = 0; // ← importante

    // Siempre limpiamos fuerte cuando hay resize/reflow real
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); 
  }
  lastLayoutWidth = termWidth;
  lastLayoutHeight = termHeight;

  const innerWidth = Math.max(60, Math.min(termWidth - 6, 140));

  // Barra de progreso adaptativa
  const timeInfoLength = 22; // Espacio que ocupan los relojes y los íconos laterales
  const barWidth = innerWidth - timeInfoLength;
  const progress = Math.min(elapsed / (totalDuration || 1), 1);
  const filled   = Math.round(progress * barWidth);
  const empty    = barWidth - filled;
  const bar      = chalk.cyan("█".repeat(filled)) + chalk.gray("░".repeat(empty));
  const statusIcon  = finished ? "⏹" : playing ? "▶" : "⏸";
  const statusColor = finished ? chalk.gray : playing ? chalk.green : chalk.yellow;

  const TOTAL_LINES = termHeight >= 32 ? 30 : 20; // Si hay altura, dar 30 líneas para logo. Si no, 20.
  const lines = [];

  // ─── Centrar e Inyectar Logo Principal (Si hay Pantalla Suficiente) ───
  if (termHeight >= 32) {
    const logoBoxWidth = 76;
    const paddingLeft = Math.max(0, Math.floor((termWidth - logoBoxWidth) / 2));
    const p = " ".repeat(paddingLeft);

    lines.push(p + chalk.magenta("    ██╗  ██╗   ██╗██████╗ ██╗ ██████╗███████╗██╗   ██╗███╗   ██╗ ██████╗"));
    lines.push(p + chalk.magenta("    ██║  ╚██╗ ██╔╝██╔══██╗██║██╔════╝██╔════╝╚██╗ ██╔╝████╗  ██║██╔════╝"));
    lines.push(p + chalk.cyan("    ██║   ╚████╔╝ ██████╔╝██║██║     ███████╗ ╚████╔╝ ██╔██╗ ██║██║     "));
    lines.push(p + chalk.cyan("    ██║    ╚██╔╝  ██╔══██╗██║██║     ╚════██║  ╚██╔╝  ██║╚██╗██║██║     "));
    lines.push(p + chalk.blue("    ███████╗██║   ██║  ██║██║╚██████╗███████║   ██║   ██║ ╚████║╚██████╗"));
    lines.push(p + chalk.blue("    ╚══════╝╚═╝   ╚═╝  ╚═╝╚═╝ ╚═════╝╚══════╝   ╚═╝   ╚═╝  ╚═══╝ ╚═════╝"));
    lines.push("");
    lines.push(p + chalk.gray("         ✦  Inteligencia Artificial Offline — Modo Terminal v1.0  ✦"));
    lines.push("");
  }

  // ─── Header Adaptativo ─────────────────────────────────────
  lines.push(chalk.cyan("  ╔" + "═".repeat(innerWidth) + "╗"));
  lines.push(chalk.cyan("  ║") + chalk.bold.white(`  🎵 ${truncate(songTitle, innerWidth - 6).padEnd(innerWidth - 5)}`) + chalk.cyan("║"));
  lines.push(chalk.cyan("  ╚" + "═".repeat(innerWidth) + "╝"));
  lines.push("");

  // ─── Barra de progreso ─────────────────────────────────────
  lines.push(`  ${statusColor(statusIcon)}  ${bar}  ${chalk.yellow(formatTime(elapsed))} / ${chalk.gray(formatTime(totalDuration))}`);
  lines.push("");

  // ─── Letras ────────────────────────────────────────────────
  const volStr = `[Vol: ${String(volume).padStart(3)}%]`;
  const dashesCount = innerWidth + 2 - 12 - volStr.length - 1; 
  lines.push(chalk.cyan("  ── Letras " + "─".repeat(Math.max(0, dashesCount)) + " ") + chalk.cyan.dim(volStr));
  lines.push("");

  // 5 slots fijos para letras (mantiene altura constante)
  const lyricSlots = ["", "", "", "", ""];
  if (lineIdx >= 0) {
    if (lineIdx > 1)
      lyricSlots[0] = chalk.gray.dim(`      ${truncate(lyrics[lineIdx - 2].text, innerWidth - 8)}`);
    if (lineIdx > 0)
      lyricSlots[1] = chalk.gray(`      ${truncate(lyrics[lineIdx - 1].text, innerWidth - 8)}`);

    const colors = [chalk.bold.white, chalk.bold.cyan, chalk.bold.yellow, chalk.bold.magenta];
    lyricSlots[2] = colors[lineIdx % colors.length](`  ♪   ${lyrics[lineIdx].text}`);

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
    lines.push(chalk.cyan("  " + "─".repeat(innerWidth + 2)));
  } else {
    const footerStr = playing 
      ? `[Espacio] Pausar   [← →] ±10 seg   [↑ ↓] Volumen   [Q/Esc] Salir`
      : `[Espacio] Reanudar   [← →] ±10 seg   [↑ ↓] Volumen   [Q/Esc] Salir`;
    lines.push(chalk.gray("  " + footerStr));
    lines.push(""); // placeholder para mantener altura constante
  }

  // Rellenar hasta TOTAL_LINES
  while (lines.length < TOTAL_LINES) lines.push("");

  // NUNCA exceder la altura física de la terminal. Previene "Infinite Scroll Loop"
  const maxSafeHeight = Math.max(5, termHeight - 1);
  if (lines.length > maxSafeHeight) {
    lines.length = maxSafeHeight;
  }

  let output = "";

  if (!initialized) {
    // Primera vez: Emite retornos de carro puros para "empujar" el historial hacia arriba.
    output += "\n".repeat(lines.length);
    output += `\x1b[${lines.length}A\x1b[1G`; // Sube la cantidad exacta a dibujar
    initialized = true;
  } else if (previousLineCount > 0) {
    // Siguiente cuadro: Solo sube las líneas que bajó físicamente
    output += `\x1b[${previousLineCount}A\x1b[1G`;
  }
  
  for (const line of lines) {
    output += line + "\x1b[K\n"; // escribir + borrar resto de esa línea
  }
  
  // Borrar ghosting y asegurar anclaje horizontal puro
  output += "\x1b[J\r\x1b[1G"; 
  
  process.stdout.write(output);
  
  previousLineCount = lines.length;
  return lineIdx;
}

// Reset de estado visual por si se re-abre el player múltiples veces
function resetRenderer() {
  initialized = false;
  previousLineCount = 0;
  lastLayoutWidth = -1;
  lastLayoutHeight = -1;
  // Reiniciar geometry caches cuando se cierre completamente el script si fuera necesario.
  fixedWidth = null;
  fixedHeight = null;
}

module.exports = { render, getCurrentLineIdx, resetRenderer, SAFE_MODE };
