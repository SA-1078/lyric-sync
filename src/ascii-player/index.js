/**
 * index.js — Orquestador del Reproductor con Visualizador ASCII (v2 — estable)
 *
 * ARQUITECTURA EVENT-DRIVEN:
 *   El render SOLO ocurre cuando hay datos nuevos del analyzer.
 *   NO hay setInterval de render — elimina overdraw, idle loops, y picos.
 *
 * Pipeline:
 *   ffplay  → reproduce audio (proceso independiente)
 *   ffmpeg  → decodifica PCM → SpectrumAnalyzer (FFT) → BeatDetector
 *   spectrum event → throttled render (máx FPS) → 1 write atómico
 *
 * Protecciones anti-crash:
 *   - Render event-driven (no polling)
 *   - Frame throttle (máx FPS)
 *   - Backpressure (skip si render en curso)
 *   - Stream-dead detection (congela frame, no renderiza vacío)
 *   - Frame fallback (nunca pantalla negra)
 *   - try/catch en toda la cadena de render
 *   - Kill confirmado antes de relanzar procesos
 *   - Seek con debounce
 */

const fs = require("fs");
const { execSync } = require("child_process");
const chalk = require("chalk");
const { parseLRC, formatTime } = require("../lrc-parser");
const AudioManager = require("../audio");
const SpectrumAnalyzer = require("./spectrum-analyzer");
const BeatDetector = require("./beat-detector");
const { renderSpectrum, resetSpectrumRenderer } = require("./spectrum-renderer");
const { setupKeyboard } = require("../keyboard");
const { resolveFFprobe } = require("../ffmpeg-resolver");
const { createLogger } = require("../logger");
const cfg = require("./config");

const log = createLogger("ascii-player");

function getExactAudioDuration(filePath, systemEnv) {
  const ffprobeBin = resolveFFprobe();
  if (!ffprobeBin) return null;

  try {
    const raw = execSync(
      `"${ffprobeBin}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { env: systemEnv, encoding: "utf-8" }
    ).trim();
    const duration = parseFloat(raw);
    return isNaN(duration) ? null : duration;
  } catch {
    return null;
  }
}

/**
 * Inicia el reproductor con visualizador ASCII.
 *
 * @param {string} audioFile  — Ruta al archivo de audio
 * @param {string} lrcFile    — Ruta al archivo .lrc
 * @param {object} systemEnv  — Variables de entorno con PATH extendido
 */
function startAsciiPlayer(audioFile, lrcFile, systemEnv) {
  return new Promise((resolvePlayer) => {
    // ─── Parsear letras ──────────────────────────────────────
    const { lyrics, songTitle } = parseLRC(lrcFile);

    const hasAudio = fs.existsSync(audioFile);
    const hasLyrics = lyrics.length > 0;

    let totalDuration = hasLyrics ? lyrics[lyrics.length - 1].time + 5 : 180;
    if (hasAudio) {
      const exactDur = getExactAudioDuration(audioFile, systemEnv);
      if (exactDur) totalDuration = exactDur;
    }

    // ─── Estado del reproductor (Clock Central) ──────────────
    const state = {
      playing: false,
      elapsed: 0,
      resumeTime: 0,
      totalDuration,
      lyrics,
      songTitle,
      currentLineIdx: -1,
      finished: false,
      exiting: false,
      volume: 100,

      // Espectro (actualizado por SpectrumAnalyzer)
      bands: [],
      peaks: [],
      numBands: 0,
      beat: {},
    };

    // ─── Componentes ─────────────────────────────────────────
    let audio = null;
    let analyzer = null;
    let beatDetector = new BeatDetector();
    let cleanupKbd = null;

    // ─── Timers del sistema ──────────────────────────────────
    let uiTickInterval = null;     // Timer lento para UI (letras/progreso) cuando pausado
    let streamWatchdog = null;     // Vigilante de stream muerto

    // ─── Frame throttle & backpressure ───────────────────────
    const FRAME_TIME = Math.round(1000 / cfg.FPS);
    let lastFrameTime = 0;
    let isRendering = false;

    // ─── Clock Central ───────────────────────────────────────
    function getElapsed() {
      if (!state.playing) return state.elapsed;
      return state.elapsed + (Date.now() - state.resumeTime) / 1000;
    }

    function clampPosition(position) {
      return Math.max(0, Math.min(position, totalDuration));
    }

    // ─── Audio (ffplay) ──────────────────────────────────────
    if (hasAudio) {
      audio = new AudioManager(audioFile, systemEnv);
      audio.onNaturalEnd = () => {
        if (state.playing && !state.finished && !state.exiting) {
          state.finished = true;
          state.playing = false;
          doRender();
        }
      };
    } else {
      console.log(chalk.yellow(`\n  ⚠️  Audio no encontrado: ${audioFile}`));
      console.log(chalk.gray("     Se mostrarán solo las letras.\n"));
    }

    // ─── Helper: registrar listeners del analyzer ─────────────
    function attachAnalyzerListeners() {
      if (!analyzer) return;

      analyzer.on("spectrum", (data) => {
        if (state.exiting || !state.playing) return;

        // Actualizar estado con datos nuevos
        state.bands = data.bands;
        state.peaks = data.peaks;
        state.numBands = data.numBands;

        if (data.rawMagnitudes) {
          state.beat = beatDetector.analyze(data.rawMagnitudes, data.rawMagnitudes.length);
        }

        // ── RENDER EVENT-DRIVEN con throttle ──────────────
        const now = Date.now();
        if (now - lastFrameTime >= FRAME_TIME) {
          lastFrameTime = now;
          doRender();
        }
      });

      analyzer.on("end", () => {
        log.info("FFmpeg stream terminado");
      });
    }

    // ─── Analyzer inicial ────────────────────────────────────
    if (hasAudio) {
      analyzer = new SpectrumAnalyzer(audioFile, systemEnv);
      attachAnalyzerListeners();
    }

    // ─── Reiniciar analyzer con seek ─────────────────────────
    function restartAnalyzer(position) {
      if (!hasAudio) return;

      // Destruir el anterior
      if (analyzer) analyzer.destroy();

      // Crear uno nuevo
      analyzer = new SpectrumAnalyzer(audioFile, systemEnv);
      attachAnalyzerListeners();

      if (position > 0.5) {
        // Seek: lanzar ffmpeg manualmente con -ss
        const { resolveFFmpeg } = require("../ffmpeg-resolver");
        const { spawn } = require("child_process");
        const ffmpegBin = resolveFFmpeg();
        if (!ffmpegBin) return;

        const args = [
          "-re",
          "-ss", String(position.toFixed(2)),
          "-i", audioFile,
          "-f", "s16le",
          "-acodec", "pcm_s16le",
          "-ar", String(cfg.SAMPLE_RATE),
          "-ac", String(cfg.CHANNELS),
          "-loglevel", "quiet",
          "pipe:1",
        ];

        analyzer.process = spawn(ffmpegBin, args, {
          stdio: ["pipe", "pipe", "ignore"],
          env: systemEnv,
        });

        const chunkBytes = cfg.FFT_SIZE * 2;

        analyzer.process.stdout.on("data", (data) => {
          if (analyzer._destroyed) return;
          analyzer.lastDataTime = Date.now();
          analyzer.buffer = Buffer.concat([analyzer.buffer, data]);
          while (analyzer.buffer.length >= chunkBytes) {
            const chunk = analyzer.buffer.subarray(0, chunkBytes);
            analyzer.buffer = analyzer.buffer.subarray(chunkBytes);
            analyzer._processChunk(chunk);
          }
        });

        analyzer.process.on("error", () => { });
        analyzer.process.on("close", () => {
          if (!analyzer._destroyed) analyzer.emit("end");
        });
      } else {
        analyzer.start();
      }
    }

    // ─── Iniciar audio desde una posición ────────────────────
    function startAudioAt(position) {
      const target = clampPosition(position);
      if (audio) {
        audio.start(target, state.volume);
      }
      state.resumeTime = Date.now();
      state.elapsed = target;
      state.playing = true;
      state.finished = false;

      restartAnalyzer(target);
    }

    // ─── Volume Control ──────────────────────────────────────
    let volumeDebounceTimeout = null;

    function changeVolume(delta) {
      if (state.exiting || state.finished) return;
      const newVol = Math.max(0, Math.min(100, state.volume + delta));
      if (newVol === state.volume) return;

      state.volume = newVol;
      doRender();

      if (state.playing) {
        if (volumeDebounceTimeout) clearTimeout(volumeDebounceTimeout);
        volumeDebounceTimeout = setTimeout(() => {
          if (!state.playing || state.exiting) return;
          state.elapsed = getElapsed();
          startAudioAt(state.elapsed);
        }, 300);
      }
    }

    // ─── Render con backpressure + try/catch ─────────────────
    function doRender() {
      if (isRendering || state.exiting) return;
      isRendering = true;

      try {
        state.currentLineIdx = renderSpectrum({
          ...state,
          elapsed: getElapsed(),
        });
      } catch (err) {
        log.error(`Render error: ${err.message}`);
      } finally {
        isRendering = false;
      }
    }

    // ─── Acciones del reproductor ────────────────────────────
    function togglePause() {
      if (state.exiting) return;
      if (state.finished) {
        exit();
        return;
      }

      if (state.playing) {
        cancelPendingSeekRestart();
        // ── Pausar ──────────────────────────────────────────
        state.elapsed = getElapsed();
        if (audio) audio.kill();
        if (analyzer) analyzer.destroy();
        state.playing = false;
        // Congelar beat visual
        state.beat = {
          bassBeat: false, midBeat: false, trebleBeat: false,
          intensity: 0, colorShift: state.beat.colorShift || 0,
        };

        // Iniciar tick lento para actualizar UI (barra de progreso, etc.) sin overdraw
        startUiTick();
      } else {
        // ── Reanudar ────────────────────────────────────────
        cancelPendingSeekRestart();
        stopUiTick();
        startAudioAt(state.elapsed);
      }
      doRender();
    }

    // ─── Seek con debounce ───────────────────────────────────
    let seekDebounceTimeout = null;
    let wasPlayingBeforeSeek = false;
    let seekToken = 0;

    function cancelPendingSeekRestart() {
      seekToken++;
      if (seekDebounceTimeout) {
        clearTimeout(seekDebounceTimeout);
        seekDebounceTimeout = null;
      }
    }

    function seek(delta) {
      if (state.exiting) return;
      if (state.finished && delta > 0) return;

      // En el primer pulso, congelar audio/analyzer
      if (!seekDebounceTimeout) {
        wasPlayingBeforeSeek = state.playing;
        state.elapsed = getElapsed();
        if (state.playing) {
          if (audio) audio.kill();
          if (analyzer) analyzer.destroy();
          state.playing = false;
          state.beat = {
            bassBeat: false, midBeat: false, trebleBeat: false,
            intensity: 0, colorShift: state.beat.colorShift || 0,
          };
        }
      }

      // Actualizar posición virtual
      state.elapsed = clampPosition(state.elapsed + delta);
      state.finished = false;
      beatDetector.reset();

      doRender(); // UI se actualiza inmediatamente

      // Reiniciar timeout — solo arranca audio cuando el usuario suelta la tecla
      if (seekDebounceTimeout) clearTimeout(seekDebounceTimeout);
      const token = ++seekToken;
      const target = state.elapsed;
      seekDebounceTimeout = setTimeout(() => {
        if (token !== seekToken) return;
        seekDebounceTimeout = null;
        if (state.exiting) return;
        if (wasPlayingBeforeSeek) {
          startAudioAt(target);
          doRender();
        }
      }, 300);
    }

    function exit() {
      if (state.exiting) return;
      state.exiting = true;

      // 1. Detener timers
      cancelPendingSeekRestart();
      stopUiTick();
      stopStreamWatchdog();
      if (volumeDebounceTimeout) clearTimeout(volumeDebounceTimeout);
      if (seekDebounceTimeout) clearTimeout(seekDebounceTimeout);

      // 2. Matar audio + analyzer
      if (audio) audio.kill();
      if (analyzer) analyzer.destroy();
      state.playing = false;

      // 3. Restaurar terminal
      process.stdout.removeListener("resize", onResize);
      process.stdout.write("\x1b[?7h\x1b[?25h");

      // 4. Cleanup
      setTimeout(() => {
        if (cleanupKbd) cleanupKbd();
        if (audio) audio.destroy();
        resolvePlayer();
      }, 200);
    }

    // ─── UI Tick (solo cuando pausado, 2 FPS) ────────────────
    function startUiTick() {
      stopUiTick();
      uiTickInterval = setInterval(() => {
        if (state.exiting) return;
        doRender();
      }, 500);
    }

    function stopUiTick() {
      if (uiTickInterval) {
        clearInterval(uiTickInterval);
        uiTickInterval = null;
      }
    }

    // ─── Stream Watchdog ─────────────────────────────────────
    // Si el stream de FFmpeg muere, congela el frame en vez de renderizar vacío
    function startStreamWatchdog() {
      stopStreamWatchdog();
      streamWatchdog = setInterval(() => {
        if (state.exiting || !state.playing) return;
        if (analyzer && !analyzer.isStreamAlive()) {
          // Stream muerto — NO renderizar, mantener último frame válido
          log.info("Stream watchdog: sin datos, congelando frame");
        }
      }, cfg.STREAM_DEAD_MS);
    }

    function stopStreamWatchdog() {
      if (streamWatchdog) {
        clearInterval(streamWatchdog);
        streamWatchdog = null;
      }
    }

    // ─── Inicialización ──────────────────────────────────────
    process.stdout.write("\x1b[?7l\x1b[?25l"); // No-wrap + hide cursor
    resetSpectrumRenderer();

    // Iniciar audio + analyzer
    if (hasAudio) {
      audio.start(0, state.volume);
      state.resumeTime = Date.now();
      state.elapsed = 0;
      state.playing = true;

      analyzer.start();
      startStreamWatchdog();
    } else {
      // Sin audio: tick lento para letras
      state.resumeTime = Date.now();
      state.elapsed = 0;
      state.playing = true;
      startUiTick();
    }

    // Resize handler
    let resizeTimeout = null;
    const onResize = () => {
      if (state.exiting) return;
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        resetSpectrumRenderer();
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        doRender();
      }, 100);
    };
    process.stdout.on("resize", onResize);

    // Keyboard
    cleanupKbd = setupKeyboard({
      onExit: exit,
      onEnter: () => { if (state.finished) exit(); },
      onTogglePause: togglePause,
      onSeekForward: () => seek(10),
      onSeekBackward: () => seek(-10),
      onVolUp: () => changeVolume(10),
      onVolDown: () => changeVolume(-10),
    });

    // Render inicial
    doRender();

    // ─── NO HAY setInterval de render ────────────────────────
    // El render ocurre SOLO vía eventos:
    //   1. spectrum event → render (throttled por FRAME_TIME)
    //   2. UI tick (500ms) cuando pausado
    //   3. Acciones de teclado → render inmediato

    // Auto-end si no hay audio
    if (!hasAudio) {
      const autoEndCheck = setInterval(() => {
        if (state.exiting) { clearInterval(autoEndCheck); return; }
        if (getElapsed() >= totalDuration && !state.finished) {
          state.finished = true;
          state.playing = false;
          doRender();
          clearInterval(autoEndCheck);
        }
      }, 1000);
    }

    // Signal handlers
    const sigintHandler = () => exit();
    process.once("SIGINT", sigintHandler);
    process.once("SIGTERM", sigintHandler);

    const originalResolve = resolvePlayer;
    resolvePlayer = () => {
      process.removeListener("SIGINT", sigintHandler);
      process.removeListener("SIGTERM", sigintHandler);
      originalResolve();
    };
  });
}

module.exports = { startAsciiPlayer };
