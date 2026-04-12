/**
 * keyboard.js — Captura de teclado con readline nativo
 * readline.emitKeypressEvents() parsea escape sequences correctamente
 * en todos los terminales de Windows sin necesidad de parsing manual.
 */

const readline = require("readline");

/**
 * Configura la captura de teclado.
 * @param {object} handlers - Callbacks para cada acción
 * @returns {function|null} Función de limpieza
 */
function setupKeyboard(handlers) {
  if (!process.stdin.isTTY) return null;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Ocultar cursor
  process.stdout.write("\x1b[?25l");

  let active = true;

  const listener = (_str, key) => {
    if (!key || !active) return;

    // Ctrl+C
    if (key.ctrl && key.name === "c") {
      active = false;
      handlers.onExit();
      return;
    }

    // Escape
    if (key.name === "escape") {
      active = false;
      handlers.onExit();
      return;
    }

    // q / Q
    if (key.name === "q") {
      active = false;
      handlers.onExit();
      return;
    }

    // Espacio — pausar/reanudar
    if (key.name === "space") {
      handlers.onTogglePause();
      return;
    }

    // → Adelantar
    if (key.name === "right") {
      handlers.onSeekForward();
      return;
    }

    // ← Retroceder
    if (key.name === "left") {
      handlers.onSeekBackward();
      return;
    }

    // ↑ Subir volumen
    if (key.name === "up") {
      if (handlers.onVolUp) handlers.onVolUp();
      return;
    }

    // ↓ Bajar volumen
    if (key.name === "down") {
      if (handlers.onVolDown) handlers.onVolDown();
      return;
    }
  };

  process.stdin.on("keypress", listener);

  return function cleanup() {
    active = false;
    process.stdin.removeListener("keypress", listener);
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    process.stdin.pause();
    process.stdout.write("\x1b[?25h"); // restaurar cursor
  };
}

module.exports = { setupKeyboard };
