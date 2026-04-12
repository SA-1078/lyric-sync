/**
 * audio.js — Gestor de procesos ffplay (v3 - kill sincrónico)
 *
 * FIX CRÍTICO: kill() usa execSync para taskkill en vez de spawn async.
 * Esto GARANTIZA que ffplay muere ANTES de crear un nuevo proceso.
 * El bloqueo momentáneo (~50-100ms) es imperceptible y no afecta a
 * readline.emitKeypressEvents (que maneja correctamente bytes buffereados).
 *
 * La versión anterior usaba spawn('taskkill') async, lo cual no esperaba
 * a que ffplay muriera → audio duplicado en cada seek.
 */

const { spawn, execSync } = require("child_process");

class AudioManager {
  /**
   * @param {string} audioFile - Ruta al archivo de audio
   * @param {object} systemEnv - Variables de entorno con PATH extendido
   */
  constructor(audioFile, systemEnv) {
    this.audioFile  = audioFile;
    this.systemEnv  = systemEnv;
    this.process    = null;
    this.generation = 0;
    this.onNaturalEnd = null;

    // Safety net: matar ffplay si Node.js se cierra por cualquier razón
    this._exitHandler = () => this._killSync();
    process.on("exit", this._exitHandler);
  }

  /**
   * Inicia la reproducción desde una posición dada.
   * SIEMPRE mata el proceso anterior de forma SINCRÓNICA antes de crear uno nuevo.
   */
  start(position = 0, volume = 100) {
    // Matar el proceso anterior — SINCRÓNICO, garantiza que muera
    this._killSync();

    this.generation++;
    const gen = this.generation;

    const args = ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(volume), "-i", this.audioFile];
    if (position > 0.5) {
      args.push("-ss", String(position.toFixed(2)));
    }

    this.process = spawn("ffplay", args, {
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
      } catch {}
    }
  }

  /**
   * Mata el proceso ffplay actual. Público.
   */
  kill() {
    this._killSync();
  }

  /**
   * Kill SINCRÓNICO — mata ffplay y espera a que muera.
   * Usa taskkill /F /T para destruir todo el árbol ANTES de .kill() de Node.
   * Si llamamos .kill() primero, eliminamos al padre y el hijo se vuelve huérfano.
   */
  _killSync() {
    if (!this.process) return;

    const pid = this.process.pid;

    // Remover listeners para prevenir callbacks fantasma
    this.process.removeAllListeners();

    // Paso 1: taskkill para matar todo el árbol de procesos
    // SINCRÓNICO — asegura que el padre y los hijos mueran juntos.
    if (pid) {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, {
          stdio: "ignore",
          timeout: 1500,
        });
      } catch {} // Falla en Linux/Mac o si el proceso ya murió
    }

    // Paso 2: kill nativo como fallback de garantía final.
    try { this.process.kill("SIGKILL"); } catch {}

    this.process = null;
  }

  /**
   * Limpieza completa — llamar cuando el reproductor termina.
   * Remueve el handler de process.on('exit') para no interferir con el menú.
   */
  destroy() {
    this._killSync();
    process.removeListener("exit", this._exitHandler);
  }
}

module.exports = AudioManager;
