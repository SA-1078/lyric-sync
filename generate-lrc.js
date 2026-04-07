#!/usr/bin/env node
/**
 * generate-lrc.js — LyricSync
 * Genera un archivo .lrc sincronizado a partir de un archivo de audio
 * usando Whisper local (100% offline, sin API key).
 *
 * Uso:
 *   node generate-lrc.js <audio>
 *   node generate-lrc.js song.mp3 --language es
 *   node generate-lrc.js song.mp3 --model small --language es
 *   node generate-lrc.js song.mp3 --words          (timestamp por palabra)
 *
 * Modelos:
 *   tiny   → muy rápido, menos preciso
 *   base   → rápido, precisión media
 *   small  → buen balance calidad/velocidad  ← recomendado
 *   medium → muy preciso, más lento
 *   large  → máxima calidad, muy lento
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// ─── Parsear argumentos ────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
🎵 LyricSync — Generador de letras offline con Whisper

Uso:
  node generate-lrc.js <audio> [opciones]

Opciones:
  --output  -o  <archivo.lrc>   Nombre del archivo de salida
  --model   -m  <modelo>        Modelo Whisper a usar (default: small)
  --language -l <codigo>        Forzar idioma: es, en, pt, fr... (default: auto)
  --words                       Timestamps por PALABRA (más preciso)

Modelos:
  tiny   → Muy rápido, menos preciso
  base   → Rápido, precisión media
  small  → Buen balance calidad/velocidad  ← recomendado
  medium → Muy preciso, más lento
  large  → Máxima calidad, muy lento

Ejemplos:
  node generate-lrc.js song.mp3
  node generate-lrc.js song.mp3 --language es
  node generate-lrc.js song.mp3 --model medium --language es
  node generate-lrc.js song.mp3 --words --language es
  node generate-lrc.js "C:\\Music\\cancion.mp3" --output letras.lrc
`);
  process.exit(0);
}

const audioFile = args[0];

const outputIndex = args.indexOf("--output");
const outputFile =
  outputIndex !== -1 && args[outputIndex + 1]
    ? args[outputIndex + 1]
    : path.basename(audioFile, path.extname(audioFile)) + ".lrc";

const modelIndex = args.indexOf("--model") !== -1 ? args.indexOf("--model") : args.indexOf("-m");
const model = modelIndex !== -1 && args[modelIndex + 1] ? args[modelIndex + 1] : "small";

const langIndex = args.indexOf("--language") !== -1 ? args.indexOf("--language") : args.indexOf("-l");
const language = langIndex !== -1 && args[langIndex + 1] ? args[langIndex + 1] : null;

const wordMode = args.includes("--words");

// ─── Validar archivo de entrada ───────────────────────────────────────────────
if (!fs.existsSync(audioFile)) {
  console.error(`❌ No se encontró el archivo: ${audioFile}`);
  process.exit(1);
}

// ─── Ruta al script Python ────────────────────────────────────────────────────
const scriptPath = path.join(__dirname, "whisper_transcribe.py");

if (!fs.existsSync(scriptPath)) {
  console.error("❌ No se encontró whisper_transcribe.py en la carpeta del proyecto.");
  process.exit(1);
}

// ─── Cargar PATH del sistema (necesario para que ffmpeg sea encontrado) ───────
const { execSync } = require("child_process");

function getSystemPath() {
  try {
    // Leer el PATH del sistema y del usuario desde el registro de Windows
    const machinePath = execSync(
      'powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\', \'Machine\')"',
      { encoding: "utf-8" }
    ).trim();
    const userPath = execSync(
      'powershell -Command "[System.Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"',
      { encoding: "utf-8" }
    ).trim();
    return `${machinePath};${userPath}`;
  } catch {
    return process.env.PATH; // fallback al PATH actual
  }
}

// ─── Ejecutar script Python ───────────────────────────────────────────────────
const pythonArgs = [scriptPath, audioFile, "--output", outputFile, "--model", model];

if (language) pythonArgs.push("--language", language);
if (wordMode) pythonArgs.push("--words");

const env = { ...process.env, PATH: getSystemPath() };
const proc = spawn("python", pythonArgs, { stdio: "inherit", env });

proc.on("error", (err) => {
  if (err.code === "ENOENT") {
    console.error("❌ Python no está instalado o no está en el PATH.");
    console.error("   Descárgalo en: https://www.python.org/downloads/");
  } else {
    console.error(`❌ Error al ejecutar Python: ${err.message}`);
  }
  process.exit(1);
});

proc.on("close", (code) => {
  if (code !== 0) {
    console.error(`\n❌ El script de Python terminó con código de error: ${code}`);
    process.exit(code);
  }
});
