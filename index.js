const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const chalk = require("chalk");

// ─── Cargar PATH del sistema (para ffplay) ────────────────────────────────────
function getSystemPath() {
  try {
    const m = execSync('powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\', \'Machine\')"', { encoding: "utf-8" }).trim();
    const u = execSync('powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"', { encoding: "utf-8" }).trim();
    return `${m};${u}`;
  } catch {
    return process.env.PATH;
  }
}

const SYSTEM_ENV = { ...process.env, PATH: getSystemPath() };

// ─── Si no se pasan argumentos, abrir el menú automáticamente ─────────────────
const cliArgs     = process.argv.slice(2);
const audioArgIdx = cliArgs.indexOf("--audio");
const lrcArgIdx   = cliArgs.indexOf("--lrc");

if (audioArgIdx === -1 || lrcArgIdx === -1) {
  spawn("node", [path.join(__dirname, "menu.js")], { stdio: "inherit", env: SYSTEM_ENV })
    .on("close", (code) => process.exit(code ?? 0));
} else {

  const AUDIO_FILE  = cliArgs[audioArgIdx + 1];
  const LYRICS_FILE = cliArgs[lrcArgIdx + 1];

  // ═══════════════════════════════════════════════════════════════════════════
  // REPRODUCTOR INTERACTIVO
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Utilidades ──────────────────────────────────────────────────────────
  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = (s % 60).toString().padStart(2, "0");
    return `${m}:${ss}`;
  }

  function truncate(str, max) {
    return str.length > max ? str.substring(0, max - 1) + "…" : str;
  }

  // ─── Parser LRC ─────────────────────────────────────────────────────────
  function parseLRC(filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`\n  ❌ No se encontró el archivo: ${filePath}\n`));
      process.exit(1);
    }

    const data = fs.readFileSync(filePath, "utf-8");
    const lines = data.split("\n");
    const lyrics = [];
    let songTitle = "LyricSync Player";

    for (const line of lines) {
      const metaMatch = line.match(/\[ti:(.*?)\]/);
      if (metaMatch) {
        songTitle = metaMatch[1].trim();
        continue;
      }

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

  // ─── Estado del reproductor ──────────────────────────────────────────────
  const player = {
    playing: false,
    audioProcess: null,
    elapsed: 0,          // posición actual en segundos
    resumeTime: 0,       // Date.now() cuando se reanudó
    totalDuration: 0,
    lyrics: [],
    songTitle: "",
    currentLineIdx: -1,
    renderInterval: null,
    hasAudio: false,
    finished: false,
  };

  function getElapsed() {
    if (!player.playing) return player.elapsed;
    return player.elapsed + (Date.now() - player.resumeTime) / 1000;
  }

  function getCurrentLineIdx(elapsed) {
    let idx = -1;
    for (let i = 0; i < player.lyrics.length; i++) {
      if (elapsed >= player.lyrics[i].time) {
        idx = i;
      } else {
        break;
      }
    }
    return idx;
  }

  // ─── Control de audio (ffplay) ───────────────────────────────────────────
  function killAudio() {
    if (player.audioProcess) {
      try { player.audioProcess.kill("SIGKILL"); } catch {}
      player.audioProcess = null;
    }
  }

  function startAudio(position = 0) {
    killAudio();

    if (!player.hasAudio) {
      // Sin archivo de audio: solo letras
      player.resumeTime = Date.now();
      player.elapsed = position;
      player.playing = true;
      return;
    }

    const args = ["-nodisp", "-autoexit", "-loglevel", "quiet"];
    if (position > 0.5) {
      args.push("-ss", String(Math.floor(position)));
    }
    args.push(AUDIO_FILE);

    player.audioProcess = spawn("ffplay", args, {
      stdio: "ignore",
      env: SYSTEM_ENV,
    });

    player.audioProcess.on("error", () => {
      // ffplay no encontrado — continuar solo con letras
    });

    player.audioProcess.on("close", () => {
      if (player.playing && !player.finished) {
        // Audio terminó naturalmente
        player.finished = true;
      }
    });

    player.resumeTime = Date.now();
    player.elapsed = position;
    player.playing = true;
  }

  function togglePause() {
    if (player.finished) return;

    if (player.playing) {
      // Pausar: guardar posición y matar ffplay
      player.elapsed = getElapsed();
      killAudio();
      player.playing = false;
    } else {
      // Reanudar: reiniciar ffplay desde la posición guardada
      startAudio(player.elapsed);
    }
    render();
  }

  function seek(delta) {
    if (player.finished && delta > 0) return;

    const current = getElapsed();
    const newPos = Math.max(0, Math.min(current + delta, player.totalDuration));
    player.finished = false;
    startAudio(newPos);
    render();
  }

  function stopPlayer() {
    killAudio();
    player.playing = false;
    if (player.renderInterval) clearInterval(player.renderInterval);

    // Restaurar terminal
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.removeAllListeners("data");

    // Cursor visible
    process.stdout.write("\x1b[?25h");

    console.clear();
    console.log(chalk.cyan("\n  👋 Reproducción finalizada. Volviendo al menú...\n"));
    process.exit(0);
  }

  // ─── Renderizado del reproductor ─────────────────────────────────────────
  function render() {
    const elapsed = getElapsed();
    const lineIdx = getCurrentLineIdx(elapsed);
    const { lyrics, songTitle, totalDuration } = player;

    // Barra de progreso
    const barWidth = 46;
    const progress = Math.min(elapsed / (totalDuration || 1), 1);
    const filled   = Math.round(progress * barWidth);
    const empty    = barWidth - filled;
    const bar      = chalk.cyan("█".repeat(filled)) + chalk.gray("░".repeat(empty));
    const statusIcon = player.finished ? "⏹" : player.playing ? "▶" : "⏸";
    const statusColor = player.finished ? chalk.gray : player.playing ? chalk.green : chalk.yellow;

    // Líneas de letras (anterior, actual, siguiente)
    const prevLine2 = lineIdx > 1  ? lyrics[lineIdx - 2].text : "";
    const prevLine  = lineIdx > 0  ? lyrics[lineIdx - 1].text : "";
    const currLine  = lineIdx >= 0 ? lyrics[lineIdx].text     : "♪  Esperando...";
    const nextLine  = lineIdx < lyrics.length - 1 ? lyrics[lineIdx + 1].text : "";
    const nextLine2 = lineIdx < lyrics.length - 2 ? lyrics[lineIdx + 2].text : "";

    // Construir pantalla con un número fijo de líneas para evitar saltos
    const TOTAL_LINES = 20;
    const lines = [];

    // Header
    lines.push(chalk.cyan("  ╔══════════════════════════════════════════════════════════╗"));
    lines.push(chalk.cyan("  ║") + chalk.bold.white(`  🎵 ${truncate(songTitle, 54).padEnd(55)}`) + chalk.cyan("║"));
    lines.push(chalk.cyan("  ╚══════════════════════════════════════════════════════════╝"));
    lines.push("");

    // Barra de progreso
    lines.push(`  ${statusColor(statusIcon)}  ${bar}  ${chalk.yellow(formatTime(elapsed))} / ${chalk.gray(formatTime(totalDuration))}`);
    lines.push("");

    // Letras — zona central
    lines.push(chalk.cyan("  ── Letras ──────────────────────────────────────────────────"));
    lines.push("");

    // Siempre 5 slots para letras (para que no salte la pantalla)
    const lyricSlots = ["", "", "", "", ""];
    if (lineIdx >= 0) {
      // Slot 0: prevLine2
      if (lineIdx > 1)                   lyricSlots[0] = chalk.gray.dim(`      ${truncate(lyrics[lineIdx - 2].text, 60)}`);
      // Slot 1: prevLine
      if (lineIdx > 0)                   lyricSlots[1] = chalk.gray(`      ${truncate(lyrics[lineIdx - 1].text, 60)}`);
      // Slot 2: actual
      const colors = [chalk.bold.white, chalk.bold.cyan, chalk.bold.yellow, chalk.bold.magenta];
      lyricSlots[2] = colors[lineIdx % colors.length](`  ♪   ${currLine}`);
      // Slot 3: nextLine
      if (lineIdx < lyrics.length - 1)   lyricSlots[3] = chalk.gray(`      ${truncate(lyrics[lineIdx + 1].text, 60)}`);
      // Slot 4: nextLine2
      if (lineIdx < lyrics.length - 2)   lyricSlots[4] = chalk.gray.dim(`      ${truncate(lyrics[lineIdx + 2].text, 60)}`);
    } else {
      lyricSlots[2] = chalk.gray.italic(`  ♪   Esperando que comience la letra...`);
    }
    for (const slot of lyricSlots) lines.push(slot);

    lines.push("");
    lines.push(chalk.cyan("  ────────────────────────────────────────────────────────────"));

    // Controles
    if (player.finished) {
      lines.push(chalk.bold.green("  ✅ ¡Canción terminada!"));
      lines.push(chalk.gray("  [Esc] Salir   [←] Retroceder 10s"));
    } else {
      lines.push(chalk.gray(`  [Espacio] ${player.playing ? "Pausar" : "Reanudar"}   [← →] ±10 seg   [Esc] Salir`));
      lines.push(""); // placeholder para mantener altura constante
    }

    // Rellenar hasta TOTAL_LINES para altura fija
    while (lines.length < TOTAL_LINES) lines.push("");

    // Renderizar SIN borrar pantalla — sobreescribir en su lugar
    // Mover cursor a la posición (1,1) y sobreescribir cada línea
    let output = "\x1b[H"; // cursor a inicio
    for (const line of lines) {
      output += line + "\x1b[K\n"; // escribir + borrar resto de esa línea
    }
    process.stdout.write(output);
  }

  // ─── Captura de teclado ──────────────────────────────────────────────────
  function setupKeyboard() {
    if (!process.stdin.isTTY) return;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");

    // Ocultar cursor
    process.stdout.write("\x1b[?25l");

    // Buffer para distinguir Escape solo vs secuencias de flechas
    let escBuffer = "";
    let escTimer  = null;

    process.stdin.on("data", (key) => {
      // Ctrl+C — salir inmediato
      if (key === "\x03") {
        stopPlayer();
        return;
      }

      // Espacio — pausar/reanudar
      if (key === " ") {
        togglePause();
        return;
      }

      // q — salir
      if (key === "q" || key === "Q") {
        stopPlayer();
        return;
      }

      // Si empieza con \x1b, puede ser Escape solo O una secuencia de flecha
      if (key[0] === "\x1b" || escBuffer.length > 0) {
        escBuffer += key;
        if (escTimer) clearTimeout(escTimer);

        // Secuencias completas de flechas (3 bytes: \x1b [ letra)
        if (escBuffer === "\x1b[C") { escBuffer = ""; seek(10);  return; }  // → Adelantar
        if (escBuffer === "\x1b[D") { escBuffer = ""; seek(-10); return; }  // ← Retroceder
        if (escBuffer === "\x1b[A") { escBuffer = ""; return; }             // ↑ Ignorar
        if (escBuffer === "\x1b[B") { escBuffer = ""; return; }             // ↓ Ignorar

        // Si recibimos más de 3 chars sin match, descartar
        if (escBuffer.length >= 4) { escBuffer = ""; return; }

        // Esperar 100ms — si no llega nada más, es Escape solo
        escTimer = setTimeout(() => {
          if (escBuffer === "\x1b") stopPlayer();
          escBuffer = "";
        }, 100);

        return;
      }
    });
  }

  // ─── Manejo de señales ───────────────────────────────────────────────────
  process.on("exit", killAudio);
  process.on("SIGINT", stopPlayer);
  process.on("SIGTERM", stopPlayer);

  // ─── Main ──────────────────────────────────────────────────────────────
  function main() {
    const { lyrics, songTitle } = parseLRC(LYRICS_FILE);

    if (lyrics.length === 0) {
      console.error(chalk.red("\n  ❌ No se encontraron letras en el archivo .lrc\n"));
      process.exit(1);
    }

    player.lyrics        = lyrics;
    player.songTitle     = songTitle;
    player.totalDuration = lyrics[lyrics.length - 1].time + 5;
    player.hasAudio      = fs.existsSync(AUDIO_FILE);

    if (!player.hasAudio) {
      console.log(chalk.yellow(`\n  ⚠️  Audio no encontrado: ${AUDIO_FILE}`));
      console.log(chalk.gray("     Se mostrarán solo las letras.\n"));
    }

    // Iniciar audio y render
    console.clear(); // limpiar una sola vez al inicio
    startAudio(0);
    setupKeyboard();

    // Render loop — actualizar pantalla cada 300ms (sin borrar, sobreescribe)
    render();
    player.renderInterval = setInterval(() => {
      const prevIdx = player.currentLineIdx;
      const newIdx  = getCurrentLineIdx(getElapsed());

      // Re-renderizar siempre (para la barra de progreso)
      player.currentLineIdx = newIdx;
      render();

      // Verificar si la canción terminó
      if (getElapsed() >= player.totalDuration && !player.finished) {
        player.finished = true;
        player.playing = false;
        killAudio();
        render();
      }
    }, 250);
  }

  main();

} // fin del bloque else (modo reproductor)
