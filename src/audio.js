/**
 * audio.js — Gestor de procesos ffplay (v5 — kill confirmado)
 *
 * Al pausar, reanudar, cambiar volumen o hacer seek se puede relanzar ffplay.
 * En Windows hay que esperar a que el proceso anterior muera para no crear
 * multiples pistas sonando a la vez.
 */

const { spawn, execFileSync } = require("child_process");
const { resolveFFplay } = require("./ffmpeg-resolver");
const { createLogger } = require("./logger");

const log = createLogger("audio");

class AudioManager {
  /**
   * @param {string} audioFile - Ruta al archivo de audio
   * @param {object} systemEnv - Variables de entorno con PATH extendido
   */
  constructor(audioFile, systemEnv) {
    this.audioFile = audioFile;
    this.systemEnv = systemEnv;
    this.process = null;
    this.generation = 0;
    this.onNaturalEnd = null;

    // Safety net: matar ffplay si Node.js se cierra por cualquier razón
    this._exitHandler = () => this._killConfirmed();
    process.on("exit", this._exitHandler);
  }

  /**
   * Inicia la reproducción desde una posición dada.
   * SIEMPRE mata el proceso anterior antes de crear uno nuevo.
   */
  start(position = 0, volume = 100) {
    this._killConfirmed();

    this.generation++;
    const gen = this.generation;

    const ffplayBin = resolveFFplay();
    if (!ffplayBin) {
      log.error("ffplay no encontrado — no se puede reproducir audio");
      return;
    }

    const args = ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(volume)];
    if (position > 0.5) {
      args.push("-ss", String(position.toFixed(2)));
    }
    args.push("-i", this.audioFile);

    this.process = spawn(ffplayBin, args, {
      stdio: ["pipe", "ignore", "ignore"],
      env: this.systemEnv,
    });

    this.process.on("error", () => {
      // ffplay no encontrado — se continúa solo con letras
    });

    this.process.on("close", (code) => {
      // Ignorar close events de procesos viejos (matados por seek/pause)
      if (gen !== this.generation) return;
      this.process = null;

      // Si terminó de verdad o crasheó, reportamos el fin.
      if (this.onNaturalEnd) this.onNaturalEnd();
    });
  }

  /**
   * Envía un atajo de teclado al stdin de ffplay (ej: '0' para subir vol)
   */
  sendKey(key) {
    if (this.process && this.process.stdin) {
      try {
        this.process.stdin.write(key);
      } catch { }
    }
  }

  /**
   * Mata el proceso ffplay actual. Público.
   */
  kill() {
    this._killConfirmed();
  }

  /**
   * Kill confirmado: mata ffplay y espera a que taskkill cierre su arbol.
   * Este pequeño bloqueo evita clones de audio durante pausa/reanudar/seek.
   */
  _killConfirmed() {
    if (!this.process) return;

    const pid = this.process.pid;

    // Remover listeners para prevenir callbacks fantasma
    this.process.removeAllListeners();

    // En Windows, taskkill /T evita dejar procesos de ffplay huerfanos.
    if (pid) {
      try {
        execFileSync("taskkill", ["/F", "/T", "/PID", pid.toString()], {
          stdio: "ignore",
          timeout: 1500,
          windowsHide: true,
        });
      } catch { }
    }

    // Fallback multiplataforma si taskkill no existe o el proceso sigue vivo.
    try { this.process.kill("SIGKILL"); } catch { }

    this.process = null;
  }

  /**
   * Limpieza completa — llamar cuando el reproductor termina.
   * Remueve el handler de process.on('exit') para no interferir con el menú.
   */
  destroy() {
    this._killConfirmed();
    process.removeListener("exit", this._exitHandler);
  }
}

module.exports = AudioManager;
