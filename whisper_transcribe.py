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

import stable_whisper as whisper
import torch
import sys
import os
import re
import argparse
import shutil
import math


# ──────────────────────────────────────────────────────────────────────────────
# Detección de GPU
# ──────────────────────────────────────────────────────────────────────────────

def detect_device() -> tuple[str, str]:
    """
    Detecta automáticamente si hay GPU CUDA disponible.
    Returns: (device, device_name)
      - ("cuda", "NVIDIA GeForce RTX 5070 Laptop GPU") si hay GPU
      - ("cpu", "CPU") si no hay GPU
    """
    if torch.cuda.is_available():
        name = torch.cuda.get_device_name(0)
        return "cuda", name
    return "cpu", "CPU"


def is_model_downloaded(model_name: str) -> bool:
    """Verifica si el modelo Whisper ya está en la caché local."""
    import importlib
    download_root = os.getenv(
        "XDG_CACHE_HOME", 
        os.path.join(os.path.expanduser("~"), ".cache", "whisper")
    )
    
    try:
        openai_whisper = importlib.import_module("whisper")
        url = openai_whisper._MODELS.get(model_name)
    except Exception:
        return False
        
    if not url:
        return False
        
    expected_filename = url.split("/")[-1]
    model_path = os.path.join(download_root, expected_filename)
    return os.path.exists(model_path)

from logger import get_logger
from lyric_config import get_config

log = get_logger("whisper")

# Importar post-procesador de letras
try:
    # Autoinstalar rapidfuzz si no existe
    import rapidfuzz
except ImportError:
    import subprocess
    print("  ⚠️  Falta la librería 'rapidfuzz' para el post-procesador.")
    print("  ⏳ Instalando automáticamente... esto tomará unos segundos.")
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "rapidfuzz", "--quiet"])
        print("  ✅ Instalación de 'rapidfuzz' completada.\n")
    except Exception as e:
        print(f"  ❌ Fallo instalando rapidfuzz automáticamente: {e}")

try:
    from lyrics_postprocess import postprocess_segments
    HAS_POSTPROCESS = True
except ImportError:
    HAS_POSTPROCESS = False

# ──────────────────────────────────────────────────────────────────────────────
# Prompts optimizados por idioma (positivos, sin negaciones que causen alucinaciones)
# ──────────────────────────────────────────────────────────────────────────────

INITIAL_PROMPTS = {
    "es": "Letra de canción en español. Transcripción precisa de la voz cantada.",
    "en": "Song lyrics in English. Precise transcription of singing voice.",
    "pt": "Letra de música em português. Transcrição precisa da voz cantada.",
    "fr": "Paroles de chanson en français. Transcription précise de la voix chantée.",
    "it": "Testo della canzone in italiano. Trascrizione precisa della voce cantata.",
    "de": "Songtext auf Deutsch. Präzise Transkription der Gesangsstimme.",
}

# ──────────────────────────────────────────────────────────────────────────────
# Utilidades
# ──────────────────────────────────────────────────────────────────────────────

def to_lrc_timestamp(seconds: float) -> str:
    """Convierte segundos a formato LRC [MM:SS.xx]"""
    minutes = int(seconds // 60)
    secs = seconds % 60
    return f"{minutes:02d}:{secs:05.2f}"


def clean_text(text: str, lang: str = "auto") -> str:
    """
    Limpia el texto transcrito:
    - Normaliza marcadores a "(música)"
    - Elimina caracteres asiáticos/rusos si el idioma es español/inglés para prevenir alucinaciones de ruido.
    """
    # 1. Normalizar etiquetas de música (Whisper suele arrojar [Music], Música, (musica), etc.)
    music_tags = r"(?i)(\[\s*music\s*\]|\(\s*música\s*\)|\[\s*música\s*\]|\bMúsica\b|\bMusica\b|♪)"
    text = re.sub(music_tags, "(música)", text)

    # 2. Limpiar texto residual después de etiquetas de música
    #    "(música) de cierre." → "(música)"
    #    "(música) instrumental." → "(música)"
    text = re.sub(
        r'\(música\)\s*'
        r'(de\s+cierre|instrumental|de\s+fondo|de\s+salida|de\s+entrada'
        r'|de\s+intro|de\s+outro|de\s+apertura|de\s+transición'
        r'|suave|lenta|rápida|alegre|triste)'
        r'[.!,;]*',
        '(música)',
        text,
        flags=re.IGNORECASE
    )

    # 2b. Caso genérico: si la línea es SOLO "(música)" + texto muy corto (≤20 chars), simplificar
    music_residual = re.match(r'^\s*\(música\)\s+(.{1,20})\s*$', text, re.IGNORECASE)
    if music_residual:
        residual = music_residual.group(1).strip().rstrip('.')
        # Si el residual no parece ser letra cantada (muy corto, sin verbos, parece descriptor)
        residual_words = residual.split()
        if len(residual_words) <= 3:
            text = '(música)'

    # 3. Eliminar otras notas extrañas entre corchetes o paréntesis que no sean música (aplausos, etc.)
    text = re.sub(r"\[(?!\s*música\s*).*?\]", "", text, flags=re.IGNORECASE)
    
    # Filtros anti-alucinación por idioma
    if lang in ["es", "en", "pt", "fr", "it", "de", "auto"]:
        # Remover puros caracteres chinos/japoneses/coreanos etc (muy comunes en alucinaciones de Cumbia/ruido)
        # Retiene típicamente caracteres latinos, números y puntuaciones.
        text = re.sub(r'[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]', '', text)

    # Quitar alucinaciones inducidas por prompts anteriores
    text = re.sub(r'(?i)no\s*\(música\)\s*instrumental\.?|música\s*instrumental', '', text)

    # Autocorrecciones comunes si es español
    if lang == "es":
        text = text.replace("Frankamente", "Francamente").replace("frankamente", "francamente")
        text = text.replace("ruil", "ruin")

    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


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

# ──────────────────────────────────────────────────────────────────────────────
# Evaluación de calidad
# ──────────────────────────────────────────────────────────────────────────────

def compute_quality_score(segments: list) -> dict:
    """
    Calcula score de calidad 0-100 basado en:
    - avg_logprob de cada segmento (confianza del modelo)
    - no_speech_prob (probabilidad de que NO haya voz)
    """
    total_confidence = 0
    total_segments = len(segments)
    low_confidence = 0

    for seg in segments:
        logprob = seg.get("avg_logprob", -1.0)
        no_speech = seg.get("no_speech_prob", 0.0)

        # Convertir logprob a score 0-1 (logprob típico: -0.2 excelente, -1.5 malo)
        seg_score = min(1.0, max(0.0, 1.0 + logprob))

        # Penalizar si no_speech_prob es alto
        seg_score *= (1.0 - no_speech)

        total_confidence += seg_score
        if seg_score < 0.5:
            low_confidence += 1

    avg_confidence = (total_confidence / max(total_segments, 1)) * 100

    return {
        "overall_score": round(avg_confidence, 1),
        "total_segments": total_segments,
        "low_confidence_segments": low_confidence,
        "low_confidence_pct": round(low_confidence / max(total_segments, 1) * 100, 1),
    }


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
    cfg = get_config()

    # ── Header ─────────────────────────────────────────────────────────────────
    basename = os.path.basename(audio_path)
    lrc_name = os.path.basename(output_path)
    lang_display = language if language else "auto"

    term_width = shutil.get_terminal_size((100, 20)).columns
    inner_width = min(max(term_width - 6, 60), 140)

    print()
    print("  ╭" + "─" * (inner_width - 2) + "╮")
    print("  │  ✨ MOTOR WHISPER IA — TRANSCRIPCION A LRC OFFLINE".ljust(inner_width, ' ') + "│")
    print("  ╰" + "─" * (inner_width - 2) + "╯")
    print()
    print(f"  💿 Archivo  : {basename}")

    if not os.path.exists(audio_path):
        log.error(f"No se encontró el archivo: {audio_path}")
        print(f"\n  ❌ No se encontró el archivo: {audio_path}", file=sys.stderr)
        print(f"     Verifica que la ruta sea correcta.\n", file=sys.stderr)
        sys.exit(1)

    size_mb = os.path.getsize(audio_path) / (1024 * 1024)
    print(f"  📦 Tamaño   : {size_mb:.2f} MB")
    print(f"  🤖 Modelo   : {model_name}")
    print(f"  🌐 Idioma   : {lang_display}")
    print(f"  📂 Salida   : lrc/{lrc_name}")
    print("  " + "─" * inner_width)
    print()

    # ── Detectar dispositivo (GPU/CPU) ─────────────────────────────────────────
    device, device_name = detect_device()
    use_fp16 = (device == "cuda")  # fp16 solo funciona en GPU

    if device == "cuda":
        vram_mb = torch.cuda.get_device_properties(0).total_memory // (1024 * 1024)
        print(f"  🚀 GPU       : {device_name} ({vram_mb} MB VRAM)")
        print(f"  ⚡ Precisión  : FP16 (aceleración GPU)")
    else:
        print(f"  💻 Dispositivo: CPU (sin GPU detectada)")
        print(f"  ⚠️  Tip: instala PyTorch con CUDA para acelerar 5-10x")

    log.info(f"Iniciando transcripción: {basename} [modelo={model_name}, lang={lang_display}, device={device}]")
    print(f"  ⏳ Cargando modelo '{model_name}' en {device.upper()}...")
    if not is_model_downloaded(model_name):
        print(f"     ℹ️  Parece ser la primera vez que usas este modelo. Se descargará automáticamente, espera...")
    print()

    model = whisper.load_model(model_name, device=device)
    log.info(f"Modelo '{model_name}' cargado en {device} [{device_name}]")

    print(f"  🔄 Transcribiendo (Corriendo modelo IA seleccionado)... ")
    print(f"     ⚠️ Esto puede tardar desde segundos hasta minutos dependiendo de tu cpu/gpu, modelo elegido y tamaño del archivo.")
    print()

    # Seleccionar prompt por idioma (positivo, sin negaciones que causen alucinaciones)
    lang_key = language if language else "es"
    initial_prompt = INITIAL_PROMPTS.get(lang_key, INITIAL_PROMPTS.get("default", ""))

    # Leer parámetros de config.yaml (con fallbacks hardcoded)
    wcfg = cfg.get("whisper", {})
    transcribe_kwargs = {
        "verbose": False,
        "fp16": use_fp16,  # True en GPU (FP16 = 2x más rápido), False en CPU
        "word_timestamps": wcfg.get("word_timestamps", True),
        "condition_on_previous_text": wcfg.get("condition_on_previous_text", False),
        "vad": wcfg.get("vad", False),
        "temperature": tuple(wcfg.get("temperature", [0.0, 0.1, 0.2, 0.4])),
        "initial_prompt": initial_prompt,
        "no_speech_threshold": wcfg.get("no_speech_threshold", 0.55),
        "compression_ratio_threshold": wcfg.get("compression_ratio_threshold", 2.8),
        "beam_size": wcfg.get("beam_size", 8),
    }

    if language:
        transcribe_kwargs["language"] = language

    # stable-ts devuelve un objeto WhisperResult
    result_obj = model.transcribe(audio_path, **transcribe_kwargs)

    # Post-realineamiento: refinar timestamps contra silencios reales del audio
    try:
        result_obj.adjust_by_silence(
            audio_path,
            q_levels=20,
            k_size=5
        )
        print("  ✅ Realineamiento por silencios aplicado")
    except Exception as e:
        print(f"  ⚠️  Realineamiento por silencios omitido: {e}")

    result = result_obj.to_dict()

    segments = result.get("segments", [])
    detected_lang = result.get("language", "desconocido")

    if not segments:
        log.error("No se detectó audio con voz en el archivo")
        print("❌ No se detectó audio con voz en el archivo.", file=sys.stderr)
        sys.exit(1)

    log.info(f"{len(segments)} segmentos transcritos [idioma={detected_lang}]")
    print(f"✅ {len(segments)} segmentos transcritos exitosamente (Alineamiento maestro)")
    print(f"🌐 Idioma detectado: {detected_lang}")

    # ── Evaluación de calidad ─────────────────────────────────────────────────
    quality = compute_quality_score(segments)
    log.info(f"Score de calidad: {quality['overall_score']}% [baja_confianza={quality['low_confidence_pct']}%]")

    # ── Post-procesamiento inteligente ────────────────────────────────────────
    # Limpiar segmentos antes de construir el LRC
    for seg in segments:
        seg["text"] = clean_text(seg.get("text", ""), detected_lang)

    pcfg = cfg.get("postprocess", {})
    sim_threshold = pcfg.get("similarity_threshold", 85)

    if HAS_POSTPROCESS:
        segments = postprocess_segments(segments, similarity_threshold=sim_threshold)
    else:
        log.warn("Post-procesador no disponible (falta rapidfuzz)")
        print("⚠️  Post-procesador no pudo ser cargado (falla al importar rapidfuzz).")

    # ── Detección musical (clasificar secciones) ─────────────────────────────
    try:
        from music_detector import classify_sections
        # Estimar duración total
        total_dur = segments[-1].get("end", 0) if segments else 0
        segments = classify_sections(segments, total_dur)
    except ImportError:
        log.warn("music_detector no disponible, secciones no clasificadas")

    # ── Construir líneas LRC ──────────────────────────────────────────────────
    title = os.path.splitext(os.path.basename(audio_path))[0]
    lrc_lines = [
        f"[ti:{title}]",
        f"[by:LyricSync — Whisper {model_name} | lang:{detected_lang}]",
        "",
    ]

    # Construir lrc: el script decidirá armarlo por palabras o guiarse por segmentos precalculados
    # para armar el formato final basado en lo que el menú prefiera
    if word_mode:
        # Modo palabra a palabra
        for seg in segments:
            words = seg.get("words", [])
            for w in words:
                text = clean_text(w.get("word", ""), detected_lang)
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

    term_width = shutil.get_terminal_size((100, 20)).columns
    inner_width = min(max(term_width - 6, 60), 140)

    log.info(f"LRC generado: {lrc_name} [{lyric_count} líneas]")

    print()
    print("  ╭" + "─" * (inner_width - 2) + "╮")
    print("  │  🎉 MATRIZ LRC GENERADA SATISFACTORIAMENTE".ljust(inner_width, ' ') + "│")
    print("  ╰" + "─" * (inner_width - 2) + "╯")
    print(f"   📂 Archivo : lrc/{lrc_name}")
    print(f"   🎼 Líneas  : {lyric_count} líneas sincronizadas")
    print()

    # ── Reporte de calidad ────────────────────────────────────────────────────
    score_icon = "🟢" if quality['overall_score'] >= 80 else "🟡" if quality['overall_score'] >= 60 else "🔴"
    print(f"  ╭─── Reporte de Calidad " + "─" * max(0, inner_width - 28) + "╮")
    print(f"  │ {score_icon} Score de Confianza  : {quality['overall_score']}%")
    print(f"  │ 📊 Segmentos totales   : {quality['total_segments']}")
    if quality['low_confidence_segments'] > 0:
        print(f"  │ ⚠️  Baja confianza     : {quality['low_confidence_segments']} ({quality['low_confidence_pct']}%)")
    print(f"  ╰" + "─" * (inner_width) + "╯")
    print()

    print(f"   📋 Resumen (primeras 8 líneas ancladas):")
    print("  " + "─" * inner_width)
    count = 0
    for line in lrc_lines:
        if line.startswith("[") and not line.startswith("[ti") and not line.startswith("[by"):
            print(f"     {line}")
            count += 1
            if count >= 8:
                if lyric_count > 8:
                    print(f"     ... y {lyric_count - 8} líneas más")
                break
    print("  " + "─" * inner_width)


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
                            "  tiny   -> muy rápido, menos preciso\n"
                            "  base   -> rápido, precisión media\n"
                            "  small  -> buen balance calidad/velocidad <- recomendado\n"
                            "  medium -> muy preciso, más lento\n"
                            "  large  -> máxima calidad, lento"
                        ))
    parser.add_argument("--language", "-l", default=None,
                        help=(
                            "Forzar idioma (evita errores de detección)\n"
                            "  es -> Español\n"
                            "  en -> Inglés\n"
                            "  pt -> Portugués\n"
                            "  fr -> Francés\n"
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
