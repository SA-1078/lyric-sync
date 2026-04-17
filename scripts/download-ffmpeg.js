#!/usr/bin/env node
/**
 * download-ffmpeg.js — LyricSync
 * Descarga FFmpeg essentials (gyan.dev) y extrae ffplay/ffprobe/ffmpeg en bin/.
 *
 * Uso:
 *   node scripts/download-ffmpeg.js
 *   npm run ffmpeg:install
 *
 * Solo Windows. En Linux/Mac usar el gestor de paquetes del sistema.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BIN_DIR = path.join(__dirname, "..", "bin");
const TEMP_DIR = path.join(__dirname, "..", "bin", "_temp");

// URL de FFmpeg release essentials (gyan.dev)
const FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    console.log(`  ⏳ Descargando FFmpeg (~85MB)...`);
    console.log(`     Fuente: ${url}`);
    console.log(`     Esto solo se hace una vez.\n`);

    const protocol = url.startsWith("https") ? https : http;

    const doRequest = (requestUrl) => {
      protocol.get(requestUrl, (res) => {
        // Manejar redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doRequest(res.headers.location);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const total = parseInt(res.headers["content-length"] || "0");
        let downloaded = 0;
        const file = fs.createWriteStream(destPath);

        res.on("data", (chunk) => {
          downloaded += chunk.length;
          file.write(chunk);
          if (total > 0) {
            const pct = ((downloaded / total) * 100).toFixed(1);
            const mb = (downloaded / 1024 / 1024).toFixed(1);
            process.stdout.write(`\r  📦 Progreso: ${mb} MB (${pct}%)`);
          }
        });

        res.on("end", () => {
          file.end();
          console.log("\n  ✅ Descarga completada.\n");
          resolve();
        });

        res.on("error", reject);
      }).on("error", reject);
    };

    doRequest(url);
  });
}

function extractZip(zipPath) {
  console.log("  📂 Extrayendo ejecutables...");

  try {
    // Usar PowerShell para extraer (nativo en Windows)
    ensureDir(TEMP_DIR);
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${TEMP_DIR}' -Force"`,
      { stdio: "pipe", timeout: 120000 }
    );

    // Buscar los ejecutables en la estructura extraída
    const binaries = ["ffplay.exe", "ffprobe.exe", "ffmpeg.exe"];
    let found = 0;

    function searchAndCopy(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          searchAndCopy(full);
        } else if (binaries.includes(entry.name.toLowerCase())) {
          const dest = path.join(BIN_DIR, entry.name);
          fs.copyFileSync(full, dest);
          console.log(`     ✓ ${entry.name} → bin/`);
          found++;
        }
      }
    }

    searchAndCopy(TEMP_DIR);

    // Limpiar temporales
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });

    return found;
  } catch (err) {
    console.error(`  ❌ Error extrayendo: ${err.message}`);
    return 0;
  }
}

async function main() {
  console.log();
  console.log("  ╭──────────────────────────────────────────────╮");
  console.log("  │  🎵 LyricSync — Instalador de FFmpeg        │");
  console.log("  ╰──────────────────────────────────────────────╯");
  console.log();

  // Verificar si ya existe
  const ffplayPath = path.join(BIN_DIR, "ffplay.exe");
  if (fs.existsSync(ffplayPath)) {
    console.log("  ✅ FFmpeg ya está instalado en bin/");
    console.log("     Si quieres reinstalar, borra la carpeta bin/ primero.\n");
    return;
  }

  if (process.platform !== "win32") {
    console.log("  ⚠️  Este script es solo para Windows.");
    console.log("     En Linux/Mac usa tu gestor de paquetes:");
    console.log("       sudo apt install ffmpeg     (Debian/Ubuntu)");
    console.log("       brew install ffmpeg          (macOS)\n");
    return;
  }

  ensureDir(BIN_DIR);

  const zipPath = path.join(BIN_DIR, "ffmpeg.zip");

  try {
    await downloadFile(FFMPEG_URL, zipPath);
    const found = extractZip(zipPath);

    if (found >= 2) {
      console.log(`\n  🎉 FFmpeg instalado exitosamente (${found} ejecutables)`);
      console.log("     LyricSync usará automáticamente estos binarios.\n");
    } else {
      console.log("\n  ⚠️  No se encontraron todos los ejecutables esperados.");
      console.log("     Descarga manualmente de: https://www.gyan.dev/ffmpeg/builds/\n");
    }
  } catch (err) {
    console.error(`\n  ❌ Error durante la descarga: ${err.message}`);
    console.error("     Verifica tu conexión a internet.\n");
    // Limpiar archivos parciales
    try { fs.rmSync(zipPath, { force: true }); } catch {}
  }
}

main();
