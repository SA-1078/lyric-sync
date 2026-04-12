/**
 * player.js — Coordinador del reproductor interactivo
 * Conecta audio, teclado y renderer en un flujo coherente.
 */

const fs = require("fs");
const { execSync } = require("child_process");
const chalk = require("chalk");
const { parseLRC } = require("./lrc-parser");
const AudioManager = require("./audio");
const { render, resetRenderer, SAFE_MODE } = require("./renderer");
const { setupKeyboard } = require("./keyboard");

function getExactAudioDuration(filePath, systemEnv) {
  try {
    const raw = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { env: systemEnv, encoding: "utf-8" }
    ).trim();
    const duration = parseFloat(raw);
    return isNaN(duration) ? null : duration;
  } catch {
    return null;
  }
}

/**
 * Inicia el reproductor interactivo.
 *
 * @param {string} audioFile  - Ruta al archivo de audio
 * @param {string} lrcFile    - Ruta al archivo .lrc
 * @param {object} systemEnv  - Variables de entorno con PATH extendido
 */
function startPlayer(audioFile, lrcFile, systemEnv) {
  return new Promise((resolvePlayer) => {
  // ─── Parsear letras ──────────────────────────────────────────
  const { lyrics, songTitle } = parseLRC(lrcFile);

  if (lyrics.length === 0) {
    console.error(chalk.red("\n  ❌ No se encontraron letras en el archivo .lrc\n"));
    process.exit(1);
  }

  const hasAudio      = fs.existsSync(audioFile);
  
  let totalDuration = lyrics[lyrics.length - 1].time + 5; // Estimación base
  if (hasAudio) {
    const exactDur = getExactAudioDuration(audioFile, systemEnv);
    if (exactDur) totalDuration = exactDur;
  }

  // ─── Estado del reproductor ──────────────────────────────────
  const state = {
    playing: false,
    elapsed: 0,          // posición guardada (cuando está pausado)
    resumeTime: 0,       // Date.now() cuando se reanudó
    totalDuration,
    lyrics,
    songTitle,
    currentLineIdx: -1,
    finished: false,
    exiting: false,
    volume: 100,
  };

  // ─── Variables de control ────────────────────────────────────
  let audio          = null;
  let cleanupKbd     = null;
  let renderInterval = null;

  // ─── Helpers de tiempo ───────────────────────────────────────
  function getElapsed() {
    if (!state.playing) return state.elapsed;
    return state.elapsed + (Date.now() - state.resumeTime) / 1000;
  }

  // ─── Audio ───────────────────────────────────────────────────
  if (hasAudio) {
    audio = new AudioManager(audioFile, systemEnv);
    audio.onNaturalEnd = () => {
      // Audio terminó por sí solo (llegó al final del archivo)
      if (state.playing && !state.finished && !state.exiting) {
        state.finished = true;
        state.playing  = false;
        doRender();
      }
    };
  } else {
    console.log(chalk.yellow(`\n  ⚠️  Audio no encontrado: ${audioFile}`));
    console.log(chalk.gray("     Se mostrarán solo las letras.\n"));
  }

  // ─── Iniciar audio desde una posición ────────────────────────
  function startAudioAt(position) {
    if (audio) {
      audio.start(position, state.volume);
    }
    state.resumeTime = Date.now();
    state.elapsed    = position;
    state.playing    = true;
  }

  let volumeDebounceTimeout = null;

  function changeVolume(delta) {
    if (state.exiting || state.finished) return;
    const newVol = Math.max(0, Math.min(100, state.volume + delta));
    if (newVol === state.volume) return;
    
    state.volume = newVol;
    doRender(); // Actualiza porcentaje visual instantáneamente

    // Si estaba reproduciendo, reiniciamos el gestor de audio con el nuevo volumen, 
    // pero aplicando un DEBOUNCING para no saturar al OS con subprocesos ffplay si
    // el usuario spamea el botón del volumen o la rueda del mouse agresivamente.
    if (state.playing) {
      if (volumeDebounceTimeout) clearTimeout(volumeDebounceTimeout);
      volumeDebounceTimeout = setTimeout(() => {
        if (!state.playing || state.exiting) return;
        state.elapsed = getElapsed();
        startAudioAt(state.elapsed);
      }, 250);
    }
  }

  // ─── Renderizar ──────────────────────────────────────────────
  let isRendering = false;
  function doRender() {
    if (isRendering || state.exiting) return;
    isRendering = true;

    try {
      state.currentLineIdx = render({
        ...state,
        elapsed: getElapsed(),
      });
    } finally {
      // Usamos finally para garantizar que el seguro se suelta incluso si `render()` crashea, 
      // evitando que toda la aplicación se quede congelada visualmente.
      isRendering = false;
    }
  }

  // ─── Acciones del reproductor ────────────────────────────────
  function togglePause() {
    if (state.finished || state.exiting) return;

    if (state.playing) {
      // Pausar: guardar posición actual y matar ffplay
      state.elapsed = getElapsed();
      if (audio) audio.kill();
      state.playing = false;
    } else {
      // Reanudar: reiniciar ffplay desde la posición guardada
      startAudioAt(state.elapsed);
    }
    doRender();
  }

  function seek(delta) {
    if (state.exiting) return;
    if (state.finished && delta > 0) return;

    const current = getElapsed();
    const newPos  = Math.max(0, Math.min(current + delta, totalDuration));
    state.finished = false;
    startAudioAt(newPos);
    doRender();
  }

  function exit() {
    // Evitar múltiples llamadas (Esc + Ctrl+C casi simultáneos)
    if (state.exiting) return;
    state.exiting = true;

    // 1. Matar el audio
    if (audio) audio.kill();
    state.playing = false;

    // 2. Detener render loop
    if (renderInterval) {
      clearInterval(renderInterval);
      renderInterval = null;
    }

    // 3. Restaurar teclado y terminal
    if (!SAFE_MODE) {
      process.stdout.removeListener("resize", onResize);
    }
    process.stdout.write("\x1b[?7h\x1b[?25h");

    // Pequeña pausa para que taskkill async termine
    setTimeout(() => {
      if (audio) audio.destroy(); // Limpiar handlers de exit nativos
      resolvePlayer();
    }, 200);
  }

  // ─── Inicialización ──────────────────────────────────────────
  // Buffer Principal (No-Wrap y Hide Cursor)
  process.stdout.write("\x1b[?7l\x1b[?25l");
  resetRenderer();
  startAudioAt(0);

  // Manejador de redimensionamiento de pantalla
  let lastWidth = process.stdout.columns;
  let lastHeight = process.stdout.rows;
  let resizeTimeout = null;
  let isResizing = false;

  const onResize = () => {
    if (state.exiting) return;

    isResizing = true;
    if (resizeTimeout) clearTimeout(resizeTimeout);

    resizeTimeout = setTimeout(() => {
      resetRenderer();                    // reinicia todo el estado visual
      
      // even in SAFE_MODE, we force the cache bounds to be reread fully safely
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // limpieza agresiva

      isResizing = false;
      doRender();                         // render inmediato después de resize
    }, 80); // un poco más rápido
  };

  if (!SAFE_MODE) {
    process.stdout.on("resize", onResize);
  } else {
    // En SAFE_MODE (Windows CMD) también escuchamos resize aunque sea menos confiable
    process.stdout.on("resize", onResize);
  }

  // Configurar teclado
  cleanupKbd = setupKeyboard({
    onExit:         exit,
    onTogglePause:  togglePause,
    onSeekForward:  () => seek(10),
    onSeekBackward: () => seek(-10),
    onVolUp:        () => changeVolume(10),
    onVolDown:      () => changeVolume(-10),
  });

  // Render loop (cada 250ms actualiza la barra de progreso y letras)
  doRender();
  renderInterval = setInterval(() => {
    if (state.exiting || isResizing) return; // BLOQUEO visual durante la tormenta de resize
    doRender();

    // Verificar si debemos terminar por tiempo (Solo cuando NO hay archivo de audio)
    if (!hasAudio && getElapsed() >= totalDuration && !state.finished) {
      state.finished = true;
      state.playing  = false;
      doRender();
    }
  }, 250);

  // Señales del sistema: para no depender del menú, interceptamos para el player
  const sigintHandler = () => exit();
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigintHandler);
  
  // Limpiar listener si resolvemos naturalmente (por Esc/Q)
  const originalResolve = resolvePlayer;
  resolvePlayer = () => {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigintHandler);
    originalResolve();
  };
  });
}

module.exports = { startPlayer };
