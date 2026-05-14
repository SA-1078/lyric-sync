/**
 * spectrum-analyzer.js — Motor de análisis espectral en tiempo real (v2 — estable)
 *
 * Pipeline:  ffmpeg (decode) → PCM buffer → Hanning window → FFT → log-scale bands → dB → smooth
 *
 * Cambios arquitectónicos clave:
 *  - Anti-spike limiter (MAX_DELTA) para evitar saltos violentos
 *  - Clamp seguro [0,1] en toda la cadena
 *  - Bass boost controlado
 *  - Kill confirmado (taskkill /T antes de relanzar el stream)
 *  - Detección de stream muerto via timestamp de último dato
 */

const { spawn, execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const ft = require("fourier-transform").default;
const { resolveFFmpeg } = require("../ffmpeg-resolver");
const { createLogger } = require("../logger");
const cfg = require("./config");

const log = createLogger("spectrum");

class SpectrumAnalyzer extends EventEmitter {
  /**
   * @param {string} audioFile  — Ruta al archivo de audio
   * @param {object} systemEnv  — Variables de entorno con PATH extendido
   */
  constructor(audioFile, systemEnv) {
    super();
    this.audioFile = audioFile;
    this.systemEnv = systemEnv;
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.prevBands = null;        // Para suavizado frame-to-frame
    this.peakBands = null;        // Indicadores de pico
    this.peakHold = null;         // Contadores de hold por banda
    this._destroyed = false;
    this.lastDataTime = 0;        // Timestamp del último dato recibido

    // Pre-calcular ventana Hanning
    this._hanningWindow = this._createHanningWindow(cfg.FFT_SIZE);
    // Pre-calcular mapeo logarítmico de bins → bandas
    this._bandMap = null;         // Se genera al conocer el número real de bandas
  }

  /**
   * Calcula cuántas bandas usar según el ancho de la terminal.
   */
  getAdaptiveBands() {
    const termWidth = process.stdout.columns || 110;
    // En modo simetría, necesitamos el doble de espacio
    const availableWidth = termWidth - 6; // margen lateral
    let maxBands = cfg.SYMMETRIC
      ? Math.floor(availableWidth / 2)
      : availableWidth;

    // Cada barra ocupa 1 carácter + 0 de gap (compacto)
    return Math.max(16, Math.min(cfg.BANDS, maxBands));
  }

  /**
   * ¿El stream está vivo? (recibió datos recientemente)
   */
  isStreamAlive() {
    if (this.lastDataTime === 0) return false;
    return (Date.now() - this.lastDataTime) < cfg.STREAM_DEAD_MS;
  }

  /**
   * Inicia el stream de análisis FFT.
   * Spawna ffmpeg para decodificar el audio a PCM crudo.
   */
  start() {
    const ffmpegBin = resolveFFmpeg();
    if (!ffmpegBin) {
      log.error("ffmpeg no encontrado — no se puede analizar audio");
      return;
    }

    const args = [
      "-re",                      // ← CRÍTICO: forzar output en tiempo real
      "-i", this.audioFile,
      "-f", "s16le",              // Raw PCM 16-bit signed little-endian
      "-acodec", "pcm_s16le",
      "-ar", String(cfg.SAMPLE_RATE),
      "-ac", String(cfg.CHANNELS),
      "-loglevel", "quiet",
      "pipe:1",                   // Output a stdout
    ];

    this.process = spawn(ffmpegBin, args, {
      stdio: ["pipe", "pipe", "ignore"],
      env: this.systemEnv,
    });

    // Bytes necesarios por chunk FFT: FFT_SIZE samples × 2 bytes/sample (16-bit)
    const chunkBytes = cfg.FFT_SIZE * 2;

    this.process.stdout.on("data", (data) => {
      if (this._destroyed) return;

      this.lastDataTime = Date.now();

      // Acumular buffer
      this.buffer = Buffer.concat([this.buffer, data]);

      // Procesar todos los chunks completos disponibles
      while (this.buffer.length >= chunkBytes) {
        const chunk = this.buffer.subarray(0, chunkBytes);
        this.buffer = this.buffer.subarray(chunkBytes);
        this._processChunk(chunk);
      }
    });

    this.process.on("error", (err) => {
      log.error(`ffmpeg error: ${err.message}`);
    });

    this.process.on("close", () => {
      if (!this._destroyed) {
        this.emit("end");
      }
    });
  }

  /**
   * Procesa un chunk de PCM crudo: int16 → float → Hanning → FFT → bandas.
   */
  _processChunk(chunk) {
    const numBands = this.getAdaptiveBands();

    // 1. Convertir Int16 → Float64 normalizado [-1, 1]
    const samples = new Float64Array(cfg.FFT_SIZE);
    for (let i = 0; i < cfg.FFT_SIZE; i++) {
      samples[i] = chunk.readInt16LE(i * 2) / 32768;
    }

    // 2. Aplicar ventana Hanning (reduce spectral leakage)
    for (let i = 0; i < cfg.FFT_SIZE; i++) {
      samples[i] *= this._hanningWindow[i];
    }

    // 3. FFT → magnitudes (solo mitad positiva: FFT_SIZE / 2 bins)
    const magnitudes = ft(samples);

    // 4. Agrupar en bandas logarítmicas
    if (!this._bandMap || this._bandMap.numBands !== numBands) {
      this._bandMap = this._createLogBandMap(magnitudes.length, numBands);
    }
    const rawBands = this._groupIntoBands(magnitudes, this._bandMap);

    // 5. Convertir a dB, normalizar a [0, 1], y aplicar bass boost controlado
    const normalizedBands = rawBands.map((val, i) => {
      if (val <= 0) return 0;
      const db = 20 * Math.log10(val);
      let normalized = (db - cfg.MIN_DB) / (cfg.MAX_DB - cfg.MIN_DB);

      // Bass boost controlado (primeras 30% de bandas)
      if (i < numBands * 0.3) {
        normalized *= cfg.BASS_BOOST;
      }

      // Clamp seguro [0, 1]
      return Math.max(0, Math.min(1, normalized));
    });

    // 6. Suavizado + Decay + Anti-spike
    const smoothed = this._applySmoothing(normalizedBands, numBands);

    // 7. Actualizar picos
    this._updatePeaks(smoothed, numBands);

    // 8. Emitir datos del espectro
    this.emit("spectrum", {
      bands: smoothed,
      peaks: this.peakBands ? Array.from(this.peakBands) : smoothed,
      numBands,
      rawMagnitudes: magnitudes,
    });
  }

  /**
   * Crea ventana Hanning para reducir spectral leakage.
   */
  _createHanningWindow(size) {
    const window = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return window;
  }

  /**
   * Crea un mapeo logarítmico de bins FFT → bandas visuales.
   */
  _createLogBandMap(numBins, numBands) {
    const map = [];
    const minFreq = 20;     // Hz mínimo audible
    const maxFreq = cfg.SAMPLE_RATE / 2; // Nyquist
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(maxFreq);

    for (let i = 0; i < numBands; i++) {
      const freqLow = Math.pow(10, logMin + (logMax - logMin) * (i / numBands));
      const freqHigh = Math.pow(10, logMin + (logMax - logMin) * ((i + 1) / numBands));

      const binLow = Math.max(0, Math.floor(freqLow * numBins * 2 / cfg.SAMPLE_RATE));
      const binHigh = Math.min(numBins - 1, Math.floor(freqHigh * numBins * 2 / cfg.SAMPLE_RATE));

      map.push({ binLow, binHigh, freqLow, freqHigh });
    }

    map.numBands = numBands;
    return map;
  }

  /**
   * Agrupa bins FFT en bandas según el mapeo logarítmico.
   */
  _groupIntoBands(magnitudes, bandMap) {
    const bands = new Float64Array(bandMap.numBands);

    for (let i = 0; i < bandMap.numBands; i++) {
      const { binLow, binHigh } = bandMap[i];
      let sum = 0;
      let count = 0;

      for (let b = binLow; b <= binHigh; b++) {
        if (b < magnitudes.length) {
          sum += magnitudes[b];
          count++;
        }
      }

      bands[i] = count > 0 ? sum / count : 0;
    }

    return bands;
  }

  /**
   * Aplica EMA + decay + anti-spike limiter.
   * Anti-spike: ninguna banda puede subir más de MAX_DELTA por frame.
   */
  _applySmoothing(current, numBands) {
    if (!this.prevBands || this.prevBands.length !== numBands) {
      this.prevBands = new Float64Array(numBands);
    }

    const result = new Float64Array(numBands);

    for (let i = 0; i < numBands; i++) {
      const prev = this.prevBands[i];
      let curr = current[i];

      if (curr > prev) {
        // Subida con attack + anti-spike limiter
        let target = prev + (curr - prev) * cfg.ATTACK_RATE;
        let delta = target - prev;
        if (delta > cfg.MAX_DELTA) {
          target = prev + cfg.MAX_DELTA;
        }
        result[i] = target;
      } else {
        // Bajada suave (EMA + decay)
        const smoothed = cfg.SMOOTHING * prev + (1 - cfg.SMOOTHING) * curr;
        const decayed = prev - cfg.DECAY_RATE / cfg.MAX_HEIGHT;
        result[i] = Math.max(0, Math.max(smoothed, decayed));
      }

      // Clamp seguro final
      result[i] = Math.max(0, Math.min(1, result[i]));
      this.prevBands[i] = result[i];
    }

    return Array.from(result);
  }

  /**
   * Actualiza indicadores de pico.
   */
  _updatePeaks(bands, numBands) {
    if (!this.peakBands || this.peakBands.length !== numBands) {
      this.peakBands = new Float64Array(numBands);
      this.peakHold = new Int32Array(numBands);
    }

    for (let i = 0; i < numBands; i++) {
      if (bands[i] >= this.peakBands[i]) {
        this.peakBands[i] = Math.min(1, bands[i]);
        this.peakHold[i] = cfg.PEAK_HOLD_FRAMES;
      } else if (this.peakHold[i] > 0) {
        this.peakHold[i]--;
      } else {
        this.peakBands[i] = Math.max(0, this.peakBands[i] - cfg.PEAK_DECAY_RATE / cfg.MAX_HEIGHT);
      }
    }
  }

  /**
   * Obtiene los rangos de bins para bass/mid/treble (para beat detection).
   */
  getFrequencyRanges(numBins) {
    const binForHz = (hz) => Math.floor(hz * numBins * 2 / cfg.SAMPLE_RATE);
    return {
      bass: { low: binForHz(cfg.BASS_RANGE_HZ[0]), high: binForHz(cfg.BASS_RANGE_HZ[1]) },
      mid: { low: binForHz(cfg.MID_RANGE_HZ[0]), high: binForHz(cfg.MID_RANGE_HZ[1]) },
      treble: { low: binForHz(cfg.TREBLE_RANGE_HZ[0]), high: binForHz(cfg.TREBLE_RANGE_HZ[1]) },
    };
  }

  /**
   * Mata el proceso ffmpeg y limpia recursos.
   * Kill confirmado: evita acumular procesos ffmpeg al hacer seek o pausar.
   */
  destroy() {
    this._destroyed = true;
    if (this.process) {
      this.process.removeAllListeners();
      if (this.process.stdout) this.process.stdout.removeAllListeners();
      const pid = this.process.pid;

      // En Windows, taskkill /T espera a que muera todo el arbol de ffmpeg.
      if (pid) {
        try {
          execFileSync("taskkill", ["/F", "/T", "/PID", pid.toString()], {
            stdio: "ignore",
            timeout: 1500,
            windowsHide: true,
          });
        } catch { }
      }

      try { this.process.kill("SIGKILL"); } catch { }

      this.process = null;
    }
    this.buffer = Buffer.alloc(0);
    this.prevBands = null;
    this.peakBands = null;
    this.peakHold = null;
    this.lastDataTime = 0;
    this.removeAllListeners();
  }
}

module.exports = SpectrumAnalyzer;
