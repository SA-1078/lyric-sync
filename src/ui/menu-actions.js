const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const inquirer = require("inquirer");
const chalk = require("chalk");

const {
  SYSTEM_ENV,
  getLrcPath,
  hasLrc,
  formatFileName,
  truncate,
} = require("../config");

const { startPlayer } = require("../player");
const { LyricSyncAPI } = require("../api-client");
const { BatchProcessor } = require("../batch-worker");
const { createLogger } = require("../logger");

// ─── Básicos ────────────────────────────────────────────────────────────────
function pause() {
  return inquirer.prompt([{
    type: "input",
    name: "_",
    message: chalk.gray("👉 Presiona Enter para volver al menú..."),
  }]);
}

// ─── Generación de LRC (Whisper) — con fallback híbrido API/spawn ─────────────
async function generateLrc(audioPath, model = "small", language = "es") {
  const lrcPath = getLrcPath(audioPath);

  // Intentar API primero (si está corriendo)
  const api = new LyricSyncAPI();
  if (await api.isRunning()) {
    console.log(chalk.cyan("\n  🌐 Usando API local para transcripción..."));
    try {
      const { task_id } = await api.transcribe(audioPath, model, language);
      const result = await api.waitForCompletion(task_id, (status, progress) => {
        process.stdout.write(`\r  ⏳ Estado: ${status} (${progress}%)   `);
      });
      console.log(chalk.bold.green(`\n\n   ✅  OPERACIÓN EXITOSA: Archivo de letras generado en formato LRC`));
      console.log(chalk.gray(`     Directorio de archivo generado: lrc/${path.basename(lrcPath)}`));
      return true;
    } catch (err) {
      console.log(chalk.yellow(`\n  ⚠️  Error con API: ${err.message}. Usando fallback directo...`));
    }
  }

  // Fallback: spawn directo de Python
  const scriptPath = path.join(__dirname, "..", "..", "whisper_transcribe.py");

  return new Promise((resolve) => {
    console.log("");

    const proc = spawn(
      "python",
      [scriptPath, audioPath, "--output", lrcPath, "--model", model, "--language", language],
      { stdio: "inherit", env: SYSTEM_ENV }
    );

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(chalk.bold.green(`\n   ✅  OPERACIÓN EXITOSA: Archivo de letras generado en formato LRC`));
        console.log(chalk.gray(`     Directorio de archivo generado: lrc/${path.basename(lrcPath)}`));
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

// ─── Forced Alignment (sincronizar con letra existente) ─────────────────
async function alignLyrics(audioPath) {
  const lrcPath = getLrcPath(audioPath);

  const { lyricsSource } = await inquirer.prompt([{
    type: "list",
    name: "lyricsSource",
    message: chalk.magenta("¿Cómo quieres proporcionar la letra?"),
    choices: [
      { name: chalk.cyan("   📄 Desde un archivo .txt"), value: "file" },
      { name: chalk.cyan("   ⌨️  Escribir/pegar en consola"), value: "input" },
      new inquirer.Separator(),
      { name: chalk.gray("   ← Volver"), value: "back" },
    ],
  }]);

  if (lyricsSource === "back") return;

  let lyricsText = "";

  if (lyricsSource === "file") {
    const { txtPath } = await inquirer.prompt([{
      type: "input",
      name: "txtPath",
      message: "Ruta al archivo .txt con la letra:",
    }]);

    const cleanPath = txtPath.trim().replace(/^"|"$/g, "");
    if (!fs.existsSync(cleanPath)) {
      console.log(chalk.red(`\n  ❌ No se encontró el archivo: ${cleanPath}\n`));
      return;
    }
    lyricsText = fs.readFileSync(cleanPath, "utf-8");
  } else {
    console.log(chalk.gray("\n  Pega la letra línea por línea. Escribe 'FIN' en una línea sola para terminar:\n"));
    const lines = [];
    while (true) {
      const { line } = await inquirer.prompt([{
        type: "input",
        name: "line",
        message: chalk.gray("  >"),
      }]);
      if (line.trim().toUpperCase() === "FIN") break;
      lines.push(line);
    }
    lyricsText = lines.join("\n");
  }

  if (!lyricsText.trim()) {
    console.log(chalk.yellow("\n  ⚠️  La letra está vacía. Operación cancelada.\n"));
    return;
  }

  console.log(chalk.cyan(`\n  🎯 Forced Alignment: sincronizando ${lyricsText.split("\n").length} líneas...\n`));

  const scriptPath = path.join(__dirname, "..", "..", "whisper_align.py");

  // Guardar letra en archivo temporal
  const tempTxt = path.join(__dirname, "..", "..", "_temp_lyrics.txt");
  fs.writeFileSync(tempTxt, lyricsText, "utf-8");

  return new Promise((resolve) => {
    const proc = spawn(
      "python",
      [scriptPath, audioPath, "--lyrics", tempTxt, "--output", lrcPath, "--language", "es"],
      { stdio: "inherit", env: SYSTEM_ENV }
    );

    proc.on("close", (code) => {
      // Limpiar temporal
      try { fs.unlinkSync(tempTxt); } catch {}

      if (code === 0) {
        console.log(chalk.bold.green(`\n   ✅ Alineación completada: lrc/${path.basename(lrcPath)}`));
      } else {
        console.log(chalk.bold.red(`\n  ❌ Error durante la alineación (código: ${code})`));
      }
      resolve(code === 0);
    });

    proc.on("error", () => {
      try { fs.unlinkSync(tempTxt); } catch {}
      console.error(chalk.red("\n  ❌ No se pudo ejecutar Python."));
      resolve(false);
    });
  });
}

// ─── Reproducir Canción (In Process) ─────────────────────────────────────────
async function playSong(audioPath) {
  const lrcPath = getLrcPath(audioPath);

  if (!fs.existsSync(lrcPath)) {
    console.log(chalk.yellow("\n  ⚠️  Esta canción aún no tiene letras generadas."));
    console.log(chalk.gray("     Primero genéralas seleccionando 'Generar letras' en el menú.\n"));
    return;
  }

  console.log(chalk.cyan(`\n  ▶️  Reproduciendo: ${chalk.bold.white(path.basename(audioPath))}\n`));

  // Esperar a que el reproductor in-process termine (Promise return)
  // ¡Se ejecuta en el MISMO Node.js, ahorrando memoria y previniendo colisiones de stdin!
  await startPlayer(audioPath, lrcPath, SYSTEM_ENV);
}

// ─── Iterador Batch (paralelo) ────────────────────────────────────────
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

  // Leer max_workers de config
  let maxWorkers = 2;
  try {
    const yaml = require("js-yaml");
    const configPath = path.join(__dirname, "..", "..", "config.yaml");
    if (fs.existsSync(configPath)) {
      const cfg = yaml.load(fs.readFileSync(configPath, "utf-8"));
      maxWorkers = (cfg && cfg.batch && cfg.batch.max_workers) || 2;
    }
  } catch {}

  if (model === "medium") {
    const estMin = selected.length * 12;
    console.log("");
    console.log(chalk.yellow(`  ⚠️  Tiempo estimado: ~${estMin} minutos para ${selected.length} canción(es) con 'medium'.`));
    console.log(chalk.gray(`     Esto depende de la velocidad de tu CPU/GPU. Puedes dejarlo corriendo en segundo plano.`));
  }

  console.log("");
  console.log(chalk.bold.cyan(`  🚀 Iniciando procesamiento en lote...`));
  console.log(chalk.gray(`     Modelo: ${model}  |  Canciones: ${selected.length}  |  Workers: ${maxWorkers}`));
  console.log("");

  // Usar BatchProcessor para paralelismo
  const batch = new BatchProcessor(maxWorkers, SYSTEM_ENV);
  for (const f of selected) {
    batch.addTask({
      audioPath: f,
      outputPath: getLrcPath(f),
      model,
      language: "es",
    });
  }

  const results = await batch.processAll((idx, total, fileName, status, detail) => {
    const icon = status === "done" ? "✅" : status === "error" ? "❌" : "⏳";
    console.log(chalk.white(`  [${icon} ${idx}/${total}] ${fileName} — ${status} ${detail}`));
  });

  const successes = results.filter(r => r.success).length;
  const failures = results.filter(r => !r.success).length;

  console.log("");
  console.log(chalk.bold.green(`  🎉 ¡Procesamiento completo!`));
  console.log(chalk.gray(`     ${successes} exitosa(s), ${failures} fallida(s) con modelo '${model}'.`));
  console.log("");
  await pause();
}

// ─── Acción en una sola Canción ──────────────────────────────────────────────
async function songActionMenu(audioPath, currentFolder) {
  const name = formatFileName(audioPath);
  const lrcExists = hasLrc(audioPath);

  console.log("");

  let statusText = chalk.red(`[✗ PEND] Pista No Procesada (Requiere IA Whisper)`);
  if (lrcExists) {
    const lrcPath = getLrcPath(audioPath);
    const lineCount = fs.readFileSync(lrcPath, "utf-8").split("\n").filter(l => l.match(/^\[\d/)).length;
    statusText = chalk.green(`[✓ SYNC] Procesada y Aprobada (${lineCount} líneas)`);
  }

  const termWidth = process.stdout.columns || 100;
  const innerWidth = Math.max(60, Math.min(termWidth - 6, 140));

  const infoBox = [
    chalk.cyan("  ╭" + "─".repeat(innerWidth) + "╮"),
    chalk.cyan("  │ ") + chalk.bold.white("💿 Pista : ") + chalk.white(truncate(name, innerWidth - 20)),
    chalk.cyan("  │ ") + chalk.gray("📂 Archivo: ") + chalk.gray.dim(truncate(audioPath, innerWidth - 20)),
    chalk.cyan("  │ ") + chalk.bold.blue("📊 Estado : ") + statusText,
    chalk.cyan("  ╰" + "─".repeat(innerWidth) + "╯"),
    ""
  ];
  console.log(infoBox.join("\n"));

  const choices = [];

  if (lrcExists) {
    choices.push({ name: chalk.green("   \u25b6\ufe0f  Iniciar Reproductor Interactivo"), value: "play" });
    choices.push({ name: chalk.yellow("   \ud83d\udd04 Sobreescribir Letra (Regenerar track)"), value: "regen" });
    choices.push({ name: chalk.blue("   \ud83c\udfaf Sincronizar con letra existente (Forced Alignment)"), value: "align" });
    choices.push({ name: chalk.cyan("   \ud83d\udcdd Inspeccionar archivo de letras (.lrc)"), value: "view" });
  } else {
    choices.push({ name: chalk.magenta.bold("   \ud83e\udd16 Escanear y Transcribir con IA Whisper"), value: "gen_small" });
    choices.push({ name: chalk.blue("   \ud83c\udfaf Sincronizar con letra existente (Forced Alignment)"), value: "align" });
  }

  choices.push(new inquirer.Separator(" "));
  choices.push({ name: chalk.gray("   ← Volver al Menú Principal"), value: "back" });

  const { action } = await inquirer.prompt([{
    type: "list",
    name: "action",
    message: chalk.magenta.bold("¿Qué deseas hacer con este archivo?"),
    choices,
    pageSize: 10,
  }]);

  switch (action) {
    case "play":
      await playSong(audioPath);
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

    case "align":
      await alignLyrics(audioPath);
      await pause();
      break;

    case "back":
    default:
      break;
  }
}

module.exports = {
  pause,
  generateLrc,
  alignLyrics,
  playSong,
  batchGenerateMenu,
  songActionMenu,
};
