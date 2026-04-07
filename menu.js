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
    console.log(chalk.cyan(`\n🤖 Generando letras para: ${chalk.white(path.basename(audioPath))}`));
    console.log(chalk.gray(`   Modelo: ${model} | Idioma: ${language} | Salida: ${lrcPath}\n`));

    const proc = spawn(
      "python",
      [scriptPath, audioPath, "--output", lrcPath, "--model", model, "--language", language],
      { stdio: "inherit", env: SYSTEM_ENV }
    );

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(chalk.green(`\n✅ Letras guardadas en: lrc/${path.basename(lrcPath)}`));
      } else {
        console.log(chalk.red(`\n❌ Error al generar letras (código ${code})`));
      }
      resolve(code === 0);
    });

    proc.on("error", () => {
      console.error(chalk.red("❌ No se pudo ejecutar Python."));
      resolve(false);
    });
  });
}

// ─── Reproducir canción con letras ───────────────────────────────────────────
function playSong(audioPath) {
  const lrcPath = getLrcPath(audioPath);
  const scriptPath = path.join(__dirname, "index.js");

  if (!fs.existsSync(lrcPath)) {
    console.log(chalk.yellow("⚠️  Esta canción no tiene letras generadas aún. Genera primero con Whisper."));
    return;
  }

  console.log(chalk.cyan(`\n▶️  Reproduciendo: ${chalk.white(path.basename(audioPath))}\n`));
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
  console.log(chalk.gray(`  ${audioPath}`));
  console.log(chalk.gray(`  Letras: ${lrcExists ? chalk.green("✅ Generadas") : chalk.yellow("⚠️  Sin generar")}`));
  console.log("");

  const choices = [];

  if (lrcExists) {
    choices.push({ name: "▶️  Reproducir con letras sincronizadas", value: "play" });
    choices.push({ name: "🔄 Regenerar letras (con Whisper)", value: "regen" });
    choices.push({ name: "📄 Ver archivo .lrc", value: "view" });
  } else {
    choices.push({ name: "🤖 Generar letras — small  (recomendado, ~1 min)", value: "gen_small" });
    choices.push({ name: "🤖 Generar letras — medium (más preciso, ~10-15 min en CPU)", value: "gen_medium" });
  }

  choices.push(new inquirer.Separator());
  choices.push({ name: "← Volver a la lista de canciones", value: "back" });

  const { action } = await inquirer.prompt([{
    type: "list",
    name: "action",
    message: "¿Qué quieres hacer?",
    choices,
    pageSize: 10,
  }]);

  switch (action) {
    case "play":
      playSong(audioPath);
      break;

    case "gen_small":
    case "regen": {
      // Preguntar qué modelo usar antes de regenerar
      const { chosenModel } = await inquirer.prompt([{
        type: "list",
        name: "chosenModel",
        message: "¿Qué modelo de Whisper usar?",
        choices: [
          { name: "small   — ~1 min aprox/canción  · buena precisión · rápido (recomendado)", value: "small" },
          { name: "base    — ~25 seg aprox/canción · precisión media  · más rápido",           value: "base"  },
          { name: "medium  — ~10-15 min aprox/canción · más preciso   · ⚠️  muy lento en CPU", value: "medium" },
        ],
        default: "small",
      }]);

      if (chosenModel === "medium") {
        const { ok } = await inquirer.prompt([{
          type: "confirm",
          name: "ok",
          message: chalk.yellow("⚠️  El modelo 'medium' puede tardar 10-15 min para una canción de 3 min. ¿Continuar?"),
          default: false,
        }]);
        if (!ok) {
          console.log(chalk.gray("  Cancelado."));
          await pause();
          break;
        }
      }

      await generateLrc(audioPath, chosenModel, "es");
      await pause();
      break;
    }

    case "gen_medium": {
      // Llegamos aquí solo si la canción no tenía letras y se eligió medium directamente
      const { confirmMedium } = await inquirer.prompt([{
        type: "confirm",
        name: "confirmMedium",
        message: chalk.yellow("⚠️  El modelo 'medium' puede tardar 10-15 minutos en CPU para una canción de 3 min.\n  ¿Continuar de todas formas?"),
        default: false,
      }]);
      if (confirmMedium) {
        await generateLrc(audioPath, "medium", "es");
      } else {
        console.log(chalk.gray("  Cancelado. Elige 'small' para una opción más rápida."));
      }
      await pause();
      break;
    }

    case "view": {
      const lrcPath = getLrcPath(audioPath);
      const content = fs.readFileSync(lrcPath, "utf-8");
      console.log(chalk.cyan(`\n📄 ${path.basename(lrcPath)}:\n`));
      console.log(chalk.gray(content));
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
    message: chalk.gray("Presiona Enter para continuar..."),
  }]);
}

// ─── Menú de selección de carpeta ────────────────────────────────────────────
async function chooseFolderMenu(currentFolder) {
  const { folder } = await inquirer.prompt([{
    type: "input",
    name: "folder",
    message: "📁 Ruta de la carpeta de música:",
    default: currentFolder,
  }]);

  const folderPath = folder.trim().replace(/^"|"$/g, ""); // quitar comillas si el usuario las pone
  if (!fs.existsSync(folderPath)) {
    console.log(chalk.red(`❌ La carpeta no existe: ${folderPath}`));
    return currentFolder;
  }
  return folderPath;
}

// ─── Menú de procesamiento en lote ────────────────────────────────────────────
async function batchGenerateMenu(audioFiles) {
  const withoutLrc = audioFiles.filter(f => !hasLrc(f));

  if (withoutLrc.length === 0) {
    console.log(chalk.green("\n✅ ¡Todas las canciones ya tienen letras generadas!\n"));
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
    message: `Selecciona canciones a procesar (${withoutLrc.length} sin letras):`,
    choices,
    pageSize: 15,
  }]);

  if (selected.length === 0) {
    console.log(chalk.yellow("\n⚠️  No seleccionaste ninguna canción.\n"));
    return;
  }

  const { model } = await inquirer.prompt([{
    type: "list",
    name: "model",
    message: "¿Qué modelo usar para todas?",
    choices: [
      { name: "small   — ~1 min aprox/canción  · buena precisión - rapido (recomendado)", value: "small" },
      { name: "base    — ~25 seg aprox/canción · precisión media - lento", value: "base" },
      { name: "medium  — ~10-15 min aprox/canción · más preciso - demasiado lento", value: "medium" },
    ],
    default: "small",
  }]);

  if (model === "medium") {
    const estMin = selected.length * 12;
    console.log(chalk.yellow(`\n⚠️  Con el modelo 'medium' se estima ~${estMin} minutos en total para ${selected.length} canción(es). Ten paciencia.\n`));
  }

  console.log(chalk.cyan(`\n🚀 Procesando ${selected.length} canciones con modelo '${model}'...\n`));

  for (let i = 0; i < selected.length; i++) {
    const f = selected[i];
    console.log(chalk.bold(`\n[${i + 1}/${selected.length}] ${formatFileName(f)}`));
    await generateLrc(f, model, "es");
  }

  console.log(chalk.bold.green(`\n🎉 ¡Listo! ${selected.length} canciones procesadas.\n`));
  await pause();
}

// ─── Menú principal de canciones ─────────────────────────────────────────────
async function songListMenu(folderPath) {
  const audioFiles = scanFolder(folderPath);

  if (audioFiles.length === 0) {
    console.log(chalk.yellow(`\n⚠️  No se encontraron archivos de audio en:\n   ${folderPath}\n`));
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
  choices.push({ name: chalk.cyan(`🤖 Generar letras en lote (${total - generated} pendientes)`), value: "__batch__" });
  choices.push({ name: chalk.gray("📁 Cambiar carpeta de música"), value: "__folder__" });
  choices.push({ name: chalk.gray("❌ Salir"), value: "__exit__" });

  printBanner();
  console.log(chalk.gray(`  📁 Carpeta: ${folderPath}`));
  console.log(chalk.gray(`  🎵 ${total} archivos  |  ✅ ${generated} con letras  |  ⚙️  ${total - generated} pendientes\n`));

  const { selected } = await inquirer.prompt([{
    type: "list",
    name: "selected",
    message: "Selecciona una canción (↑↓ para navegar, Enter para elegir):",
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
      console.log(chalk.green("\n👋 ¡Hasta luego! LyricSync cerrado.\n"));
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
    console.log(chalk.green("\n\n👋 LyricSync cerrado.\n"));
    process.exit(0);
  }
  console.error(chalk.red(`\nError: ${err.message}`));
  process.exit(1);
});
