# 🎵 LyricSync — Fase 1 (Consola)

Reproductor de letras sincronizadas en la terminal, con generación automática usando OpenAI Whisper.

## 📁 Estructura

```
lyric-sync/
├── index.js          → Reproductor de letras en terminal
├── generate-lrc.js   → Generador automático de .lrc con Whisper IA
├── lyrics.lrc        → Archivo de letras con timestamps
├── song.mp3          → Tu canción (opcional)
├── .env              → Tu API Key de OpenAI (crear manualmente)
├── .env.example      → Plantilla del .env
└── README.md
```

---

## 🎮 Modo 1: Reproducir letras existentes

```bash
node index.js
```
Reproduce `song.mp3` (si existe) y muestra `lyrics.lrc` sincronizado en la terminal.

---

## 🤖 Modo 2: Generar letras automáticamente (con Whisper IA)

### 1. Configurar tu API Key

Copia el ejemplo y pon tu clave:
```bash
copy .env.example .env
```
Luego edita `.env`:
```
OPENAI_API_KEY=sk-tu-api-key-real-aqui
```
> Obtén tu clave en: https://platform.openai.com/api-keys

### 2. Generar el .lrc desde tu audio

```bash
node generate-lrc.js song.mp3
```
Esto crea automáticamente `song.lrc` con las letras y timestamps.

Si quieres un nombre de salida específico:
```bash
node generate-lrc.js mi-cancion.mp3 --output letras.lrc
```

### 3. Reproducir el resultado

```bash
node index.js
```

---

## 📄 Formato .lrc (manual)

```
[ti:Nombre de la canción]
[00:01.00]Primera línea de la letra
[00:05.50]Segunda línea
[00:10.00]♪
```

---

## 🗺️ Roadmap

- [x] Fase 1 — Letras sincronizadas en consola (Node.js)
- [x] Generación automática con OpenAI Whisper
- [ ] Fase 2 — Web app con NestJS + HTML
- [ ] Fase 3 — App móvil con React Native
