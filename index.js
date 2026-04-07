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
  // Sin argumentos completos → lanzar el menú y salir cuando termine
  spawn("node", [path.join(__dirname, "menu.js")], { stdio: "inherit", env: SYSTEM_ENV })
    .on("close", (code) => process.exit(code ?? 0));

  // Terminar este script aquí: las funciones de abajo no deben ejecutarse
  // (El proceso sigue vivo mientras el hijo esté corriendo)
} else {

  // ─── Archivos pasados por argumento ──────────────────────────────────────────
  const AUDIO_FILE  = cliArgs[audioArgIdx + 1];
  const LYRICS_FILE = cliArgs[lrcArgIdx + 1];

  // ─── Utilidades de terminal ───────────────────────────────────────────────────
  function clearLine() {
    process.stdout.write("\r\x1b[K");
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function printHeader(title) {
    const width = 60;
    const border = "═".repeat(width);
    console.log(chalk.cyan(`\n╔${border}╗`));
    console.log(chalk.cyan("║") + chalk.bold.white(title.padStart((width + title.length) / 2).padEnd(width)) + chalk.cyan("║"));
    console.log(chalk.cyan(`╚${border}╝\n`));
  }

  // ─── Parser LRC ──────────────────────────────────────────────────────────────
  function parseLRC(filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`❌ No se encontró el archivo: ${filePath}`));
      process.exit(1);
    }

    const data = fs.readFileSync(filePath, "utf-8");
    const lines = data.split("\n");
    const lyrics = [];
    let songTitle = "🎵 LyricSync Player";

    for (const line of lines) {
      const metaMatch = line.match(/\[ti:(.*?)\]/);
      if (metaMatch) {
        songTitle = `🎵 ${metaMatch[1].trim()}`;
        continue;
      }

      const timeMatch = line.match(/\[(\d+):(\d+)(?:\.(\d+))?\](.*)/);
      if (!timeMatch) continue;

      const minutes      = parseInt(timeMatch[1]);
      const seconds      = parseInt(timeMatch[2]);
      const centiseconds = timeMatch[3] ? parseInt(timeMatch[3]) / 100 : 0;
      const text         = timeMatch[4].trim();

      lyrics.push({
        time: minutes * 60 + seconds + centiseconds,
        text: text || "♪",
      });
    }

    return { lyrics, songTitle };
  }

  // ─── Barra de progreso ───────────────────────────────────────────────────────
  function renderProgressBar(elapsed, total, width = 40) {
    const safeTotal = total > 0 ? total : 1;
    const progress  = Math.min(elapsed / safeTotal, 1);
    const filled    = Math.round(progress * width);
    const empty     = width - filled;
    const bar       = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(empty));
    const timeStr   = chalk.yellow(`${formatTime(elapsed)} / ${formatTime(safeTotal)}`);
    process.stdout.write(`\r ${bar} ${timeStr}  `);
  }

  // ─── Reproductor de letras ────────────────────────────────────────────────────
  async function showLyrics(lyrics, totalDuration) {
    const start = Date.now();
    let lineIndex = 0;

    const progressInterval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      renderProgressBar(elapsed, totalDuration);
    }, 500);

    for (const line of lyrics) {
      const delay = line.time * 1000 - (Date.now() - start);
      if (delay > 0) {
        await new Promise((res) => setTimeout(res, delay));
      }

      process.stdout.write("\n");

      const colors  = [chalk.bold.white, chalk.bold.cyan, chalk.bold.yellow, chalk.bold.magenta];
      const colorFn = colors[lineIndex % colors.length];
      console.log("  " + colorFn(`▶  ${line.text}`));
      lineIndex++;
    }

    clearInterval(progressInterval);
    process.stdout.write("\n");
  }

  // ─── Main ─────────────────────────────────────────────────────────────────────
  async function main() {
    const { lyrics, songTitle } = parseLRC(LYRICS_FILE);

    if (lyrics.length === 0) {
      console.error(chalk.red("❌ No se encontraron letras en el archivo .lrc"));
      process.exit(1);
    }

    const totalDuration = lyrics[lyrics.length - 1].time + 5;

    printHeader(songTitle);
    console.log(chalk.gray(`  📁 Audio : ${AUDIO_FILE}`));
    console.log(chalk.gray(`  📄 Letras: ${LYRICS_FILE}`));
    console.log(chalk.gray(`  🎼 Líneas: ${lyrics.length}`));
    console.log();

    if (!fs.existsSync(AUDIO_FILE)) {
      console.log(chalk.yellow(`⚠️  No se encontró '${AUDIO_FILE}'. Ejecutando solo las letras...\n`));
    } else {
      // Reproducir audio con ffplay — sin detached para que muera con Ctrl+C
      const audio = spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", AUDIO_FILE], {
        stdio: "ignore",
        env: SYSTEM_ENV,
      });

      const killAudio = () => { try { audio.kill("SIGKILL"); } catch {} };
      process.on("exit",    killAudio);
      process.on("SIGINT",  () => { killAudio(); process.exit(0); });
      process.on("SIGTERM", () => { killAudio(); process.exit(0); });

      audio.on("error", () => {
        console.log(chalk.yellow("⚠️  ffplay no encontrado. Solo se mostrarán las letras."));
      });
    }

    console.log(chalk.bold.cyan("  ── Letras ──────────────────────────────────────────\n"));

    await showLyrics(lyrics, totalDuration);

    console.log(chalk.bold.green("\n\n  ✅ ¡Canción terminada! Gracias por usar LyricSync 🎶\n"));
  }

  main().catch((err) => {
    console.error(chalk.red(`Error fatal: ${err.message}`));
    process.exit(1);
  });

} // fin del bloque else (modo reproductor)
