"""
music_detector.py — LyricSync
Clasificador heurístico de secciones musicales.

Convierte etiquetas genéricas "(música)" en etiquetas contextuales:
  (intro), (coro), (instrumental), (interludio), (outro)

Uso:
    from music_detector import classify_sections
    classified = classify_sections(segments, total_duration)
"""

import re
from logger import get_logger

log = get_logger("music-detector")


def classify_sections(segments: list, total_duration: float) -> list:
    """
    Clasifica cada segmento que contiene "(música)" en una etiqueta
    contextual basada en heurísticas de posición, duración y contexto.

    Args:
        segments: Lista de dicts con 'start', 'end', 'text'
        total_duration: Duración total del audio en segundos

    Returns:
        Lista de segmentos con etiquetas clasificadas
    """
    if not segments or total_duration <= 0:
        return segments

    music_count = 0

    for i, seg in enumerate(segments):
        text = seg.get("text", "").strip()

        # Solo procesar segmentos que son etiqueta de música
        if not re.match(r'^\s*\(m[uú]sica\)\s*$', text, re.IGNORECASE):
            continue

        music_count += 1
        start = seg.get("start", 0)
        end = seg.get("end", start)
        duration = end - start
        position_pct = start / total_duration if total_duration > 0 else 0

        # ─── Heurísticas de clasificación ─────────────────────────────

        # 1. INTRO: primeros 10% o antes de la primera letra cantada
        if position_pct < 0.10:
            label = "intro"

        # 2. OUTRO: últimos 8% del audio
        elif position_pct > 0.92:
            label = "outro"

        # 3. INSTRUMENTAL: sección larga (>12s) sin voz
        elif duration > 12:
            label = "instrumental"

        # 4. Interludio vs Coro: depende del contexto
        else:
            # Verificar si hay repetición de frases antes/después (patrón de coro)
            is_between_similar = _check_chorus_context(segments, i)
            if is_between_similar:
                label = "coro"
            else:
                label = "interludio"

        seg["text"] = f"({label})"
        log.debug(f"Sección clasificada: [{start:.1f}s, pos={position_pct:.0%}, dur={duration:.1f}s] → ({label})")

    if music_count > 0:
        log.info(f"Secciones musicales clasificadas: {music_count}")

    return segments


def _check_chorus_context(segments: list, music_idx: int) -> bool:
    """
    Verifica si la sección musical está entre frases similares
    (patrón de coro: verso → música → verso repetido).
    """
    # Buscar la última frase cantada antes de esta sección musical
    before_text = None
    for j in range(music_idx - 1, max(music_idx - 4, -1), -1):
        if j < 0:
            break
        t = segments[j].get("text", "").strip()
        if t and not re.match(r'^\s*\(', t):
            before_text = t.lower()
            break

    # Buscar la primera frase cantada después
    after_text = None
    for j in range(music_idx + 1, min(music_idx + 4, len(segments))):
        t = segments[j].get("text", "").strip()
        if t and not re.match(r'^\s*\(', t):
            after_text = t.lower()
            break

    if not before_text or not after_text:
        return False

    # Comparar: si las frases de antes y después son similares → es coro
    # Usar comparación simple de primeras palabras
    before_words = before_text.split()[:4]
    after_words = after_text.split()[:4]

    if before_words == after_words:
        return True

    # Comparar las primeras 3 palabras
    if len(before_words) >= 3 and len(after_words) >= 3:
        if before_words[:3] == after_words[:3]:
            return True

    return False
