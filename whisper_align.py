#!/usr/bin/env python3
"""
whisper_align.py — LyricSync
Forced Alignment: sincroniza una letra existente con el audio.

Mucho más rápido que transcribir desde cero porque el modelo ya
conoce las palabras — solo necesita alinear los timestamps.

Uso:
    python whisper_align.py audio.mp3 --lyrics letra.txt --language es
    python whisper_align.py audio.mp3 --lyrics letra.txt --output aligned.lrc

Uso como módulo:
    from whisper_align import align_lyrics
    align_lyrics("audio.mp3", "texto de la letra...", "output.lrc")
"""

import stable_whisper as whisper
import torch
import sys
import os
import re
import argparse
import shutil

from logger import get_logger
from lyric_config import get_config
from whisper_transcribe import detect_device, is_model_downloaded

log = get_logger("align")


def to_lrc_timestamp(seconds: float) -> str:
    """Convierte segundos a formato LRC [MM:SS.xx]"""
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes:02d}:{secs:05.2f}"


def align_lyrics(
    audio_path: str,
    lyrics_text: str,
    output_path: str,
    model_name: str = "base",
    language: str = "es",
):
    """
    Toma un audio + letra existente y genera un .lrc perfectamente sincronizado.

    Args:
        audio_path: Ruta al archivo de audio
        lyrics_text: Texto de la letra (líneas separadas por \\n)
        output_path: Ruta del archivo .lrc de salida
        model_name: Modelo Whisper a usar (base recomendado, es suficiente para alineación)
        language: Código de idioma
    """
    cfg = get_config()

    # ── Header ─────────────────────────────────────────────────────────────────
    basename = os.path.basename(audio_path)
    lrc_name = os.path.basename(output_path)

    term_width = shutil.get_terminal_size((100, 20)).columns
    inner_width = min(max(term_width - 6, 60), 140)

    print()
    print("  ╭" + "─" * (inner_width - 2) + "╮")
    print("  │  🎯 FORCED ALIGNMENT — SINCRONIZACIÓN CON LETRA EXISTENTE".ljust(inner_width, ' ') + "│")
    print("  ╰" + "─" * (inner_width - 2) + "╯")
    print()
    print(f"  💿 Archivo  : {basename}")

    if not os.path.exists(audio_path):
        log.error(f"No se encontró el archivo: {audio_path}")
        print(f"\n  ❌ No se encontró el archivo: {audio_path}", file=sys.stderr)
        sys.exit(1)

    size_mb = os.path.getsize(audio_path) / (1024 * 1024)
    line_count = len([l for l in lyrics_text.strip().split("\n") if l.strip()])

    print(f"  📦 Tamaño   : {size_mb:.2f} MB")
    print(f"  🤖 Modelo   : {model_name} (alineación)")
    print(f"  🌐 Idioma   : {language}")
    print(f"  📝 Líneas   : {line_count} líneas de letra")
    print(f"  📂 Salida   : {lrc_name}")
    print("  " + "─" * inner_width)
    print()

    # ── Detectar GPU ──────────────────────────────────────────────────────────
    device, device_name = detect_device()
    if device == "cuda":
        print(f"  🚀 GPU       : {device_name}")
    else:
        print(f"  💻 Dispositivo: CPU")

    log.info(f"Cargando modelo '{model_name}' en {device} para alineación...")
    print(f"  ⏳ Cargando modelo '{model_name}' en {device.upper()}...")
    if not is_model_downloaded(model_name):
        print(f"     ℹ️  Parece ser la primera vez que usas este modelo. Se descargará automáticamente, espera...")
    
    model = whisper.load_model(model_name, device=device)

    # ── Forced Alignment ───────────────────────────────────────────────────────
    log.info("Ejecutando forced alignment (stable-ts model.align)...")
    print(f"  🔄 Alineando letra con audio...")
    print(f"     ℹ️  Esto es más rápido que transcribir desde cero.")
    print()

    try:
        result = model.align(audio_path, lyrics_text, language=language)
    except Exception as e:
        log.error(f"Fallo en forced alignment: {e}")
        print(f"\n  ❌ Error durante la alineación: {e}", file=sys.stderr)
        sys.exit(1)

    # ── Post-realineamiento por silencios ───────────────────────────────────────
    if cfg["whisper"].get("adjust_by_silence", True):
        try:
            result.adjust_by_silence(audio_path, q_levels=20, k_size=5)
            log.info("Realineamiento por silencios aplicado")
            print("  ✅ Realineamiento por silencios aplicado")
        except Exception as e:
            log.warn(f"Realineamiento por silencios omitido: {e}")

    # ── Construir LRC ──────────────────────────────────────────────────────────
    result_dict = result.to_dict()
    segments = result_dict.get("segments", [])

    title = os.path.splitext(os.path.basename(audio_path))[0]
    lrc_lines = [
        f"[ti:{title}]",
        f"[by:LyricSync — Forced Alignment ({model_name}) | lang:{language}]",
        "",
    ]

    for seg in segments:
        text = seg.get("text", "").strip()
        if not text:
            continue
        ts = to_lrc_timestamp(seg["start"])
        lrc_lines.append(f"[{ts}]{text}")

    lrc_content = "\n".join(lrc_lines)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(lrc_content)

    # ── Reporte ────────────────────────────────────────────────────────────────
    lyric_count = len([l for l in lrc_lines if l.startswith("[") and not l.startswith("[ti") and not l.startswith("[by")])

    log.info(f"Alineación completada: {lyric_count} líneas sincronizadas → {lrc_name}")

    print()
    print("  ╭" + "─" * (inner_width - 2) + "╮")
    print("  │  🎉 ALINEACIÓN COMPLETADA SATISFACTORIAMENTE".ljust(inner_width, ' ') + "│")
    print("  ╰" + "─" * (inner_width - 2) + "╯")
    print(f"   📂 Archivo : {lrc_name}")
    print(f"   🎼 Líneas  : {lyric_count} líneas sincronizadas")
    print(f"   ⚡ Método  : Forced Alignment (mucho más preciso que transcripción)")
    print()


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="LyricSync — Forced Alignment: sincronizar letra existente con audio",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("audio", help="Ruta al archivo de audio (.mp3, .wav, .m4a, etc.)")
    parser.add_argument("--lyrics", "-t", required=True,
                        help="Ruta al archivo de texto con la letra (.txt)")
    parser.add_argument("--output", "-o", default=None,
                        help="Nombre del archivo .lrc de salida (default: mismo nombre que audio)")
    parser.add_argument("--model", "-m", default="base",
                        choices=["tiny", "base", "small", "medium", "large"],
                        help=(
                            "Modelo Whisper para alineación (default: base)\n"
                            "  base recomendado — suficiente para alineación\n"
                            "  Modelos más grandes no mejoran significativamente"
                        ))
    parser.add_argument("--language", "-l", default="es",
                        help="Código de idioma: es, en, pt, fr... (default: es)")

    args = parser.parse_args()

    # Leer texto de la letra
    if not os.path.exists(args.lyrics):
        print(f"\n  ❌ No se encontró el archivo de letra: {args.lyrics}", file=sys.stderr)
        sys.exit(1)

    with open(args.lyrics, "r", encoding="utf-8") as f:
        lyrics_text = f.read()

    if not lyrics_text.strip():
        print(f"\n  ❌ El archivo de letra está vacío: {args.lyrics}", file=sys.stderr)
        sys.exit(1)

    output_path = args.output or (os.path.splitext(os.path.basename(args.audio))[0] + ".lrc")

    align_lyrics(
        audio_path=args.audio,
        lyrics_text=lyrics_text,
        output_path=output_path,
        model_name=args.model,
        language=args.language,
    )
