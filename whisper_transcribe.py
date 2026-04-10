#!/usr/bin/env python3
"""
whisper_transcribe.py — LyricSync
Transcribe un archivo de audio con Whisper local y genera un archivo .lrc.

Uso:
  python whisper_transcribe.py <audio> [opciones]

Opciones:
  --output   -o   Nombre del archivo .lrc de salida
  --model    -m   tiny | base | small | medium | large  (default: small)
  --language -l   Código de idioma: es, en, pt, fr...   (default: auto)
  --words         Usar timestamps por PALABRA (más preciso, más líneas)
"""

import whisper
import sys
import os
import re
import argparse

# Importar post-procesador de letras
try:
    from lyrics_postprocess import postprocess_segments
    HAS_POSTPROCESS = True
except ImportError:
    HAS_POSTPROCESS = False

# ──────────────────────────────────────────────────────────────────────────────
# Utilidades
# ──────────────────────────────────────────────────────────────────────────────

def to_lrc_timestamp(seconds: float) -> str:
    """Convierte segundos a formato LRC [MM:SS.xx]"""
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes:02d}:{secs:05.2f}"


def clean_text(text: str) -> str:
    """
    Limpia el texto transcrito:
    - Elimina espacios múltiples
    - Elimina marcadores [Music] [Applause] etc. que Whisper a veces inserta
    - Recorta espacios al inicio/fin
    """
    text = re.sub(r"\[.*?\]", "", text)          # elimina [Music], [Applause], etc.
    text = re.sub(r"\(.*?\)", "", text)          # elimina (música), (risas), etc.
    text = re.sub(r"\s{2,}", " ", text)          # espacios múltiples → uno
    text = text.strip()
    return text


def split_long_segment(text: str, start: float, end: float, max_chars: int = 60):
    """
    Si un segmento es muy largo, lo divide en partes iguales con tiempo interpolado.
    Esto mejora la sincronización visual cuando Whisper agrupa demasiado texto.
    """
    if len(text) <= max_chars:
        return [(start, text)]

    # Dividir por comas o palabras en el punto medio
    words = text.split()
    mid = len(words) // 2
    part1 = " ".join(words[:mid])
    part2 = " ".join(words[mid:])
    mid_time = start + (end - start) / 2

    result = []
    if part1:
        result.append((start, part1))
    if part2:
        result.append((mid_time, part2))
    return result


# ──────────────────────────────────────────────────────────────────────────────
# Generador principal
# ──────────────────────────────────────────────────────────────────────────────

def generate_lrc(
    audio_path: str,
    output_path: str,
    model_name: str = "small",
    language: str = None,
    word_mode: bool = False,
):
    # ── Header ─────────────────────────────────────────────────────────────────
    basename = os.path.basename(audio_path)
    lrc_name = os.path.basename(output_path)
    lang_display = language if language else "auto"

    print()
    print("  ╔══════════════════════════════════════════════════════════╗")
    print("  ║  🎙️  LyricSync — Transcripción con Whisper IA (Offline)  ║")
    print("  ╚══════════════════════════════════════════════════════════╝")
    print()
    print(f"  🎵 Archivo  : {basename}")

    if not os.path.exists(audio_path):
        print(f"\n  ❌ No se encontró el archivo: {audio_path}", file=sys.stderr)
        print(f"     Verifica que la ruta sea correcta.\n", file=sys.stderr)
        sys.exit(1)

    size_mb = os.path.getsize(audio_path) / (1024 * 1024)
    print(f"  📦 Tamaño   : {size_mb:.2f} MB")
    print(f"  🤖 Modelo   : {model_name}")
    print(f"  🌐 Idioma   : {lang_display}")
    print(f"  📂 Salida   : lrc/{lrc_name}")
    print()

    print(f"  ⏳ Cargando modelo '{model_name}'...")
    print(f"     (Primera vez descarga el modelo, luego es instantáneo)")
    print()

    model = whisper.load_model(model_name)

    print(f"  🔄 Transcribiendo... esto puede tardar según tu CPU/GPU y el tamaño del audio.")
    print()

    transcribe_kwargs = {
        "verbose": False,
        "fp16": False,
        "word_timestamps": word_mode,
        "condition_on_previous_text": True,
        "temperature": [0, 0.2, 0.4],       # escala de temperatura: usa 0 primero, sube si hay mucha repetición
        "compression_ratio_threshold": 1.8,  # más estricto: rechaza segmentos muy repetitivos
        "logprob_threshold": -1.0,
        "no_speech_threshold": 0.5,
    }

    if language:
        transcribe_kwargs["language"] = language

    result = model.transcribe(audio_path, **transcribe_kwargs)

    segments = result.get("segments", [])
    detected_lang = result.get("language", "desconocido")

    if not segments:
        print("❌ No se detectó audio con voz en el archivo.", file=sys.stderr)
        sys.exit(1)

    print(f"✅ {len(segments)} segmentos transcritos (sin procesar)")
    print(f"🌐 Idioma detectado: {detected_lang}")

    # ── Post-procesamiento inteligente ────────────────────────────────────────
    # Limpiar segmentos antes de construir el LRC
    for seg in segments:
        seg["text"] = clean_text(seg.get("text", ""))

    if HAS_POSTPROCESS:
        segments = postprocess_segments(segments, similarity_threshold=85)
    else:
        print("⚠️  Post-procesador no disponible. Instala: pip install rapidfuzz")

    # ── Construir líneas LRC ──────────────────────────────────────────────────
    title = os.path.splitext(os.path.basename(audio_path))[0]
    lrc_lines = [
        f"[ti:{title}]",
        f"[by:LyricSync — Whisper {model_name} | lang:{detected_lang}]",
        "",
    ]

    if word_mode:
        # Modo palabra a palabra
        for seg in segments:
            words = seg.get("words", [])
            for w in words:
                text = clean_text(w.get("word", ""))
                if text:
                    ts = to_lrc_timestamp(w["start"])
                    lrc_lines.append(f"[{ts}]{text}")
    else:
        # Modo segmento
        for seg in segments:
            text = seg["text"].strip()
            if not text:
                continue

            # Dividir segmentos muy largos para mejor sincronía visual
            parts = split_long_segment(text, seg["start"], seg["end"])
            for (t, part_text) in parts:
                ts = to_lrc_timestamp(t)
                lrc_lines.append(f"[{ts}]{part_text}")

    lrc_content = "\n".join(lrc_lines)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(lrc_content)

    # ── Reporte final ─────────────────────────────────────────────────────────
    lyric_count = len([l for l in lrc_lines if l.startswith("[") and not l.startswith("[ti") and not l.startswith("[by")])
    lrc_name = os.path.basename(output_path)

    print()
    print("  ──────────────────────────────────────────────────────")
    print(f"  🎉 ¡Transcripción completada!")
    print(f"  📂 Archivo  : lrc/{lrc_name}")
    print(f"  🎼 Líneas   : {lyric_count} líneas sincronizadas")
    print()
    print(f"  📋 Vista previa (primeras 8 líneas):")
    print("  ──────────────────────────────────────────────────────")
    count = 0
    for line in lrc_lines:
        if line.startswith("[") and not line.startswith("[ti") and not line.startswith("[by"):
            print(f"     {line}")
            count += 1
            if count >= 8:
                if lyric_count > 8:
                    print(f"     ... y {lyric_count - 8} líneas más")
                break
    print("  ──────────────────────────────────────────────────────")


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="LyricSync — Generador LRC con Whisper local (offline)",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("audio", help="Ruta al archivo de audio (.mp3, .wav, .m4a, .mp4, etc.)")
    parser.add_argument("--output", "-o", default=None,
                        help="Nombre del archivo .lrc de salida (default: mismo nombre que el audio)")
    parser.add_argument("--model", "-m", default="small",
                        choices=["tiny", "base", "small", "medium", "large"],
                        help=(
                            "Modelo Whisper a usar (default: small)\n"
                            "  tiny   → muy rápido, menos preciso\n"
                            "  base   → rápido, precisión media\n"
                            "  small  → buen balance calidad/velocidad ← recomendado\n"
                            "  medium → muy preciso, más lento\n"
                            "  large  → máxima calidad, lento"
                        ))
    parser.add_argument("--language", "-l", default=None,
                        help=(
                            "Forzar idioma (evita errores de detección)\n"
                            "  es → Español\n"
                            "  en → Inglés\n"
                            "  pt → Portugués\n"
                            "  fr → Francés\n"
                            "  (default: auto-detectar)"
                        ))
    parser.add_argument("--words", action="store_true",
                        help="Usar timestamps por PALABRA en lugar de por segmento (más preciso)")

    args = parser.parse_args()

    audio_path = args.audio
    output_path = args.output or (os.path.splitext(os.path.basename(audio_path))[0] + ".lrc")

    generate_lrc(
        audio_path=audio_path,
        output_path=output_path,
        model_name=args.model,
        language=args.language,
        word_mode=args.words,
    )
