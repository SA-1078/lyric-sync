const fs = require("fs");
const chalk = require("chalk");
const inquirer = require("inquirer");

const {
  scanFolder,
  hasLrc,
  formatFileName,
  truncate,
  DEFAULT_MUSIC_FOLDER
} = require("../config");

const { songActionMenu, batchGenerateMenu, pause } = require("./menu-actions");

// ─── Diseño Visual ─────────────────────────────────────────────────────────
function printBanner() {
  console.clear();
  const banner = [
    chalk.magenta("    ██╗  ██╗   ██╗██████╗ ██╗ ██████╗███████╗██╗   ██╗███╗   ██╗ ██████╗"),
    chalk.magenta("    ██║  ╚██╗ ██╔╝██╔══██╗██║██╔════╝██╔════╝╚██╗ ██╔╝████╗  ██║██╔════╝"),
    chalk.cyan("    ██║   ╚████╔╝ ██████╔╝██║██║     ███████╗ ╚████╔╝ ██╔██╗ ██║██║     "),
    chalk.cyan("    ██║    ╚██╔╝  ██╔══██╗██║██║     ╚════██║  ╚██╔╝  ██║╚██╗██║██║     "),
    chalk.blue("    ███████╗██║   ██║  ██║██║╚██████╗███████║   ██║   ██║ ╚████║╚██████╗"),
    chalk.blue("    ╚══════╝╚═╝   ╚═╝  ╚═╝╚═╝ ╚═════╝╚══════╝   ╚═╝   ╚═╝  ╚═══╝ ╚═════╝"),
    "",
    chalk.gray("         ✦  Inteligencia Artificial Offline — Modo Terminal v1.0  ✦"),
    ""
  ];
  console.log(banner.join("\n"));
}

// ─── Selector de Carpetas ──────────────────────────────────────────────────
async function chooseFolderMenu(currentFolder) {
  const { folder } = await inquirer.prompt([{
    type: "input",
    name: "folder",
    message: "📂 Escribe la ruta de tu carpeta de música:",
    default: currentFolder,
  }]);

  const folderPath = folder.trim().replace(/^"|"$/g, ""); // quitar comillas si el usuario las pone
  if (!fs.existsSync(folderPath)) {
    console.log(chalk.red(`\n  ❌ Esa carpeta no existe: ${folderPath}`));
    console.log(chalk.gray(`     Verifica que la ruta esté bien escrita.\n`));
    return currentFolder;
  }
  return folderPath;
}

// ─── Lista de Canciones Principal ──────────────────────────────────────────
async function songListMenu(folderPath) {
  const audioFiles = scanFolder(folderPath);

  if (audioFiles.length === 0) {
    console.log("");
    console.log(chalk.yellow(`  ⚠️  No se encontraron archivos de audio en esta carpeta:`));
    console.log(chalk.gray(`     ${folderPath}`));
    console.log(chalk.gray(`     Formatos soportados: mp3, wav, m4a, flac, ogg, aac, mp4, mkv, webm`));
    console.log("");
    await pause();
    return folderPath;
  }

  // Construir lista de canciones con diseño premium
  const termWidth = process.stdout.columns || 100;
  const innerWidth = Math.max(60, Math.min(termWidth - 6, 140));

  const choices = audioFiles.map(f => {
    const isSynced = hasLrc(f);
    const shortName = truncate(formatFileName(f), innerWidth - 20);

    if (isSynced) {
      return {
        name: chalk.green(" ━► ") + chalk.bold.white(shortName) + chalk.green.dim(" [✓ SYNC]"),
        value: f
      };
    } else {
      return {
        name: chalk.gray(" ── ") + chalk.gray(shortName) + chalk.red.dim(" [✗ PEND]"),
        value: f
      };
    }
  });

  const generated = audioFiles.filter(hasLrc).length;
  const total = audioFiles.length;

  // Decorar opciones del sistema
  choices.push(new inquirer.Separator(chalk.magenta("  ✦  Opciones del Sistema  ✦   ")));
  choices.push({ name: chalk.bold.blue("   ↳ 🤖 Procesar canciones sin letras ") + chalk.gray(`(${total - generated} sin letras)`), value: "__batch__" });
  choices.push({ name: chalk.bold.cyan("   ↳ 📂 Cambiar directorio musical"), value: "__folder__" });
  choices.push(new inquirer.Separator(" "));
  choices.push({ name: chalk.bold.red("   ↳ 🚪 Salir de LyricSync"), value: "__exit__" });

  printBanner();

  // Marco de estadísticas estilo dashboard adaptativo
  const statBox = [
    chalk.cyan("  ╭" + "─".repeat(innerWidth) + "╮"),
    chalk.cyan("  │ ") + chalk.bold.white("📁 Directorio: ") + chalk.gray(truncate(folderPath, innerWidth - 20)),
    chalk.cyan("  │ ") + chalk.bold.blue("🎵 Total: ") + String(total).padEnd(3) +
    chalk.bold.green("   ✅ Con Letras: ") + String(generated).padEnd(3) +
    chalk.bold.yellow("   ⚙️ Pendientes: ") + String(total - generated).padEnd(4),
    chalk.cyan("  ╰" + "─".repeat(innerWidth) + "╯"),
    ""
  ];
  console.log(statBox.join("\n"));

  const { selected } = await inquirer.prompt([{
    type: "list",
    name: "selected",
    message: chalk.magenta.bold("¿Qué canción quieres escuchar hoy?") + chalk.gray(" (↑↓ navegar · Enter seleccionar):"),
    choices,
    pageSize: 18,
  }]);

  if (selected === "__exit__") return null;
  if (selected === "__folder__") return "__folder__";
  if (selected === "__batch__") {
    await batchGenerateMenu(audioFiles);
    return folderPath;
  }

  await songActionMenu(selected, folderPath);
  return folderPath;
}

// ─── Engine de Bucle Principal del Menú ────────────────────────────────────
async function startMenuLoop() {
  // Leer carpeta desde argumento --folder si se pasó
  const folderArgIndex = process.argv.indexOf("--folder");
  let currentFolder = folderArgIndex !== -1 && process.argv[folderArgIndex + 1]
    ? process.argv[folderArgIndex + 1]
    : DEFAULT_MUSIC_FOLDER;

  while (true) {
    printBanner();
    const result = await songListMenu(currentFolder);

    if (result === null) {
      console.log("");
      console.log(chalk.cyan("  👋 ¡Gracias por usar LyricSync! Hasta la próxima."));
      console.log("");
      process.exit(0);
    }

    if (result === "__folder__") {
      currentFolder = await chooseFolderMenu(currentFolder);
    } else {
      currentFolder = result || currentFolder;
    }
  }
}

module.exports = { startMenuLoop };
