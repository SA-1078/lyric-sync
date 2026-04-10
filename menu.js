#!/usr/bin/env node
/**
 * menu.js — LyricSync
 * Menú interactivo para explorar música, generar letras y reproducir.
 * Navega con ↑↓, selecciona con Enter.
 *
 * Uso:
 *   node menu.js
 *   node menu.js --folder "C:\Users\Santiago\Music"
 */

const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const inquirer = require("inquirer");
const chalk = require("chalk");

// ─── Constantes ───────────────────────────────────────────────────────────────
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".wma", ".mp4", ".mkv", ".webm"];
const LRC_DIR = path.join(__dirname, "lrc"); // carpeta centralizada de letras generadas
const DEFAULT_MUSIC_FOLDER = path.join(process.env.USERPROFILE || "C:\\Users\\Public", "Music");

// ─── PATH del sistema (para ffplay y ffmpeg) ─────────────────────────────────
function getSystemPath() {
  try {
    const m = execSync('powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\',\'Machine\')"', { encoding: "utf-8" }).trim();
    const u = execSync('powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\',\'User\')"', { encoding: "utf-8" }).trim();
    return `${m};${u}`;
  } catch {
    return process.env.PATH;
  }
}
const SYSTEM_ENV = { ...process.env, PATH: getSystemPath() };

// ─── Asegurar que exista la carpeta lrc/ ─────────────────────────────────────
if (!fs.existsSync(LRC_DIR)) fs.mkdirSync(LRC_DIR, { recursive: true });

// ─── Utilidades ───────────────────────────────────────────────────────────────
function isAudioFile(file) {
  return AUDIO_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

function getLrcPath(audioPath) {
  const baseName = path.basename(audioPath, path.extname(audioPath));
  return path.join(LRC_DIR, baseName + ".lrc");
}

function hasLrc(audioPath) {
  return fs.existsSync(getLrcPath(audioPath));
}

function scanFolder(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const audioFiles = [];

    for (const entry of entries) {
      if (entry.isFile() && isAudioFile(entry.name)) {
        audioFiles.push(path.join(folderPath, entry.name));
      }
    }

    return audioFiles.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  } catch (err) {
    console.error(chalk.red(`❌ No se pudo leer la carpeta: ${err.message}`));
    return [];
  }
}

function formatFileName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function truncate(str, max = 55) {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

// ─── Encabezado ───────────────────────────────────────────────────────────────
function printBanner() {
  console.clear();
  const lines = [
    chalk.cyan("╔══════════════════════════════════════════════════════════╗"),
    chalk.cyan("║") + chalk.bold.white("            🎵  L Y R I C S Y N C                         ") + chalk.cyan("║"),
    chalk.cyan("║") + chalk.gray("        Reproductor de letras sincronizadas (offline)      ") + chalk.cyan("║"),
    chalk.cyan("╚══════════════════════════════════════════════════════════╝"),
    "",
  ];
  console.log(lines.join("\n"));
}

// ─── Generar LRC con Whisper ─────────────────────────────────────────────────
async function generateLrc(audioPath, model = "small", language = "es") {
  const lrcPath = getLrcPath(audioPath);
  const scriptPath = path.join(__dirname, "whisper_transcribe.py");

  return new Promise((resolve) => {
    console.log("");

    const proc = spawn(
      "python",
      [scriptPath, audioPath, "--output", lrcPath, "--model", model, "--language", language],
      { stdio: "inherit", env: SYSTEM_ENV }
    );

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(chalk.bold.green(`\n  ✅ ¡Letras generadas exitosamente!`));
        console.log(chalk.gray(`     Archivo: lrc/${path.basename(lrcPath)}`));
      } else {
        console.log(chalk.bold.red(`\n  ❌ Hubo un error durante la transcripción (código: ${code})`));
        console.log(chalk.gray(`     Intenta con un modelo más pequeño o verifica que el archivo de audio no esté dañado.`));
      }
      resolve(code === 0);
    });

    proc.on("error", () => {
      console.error(chalk.red("\n  ❌ No se pudo ejecutar Python."));
      console.error(chalk.gray("     Asegúrate de tener Python 3.9+ instalado y en el PATH."));
      console.error(chalk.gray("     Descarga: https://www.python.org/downloads/"));
      resolve(false);
    });
  });
}

// ─── Reproducir canción con letras ───────────────────────────────────────────
function playSong(audioPath) {
  const lrcPath = getLrcPath(audioPath);
  const scriptPath = path.join(__dirname, "index.js");

  if (!fs.existsSync(lrcPath)) {
    console.log(chalk.yellow("\n  ⚠️  Esta canción aún no tiene letras generadas."));
    console.log(chalk.gray("     Primero genéralas seleccionando ‘Generar letras’ en el menú.\n"));
    return;
  }

  console.log(chalk.cyan(`\n  ▶️  Reproduciendo: ${chalk.bold.white(path.basename(audioPath))}\n`));
  const proc = spawn("node", [scriptPath, "--audio", audioPath, "--lrc", lrcPath], {
    stdio: "inherit",
    env: SYSTEM_ENV,
  });

  proc.on("error", (err) => console.error(chalk.red(`❌ Error: ${err.message}`)));
}

// ─── Menú de acción para una canción ─────────────────────────────────────────
async function songActionMenu(audioPath, currentFolder) {
  const name = formatFileName(audioPath);
  const lrcExists = hasLrc(audioPath);

  console.log("");
  console.log(chalk.bold.white(`  🎵 ${truncate(name, 50)}`));
  console.log(chalk.gray(`     ${audioPath}`));
  if (lrcExists) {
    const lrcPath = getLrcPath(audioPath);
    const lineCount = fs.readFileSync(lrcPath, "utf-8").split("\n").filter(l => l.match(/^\[\d/)).length;
    console.log(chalk.green(`     ✅ Letras disponibles (${lineCount} líneas sincronizadas)`));
  } else {
    console.log(chalk.yellow(`     ⚠️  Sin letras — necesita transcripción con Whisper`));
  }
  console.log("");

  const choices = [];

  if (lrcExists) {
    choices.push({ name: "▶️  Reproducir con letras sincronizadas", value: "play" });
    choices.push({ name: "🔄 Regenerar letras (volver a transcribir)", value: "regen" });
    choices.push({ name: "📝 Ver contenido del archivo .lrc", value: "view" });
  } else {
    choices.push({ name: "🤖 Generar letras con Whisper IA", value: "gen_small" });
  }

  choices.push(new inquirer.Separator());
  choices.push({ name: chalk.gray("← Volver al listado"), value: "back" });

  const { action } = await inquirer.prompt([{
    type: "list",
    name: "action",
    message: "¿Qué deseas hacer con esta canción?",
    choices,
    pageSize: 10,
  }]);

  switch (action) {
    case "play":
      playSong(audioPath);
      break;

    case "gen_small":
    case "regen": {
      const { chosenModel } = await inquirer.prompt([{
        type: "list",
        name: "chosenModel",
        message: "Elige la calidad de transcripción:",
        choices: [
          { name: "base   - Rapido (~25 seg)     - Precision media - Para pruebas rapidas", value: "base" },
          { name: "small  - Normal (~1 min)      - Buena precision - Recomendado", value: "small" },
          { name: "medium - Lento  (~5-15 min)   - Alta precision  - Requiere buen CPU/GPU", value: "medium" },
          new inquirer.Separator(),
          { name: chalk.gray("← Volver sin generar"), value: "__back__" },
        ],
        default: "small",
      }]);

      if (chosenModel === "__back__") break;

      if (chosenModel === "medium") {
        const { ok } = await inquirer.prompt([{
          type: "confirm",
          name: "ok",
          message: chalk.yellow(`⚠️  'medium' puede tardar entre 5 y 15 minutos dependiendo de tu archivo y PC. ¿Deseas continuar?`),
          default: false,
        }]);
        if (!ok) {
          console.log(chalk.gray("\n  🚫 Operación cancelada. Puedes elegir 'small' para resultados más rápidos.\n"));
          await pause();
          break;
        }
      }

      await generateLrc(audioPath, chosenModel, "es");
      await pause();
      break;
    }

    case "gen_medium": {
      const { confirmMedium } = await inquirer.prompt([{
        type: "confirm",
        name: "confirmMedium",
        message: chalk.yellow(`⚠️  'medium' puede tardar entre 5 y 15 minutos dependiendo de tu PC. ¿Deseas continuar?`),
        default: false,
      }]);
      if (confirmMedium) {
        await generateLrc(audioPath, "medium", "es");
      } else {
        console.log(chalk.gray("\n  🚫 Operación cancelada. Puedes elegir 'small' para resultados más rápidos.\n"));
      }
      await pause();
      break;
    }

    case "view": {
      const lrcPath = getLrcPath(audioPath);
      const content = fs.readFileSync(lrcPath, "utf-8");
      console.log("");
      console.log(chalk.cyan(`  📝 Contenido de: ${chalk.white(path.basename(lrcPath))}`));
      console.log(chalk.cyan("  ──────────────────────────────────────────────────"));
      console.log(chalk.gray(content));
      console.log(chalk.cyan("  ──────────────────────────────────────────────────"));
      await pause();
      break;
    }

    case "back":
    default:
      break;
  }
}

function pause() {
  return inquirer.prompt([{
    type: "input",
    name: "_",
    message: chalk.gray("👉 Presiona Enter para volver al menú..."),
  }]);
}

// ─── Menú de selección de carpeta ────────────────────────────────────────────
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

// ─── Menú de procesamiento en lote ────────────────────────────────────────────
async function batchGenerateMenu(audioFiles) {
  const withoutLrc = audioFiles.filter(f => !hasLrc(f));

  if (withoutLrc.length === 0) {
    console.log(chalk.green("\n  ✅ ¡Todas tus canciones ya tienen letras generadas!"));
    console.log(chalk.gray("     No hay nada pendiente por procesar.\n"));
    await pause();
    return;
  }

  const choices = withoutLrc.map(f => ({
    name: truncate(formatFileName(f), 55),
    value: f,
    checked: true,
  }));

  const { selected } = await inquirer.prompt([{
    type: "checkbox",
    name: "selected",
    message: `Marca las canciones que deseas procesar (${withoutLrc.length} pendientes):`,
    choices,
    pageSize: 15,
  }]);

  if (selected.length === 0) {
    console.log(chalk.yellow("\n  ⚠️  No marcaste ninguna canción. Usa [Espacio] para seleccionar.\n"));
    return;
  }

  const { model } = await inquirer.prompt([{
    type: "list",
    name: "model",
    message: "Elige la calidad de transcripción para el lote:",
    choices: [
      { name: "base   - Rapido (~25 seg)     - Precision media  - Para pruebas rapidas", value: "base" },
      { name: "small  - Normal (~1 min)      - Buena precision - Recomendado", value: "small" },
      { name: "medium - Lento  (~5-15 min)   - Alta precision  - Requiere buen CPU/GPU", value: "medium" },
      new inquirer.Separator(),
      { name: chalk.gray("← Volver sin procesar"), value: "__back__" },
    ],
    default: "small",
  }]);

  if (model === "__back__") return;

  if (model === "medium") {
    const estMin = selected.length * 12;
    console.log("");
    console.log(chalk.yellow(`  ⚠️  Tiempo estimado: ~${estMin} minutos para ${selected.length} canción(es) con 'medium'.`));
    console.log(chalk.gray(`     Esto depende de la velocidad de tu CPU/GPU. Puedes dejarlo corriendo en segundo plano.`));
  }

  console.log("");
  console.log(chalk.bold.cyan(`  🚀 Iniciando procesamiento en lote...`));
  console.log(chalk.gray(`     Modelo: ${model}  |  Canciones: ${selected.length}`));
  console.log("");

  for (let i = 0; i < selected.length; i++) {
    const f = selected[i];
    console.log(chalk.bold.white(`\n  [🎵 ${i + 1}/${selected.length}] ${formatFileName(f)}`));
    await generateLrc(f, model, "es");
  }

  console.log("");
  console.log(chalk.bold.green(`  🎉 ¡Procesamiento completo!`));
  console.log(chalk.gray(`     ${selected.length} canción(es) procesada(s) con modelo '${model}'.`));
  console.log("");
  await pause();
}

// ─── Menú principal de canciones ─────────────────────────────────────────────
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

  // Construir lista con indicador de letra disponible
  const choices = audioFiles.map(f => {
    const name = truncate(formatFileName(f), 52);
    const icon = hasLrc(f) ? chalk.green("✅") : chalk.yellow("⚙️ ");
    return { name: `${icon} ${name}`, value: f };
  });

  const generated = audioFiles.filter(hasLrc).length;
  const total = audioFiles.length;

  choices.push(new inquirer.Separator());
  choices.push({ name: chalk.cyan(`🤖 Procesar en lote (${total - generated} sin letras)`), value: "__batch__" });
  choices.push({ name: chalk.gray("📂 Cambiar carpeta de música"), value: "__folder__" });
  choices.push({ name: chalk.gray("🚪 Salir de LyricSync"), value: "__exit__" });

  printBanner();
  console.log(chalk.gray(`  📁 Carpeta: ${folderPath}`));
  console.log(chalk.gray(`  🎵 ${total} archivos  |  ✅ ${generated} con letras  |  ⚙️  ${total - generated} pendientes\n`));

  const { selected } = await inquirer.prompt([{
    type: "list",
    name: "selected",
    message: "Elige una canción  (↑↓ navegar · Enter seleccionar):",
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

// ─── Loop principal ───────────────────────────────────────────────────────────
async function main() {
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

main().catch((err) => {
  if (err.isTtyError || err.message?.includes("force closed")) {
    console.log(chalk.cyan("\n\n  👋 LyricSync cerrado.\n"));
    process.exit(0);
  }
  console.error(chalk.red(`\nError: ${err.message}`));
  process.exit(1);
});
