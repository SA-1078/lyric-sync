# 🎵 LyricSync — Reproductor de Letras Sincronizadas (Offline)

Software 100% offline que genera letras de canciones sincronizadas automáticamente usando IA (Whisper) y las reproduce en la terminal al ritmo de la música.

---

## 📁 Estructura del Proyecto

```
lyric-sync/
├── index.js               → Reproductor de letras + punto de entrada
├── menu.js                → Menú interactivo (seleccionar canciones, generar, reproducir)
├── generate-lrc.js        → Orquestador Node.js → Python (Whisper)
├── whisper_transcribe.py  → Motor de transcripción IA (offline)
├── lyrics_postprocess.py  → Post-procesador: limpia duplicados y alucinaciones
├── lrc/                   → Carpeta de letras generadas (.lrc por canción)
├── package.json
└── README.md
```

---

## ⚙️ Requisitos del Sistema

| Requisito | Versión mínima | Para qué |
|-----------|---------------|----------|
| **Node.js** | v18+ | Menú interactivo y reproductor |
| **Python** | v3.9+ | Motor de transcripción Whisper |
| **FFmpeg** | cualquiera | Extracción de audio y reproducción |

---

## 🚀 Instalación Completa

### 1. Clonar o descargar el proyecto

```bash
cd "C:\Users\TuUsuario\Documents"
git clone <tu-repo> lyric-sync
cd lyric-sync
```

### 2. Instalar dependencias de Node.js

```bash
npm install
```

Esto instala automáticamente:
- `chalk@4` — colores en terminal
- `inquirer@8` — menú interactivo con flechas
- `dotenv` — variables de entorno

### 3. Instalar dependencias de Python

```bash
pip install openai-whisper rapidfuzz
```

| Paquete | Tamaño | Para qué |
|---------|--------|----------|
| `openai-whisper` | ~3 MB + modelo | Motor de IA de transcripción (local, offline) |
| `rapidfuzz` | ~1.5 MB | Comparación fuzzy de texto para limpiar duplicados |

> ⚠️ **Nota:** La primera vez que generes letras, Whisper descargará el modelo de IA automáticamente (~461 MB para `small`). Solo se descarga una vez.

### 4. Instalar FFmpeg (si no lo tienes)

```bash
# Windows (con winget)
winget install Gyan.FFmpeg

# O descárgalo manualmente de: https://ffmpeg.org/download.html
```

Verifica que esté instalado:
```bash
ffplay -version
```

---

## 🎮 Cómo Usar

### Opción 1: Menú interactivo (recomendado)

```bash
npm start
# o también:
node index.js
# o directamente:
node menu.js
```

El menú te permite:
- 📁 **Explorar** tu carpeta de música (detecta `.mp3`, `.wav`, `.m4a`, `.flac`, `.mkv`, `.mp4`, etc.)
- 🤖 **Generar letras** con Whisper (elige el modelo de IA)
- ▶️ **Reproducir** canciones con letras sincronizadas
- 📋 **Ver** los archivos `.lrc` generados
- 🚀 **Procesar en lote** varias canciones a la vez

### Opción 2: Generar letras por CLI (directo)

```bash
node generate-lrc.js "C:\ruta\a\cancion.mp3" --language es
```

Opciones disponibles:
```
--output  -o  <archivo.lrc>   Nombre del archivo de salida
--model   -m  <modelo>        Modelo Whisper (default: small)
--language -l <codigo>        Forzar idioma: es, en, pt, fr... (default: auto)
--words                       Timestamps por PALABRA
```

### Opción 3: Limpiar un .lrc existente (post-procesador standalone)

```bash
python lyrics_postprocess.py "lrc/mi_cancion.lrc"
python lyrics_postprocess.py "lrc/mi_cancion.lrc" --output limpia.lrc
```

---

## 🤖 Modelos de Whisper

| Modelo   | Precisión | Velocidad (CPU)       | RAM   | Tamaño descarga |
|----------|-----------|----------------------|-------|-----------------|
| `tiny`   | ⭐        | ⚡⚡⚡ ~18 seg/canción  | ~1 GB | ~75 MB          |
| `base`   | ⭐⭐      | ⚡⚡ ~25 seg/canción   | ~1 GB | ~139 MB         |
| `small`  | ⭐⭐⭐ ← recomendado | ⚡ ~1 min/canción | ~2 GB | ~461 MB |
| `medium` | ⭐⭐⭐⭐   | 🐢 ~10-15 min/canción | ~5 GB | ~1.5 GB         |
| `large`  | ⭐⭐⭐⭐⭐  | 🐌 ~30+ min/canción   | ~10 GB| ~3 GB           |

> 💡 Los tiempos son aproximados para una canción de ~3 minutos en CPU. Con GPU NVIDIA los tiempos se reducen enormemente.

---

## 🧹 Post-procesador de Letras

El post-procesador `lyrics_postprocess.py` se ejecuta automáticamente después de cada transcripción y corrige:

| Corrección | Ejemplo |
|-----------|---------|
| Repeticiones internas | `lo que se fue ×20` → `lo que se fue` |
| Duplicados consecutivos | 3 líneas iguales seguidas → 1 sola |
| Duplicados fuzzy (85%+ similares) | Variaciones mínimas → 1 sola |
| Alucinaciones de Whisper | `"Gracias por ver"`, `"Suscríbete"` → eliminados |
| Timestamps imposibles | Segmentos de >30s con poco texto → eliminados |

---

## 📄 Formato .lrc

Puedes crear archivos `.lrc` manualmente con este formato:

```
[ti:Nombre de la canción]
[00:01.00]Primera línea de la letra
[00:05.50]Segunda línea
[00:10.00]♪
```

---

## 🔧 Solución de Problemas

| Error | Solución |
|-------|----------|
| `Python no está instalado` | Instala Python 3.9+ desde https://www.python.org/downloads/ |
| `ffplay no encontrado` | Instala FFmpeg: `winget install Gyan.FFmpeg` y reinicia la terminal |
| `ModuleNotFoundError: whisper` | Ejecuta: `pip install openai-whisper` |
| `ModuleNotFoundError: rapidfuzz` | Ejecuta: `pip install rapidfuzz` |
| Letras con muchos errores | Usa `--language es` para forzar el idioma |
| Audio sigue sonando después de Ctrl+C | Ya corregido — ffplay se mata automáticamente |

---

## 🗺️ Roadmap

- [x] **Fase 1** — Letras sincronizadas en consola (Node.js + Python)
  - [x] Transcripción offline con Whisper local
  - [x] Menú interactivo con selección de canciones
  - [x] Procesamiento en lote
  - [x] Post-procesador anti-alucinaciones
  - [x] Soporte multi-formato (mp3, wav, m4a, flac, mkv, mp4...)
- [ ] **Fase 2** — Web app (subir audio → genera video con letras)
- [ ] **Fase 3** — App móvil (reproductor de música con letras)
