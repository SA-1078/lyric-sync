/**
 * config.js — Parámetros centralizados del Visualizador ASCII
 * 
 * Optimizado para estabilidad máxima (evitar crashes de driver).
 * Render event-driven, carga uniforme, sin picos.
 */

module.exports = {
  // ─── FFT / Audio ─────────────────────────────────────────────
  SAMPLE_RATE: 44100,       // Hz (standard)
  CHANNELS: 1,              // Mono — más eficiente para FFT
  BIT_DEPTH: 16,            // s16le (16-bit signed little-endian)
  FFT_SIZE: 1024,           // Potencia de 2 → 512 frequency bins

  // ─── Espectro ────────────────────────────────────────────────
  BANDS: 48,                // Barras base (auto-ajustado al ancho de terminal)
  MAX_HEIGHT: 20,           // Altura máxima de barras en filas
  SYMMETRIC: true,          // Efecto espejo (duplica barras)

  // ─── Suavizado / Física (estables — anti-spike) ──────────────
  SMOOTHING: 0.75,          // EMA: inercia exponencial
  DECAY_RATE: 1.2,          // Velocidad de caída natural (unidades/frame)
  ATTACK_RATE: 0.4,         // Multiplicador de subida (moderado para evitar picos)
  MAX_DELTA: 0.25,          // Limitador anti-spike: máximo cambio por frame
  PEAK_HOLD_FRAMES: 8,      // Frames que un pico se mantiene antes de caer
  PEAK_DECAY_RATE: 0.5,     // Velocidad de caída del indicador de pico
  BASS_BOOST: 1.3,          // Boost controlado para bajos (máx 1.5)

  // ─── Render ──────────────────────────────────────────────────
  FPS: 15,                  // Frames por segundo — estable (NO subir hasta validar)
  MIN_DB: -60,              // dB mínimo para normalización
  MAX_DB: -10,              // dB máximo
  STREAM_DEAD_MS: 500,      // ms sin datos = stream muerto → congelar frame

  // ─── Gradiente RGB Arcoíris (de abajo → arriba) ─────────────
  // Se interpola entre estos puntos para crear gradiente continuo
  GRADIENT_STOPS: [
    { r: 255, g: 0,   b: 0   },   // Rojo (base/bajos)
    { r: 255, g: 100, b: 0   },   // Naranja
    { r: 255, g: 220, b: 0   },   // Amarillo
    { r: 0,   g: 255, b: 50  },   // Verde
    { r: 0,   g: 255, b: 200 },   // Cyan
    { r: 0,   g: 130, b: 255 },   // Azul
    { r: 180, g: 0,   b: 255 },   // Violeta (cima/agudos)
  ],

  // ─── Beat Detection ─────────────────────────────────────────
  BASS_RANGE_HZ: [20, 200],       // Frecuencias graves
  MID_RANGE_HZ: [200, 2000],      // Frecuencias medias
  TREBLE_RANGE_HZ: [2000, 16000], // Frecuencias agudas
  BEAT_THRESHOLD: 1.4,            // Multiplicador sobre media para detectar beat
  BEAT_COOLDOWN_FRAMES: 4,        // Frames mínimos entre beats detectados
  ENERGY_HISTORY_SIZE: 43,        // ~2 segundos a 15 FPS

  // ─── Caracteres de Barra ─────────────────────────────────────
  BAR_CHARS: {
    FULL:    "█",
    THREE_Q: "▓",
    HALF:    "▒",
    QUARTER: "░",
    PEAK:    "▔",
    EMPTY:   " ",
  },
};
