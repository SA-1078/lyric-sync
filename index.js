#!/usr/bin/env node
/**
 * index.js — Entrada Unificada de LyricSync
 *
 * Administra todo el reproductor usando módulos asíncronos limpios en el mismo proceso.
 * Evita la sobre-multiplicación de procesos y colisiones de terminal.
 */

const { SYSTEM_ENV } = require("./src/config");

process.env.PATH = SYSTEM_ENV.PATH; // Exponer universalmente a hijos

const cliArgs = process.argv.slice(2);
const audioArgIdx = cliArgs.indexOf("--audio");
const lrcArgIdx = cliArgs.indexOf("--lrc");

if (audioArgIdx !== -1 && lrcArgIdx !== -1) {
  // MODO DIRECTO (Reproductor Single)
  const audioFile = cliArgs[audioArgIdx + 1];
  const lrcFile = cliArgs[lrcArgIdx + 1];

  const { startPlayer } = require("./src/player");
  startPlayer(audioFile, lrcFile, SYSTEM_ENV)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  // MODO MENÚ INTERACTIVO (Loop principal)
  const { startMenuLoop } = require("./src/ui/menu-core");

  startMenuLoop().catch((err) => {
    if (err.isTtyError || err.message?.includes("force closed")) {
      console.log("\n\n  👋 LyricSync cerrado.\n");
      process.exit(0);
    }
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  });
}
