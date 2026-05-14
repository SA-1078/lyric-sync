/**
 * beat-detector.js — Detección de beats por sub-bandas
 *
 * Analiza la energía de bass, mid y treble para detectar golpes rítmicos.
 * Usa una media móvil histórica para comparar energía instantánea vs tendencia.
 *
 * Efectos al detectar beat:
 * - Flash: barras de bass se iluminan en blanco brillante
 * - Pulse: incremento momentáneo de MAX_HEIGHT
 * - Color shift: gradiente rota 1 posición
 */

const cfg = require("./config");

class BeatDetector {
  constructor() {
    // Historial de energía para media móvil
    this.bassHistory = [];
    this.midHistory = [];
    this.trebleHistory = [];
    this.maxHistorySize = cfg.ENERGY_HISTORY_SIZE;

    // Cooldown para evitar dobles detecciones
    this.bassCooldown = 0;
    this.midCooldown = 0;
    this.trebleCooldown = 0;

    // Estado de beat actual (para el renderer)
    this.state = {
      bassBeat: false,
      midBeat: false,
      trebleBeat: false,
      intensity: 0,        // 0-1, cuán fuerte es el beat
      colorShift: 0,       // Offset de rotación del gradiente
    };
  }

  /**
   * Analiza un frame de magnitudes FFT crudas para detectar beats.
   * @param {Float64Array} magnitudes — Magnitudes FFT crudas
   * @param {number} numBins — Número de bins FFT
   */
  analyze(magnitudes, numBins) {
    // Calcular energía por sub-banda
    const bassEnergy = this._bandEnergy(magnitudes, numBins, cfg.BASS_RANGE_HZ);
    const midEnergy = this._bandEnergy(magnitudes, numBins, cfg.MID_RANGE_HZ);
    const trebleEnergy = this._bandEnergy(magnitudes, numBins, cfg.TREBLE_RANGE_HZ);

    // Agregar al historial
    this.bassHistory.push(bassEnergy);
    this.midHistory.push(midEnergy);
    this.trebleHistory.push(trebleEnergy);

    // Limitar historial
    if (this.bassHistory.length > this.maxHistorySize) this.bassHistory.shift();
    if (this.midHistory.length > this.maxHistorySize) this.midHistory.shift();
    if (this.trebleHistory.length > this.maxHistorySize) this.trebleHistory.shift();

    // Detectar beats (energía instantánea > threshold × media)
    const bassMean = this._mean(this.bassHistory);
    const midMean = this._mean(this.midHistory);
    const trebleMean = this._mean(this.trebleHistory);

    // Decrementar cooldowns
    if (this.bassCooldown > 0) this.bassCooldown--;
    if (this.midCooldown > 0) this.midCooldown--;
    if (this.trebleCooldown > 0) this.trebleCooldown--;

    // Bass beat
    this.state.bassBeat = false;
    if (bassMean > 0 && bassEnergy > bassMean * cfg.BEAT_THRESHOLD && this.bassCooldown === 0) {
      this.state.bassBeat = true;
      this.bassCooldown = cfg.BEAT_COOLDOWN_FRAMES;
    }

    // Mid beat
    this.state.midBeat = false;
    if (midMean > 0 && midEnergy > midMean * cfg.BEAT_THRESHOLD && this.midCooldown === 0) {
      this.state.midBeat = true;
      this.midCooldown = cfg.BEAT_COOLDOWN_FRAMES;
    }

    // Treble beat
    this.state.trebleBeat = false;
    if (trebleMean > 0 && trebleEnergy > trebleMean * cfg.BEAT_THRESHOLD && this.trebleCooldown === 0) {
      this.state.trebleBeat = true;
      this.trebleCooldown = cfg.BEAT_COOLDOWN_FRAMES;
    }

    // Intensidad global (dominada por bass)
    if (this.state.bassBeat) {
      this.state.intensity = Math.min(1, bassEnergy / (bassMean * 2));
    } else {
      this.state.intensity *= 0.85; // decay suave
    }

    // Color shift en cada bass beat
    if (this.state.bassBeat) {
      this.state.colorShift = (this.state.colorShift + 1) % cfg.GRADIENT_STOPS.length;
    }

    return this.state;
  }

  /**
   * Calcula la energía promedio en un rango de frecuencias.
   */
  _bandEnergy(magnitudes, numBins, rangeHz) {
    const binLow = Math.max(0, Math.floor(rangeHz[0] * numBins * 2 / cfg.SAMPLE_RATE));
    const binHigh = Math.min(magnitudes.length - 1, Math.floor(rangeHz[1] * numBins * 2 / cfg.SAMPLE_RATE));

    let sum = 0;
    let count = 0;
    for (let i = binLow; i <= binHigh; i++) {
      sum += magnitudes[i] * magnitudes[i]; // Energía = magnitud²
      count++;
    }

    return count > 0 ? sum / count : 0;
  }

  /**
   * Media aritmética de un array.
   */
  _mean(arr) {
    if (arr.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  /**
   * Reset completo del estado.
   */
  reset() {
    this.bassHistory = [];
    this.midHistory = [];
    this.trebleHistory = [];
    this.bassCooldown = 0;
    this.midCooldown = 0;
    this.trebleCooldown = 0;
    this.state = {
      bassBeat: false,
      midBeat: false,
      trebleBeat: false,
      intensity: 0,
      colorShift: 0,
    };
  }
}

module.exports = BeatDetector;
