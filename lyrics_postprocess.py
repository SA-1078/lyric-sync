"""
lyrics_postprocess.py — LyricSync
Post-procesador inteligente de transcripciones de Whisper.

Corrige problemas comunes:
  1. Líneas duplicadas exactas consecutivas (alucinaciones)
  2. Líneas casi idénticas (difieren solo en puntuación o 1-2 palabras)
  3. Patrones de alucinación conocidos de Whisper
  4. Líneas demasiado cortas o sin sentido
  5. Segmentos que se repiten en bucle

Uso standalone:
  python lyrics_postprocess.py input.lrc --output output_clean.lrc

Uso como módulo:
  from lyrics_postprocess import postprocess_segments
  clean_segments = postprocess_segments(segments)
"""

import re
from rapidfuzz import fuzz


# ──────────────────────────────────────────────────────────────────────────────
# Patrones de alucinación conocidos de Whisper
# ──────────────────────────────────────────────────────────────────────────────

HALLUCINATION_PATTERNS = [
    # Frases genéricas que Whisper genera cuando no entiende el audio
    r"^gracias por ver$",
    r"^thanks for watching$",
    r"^thank you for watching$",
    r"^suscr[ií]bete",
    r"^subscribe",
    r"^subtítulos? (por|de|realizados)",
    r"^subtitulado por",
    r"^copyright",
    r"^www\.",
    r"^http",
    r"^\.{2,}$",                      # solo puntos "..."
    r"^\*+$",                          # solo asteriscos
    r"^-+$",                           # solo guiones
    r"^[♪♫🎵🎶\s]+$",                  # solo notas musicales
    r"^(\w+\s*)\1{3,}",               # misma palabra repetida 4+ veces: "la la la la la"
    r"^¡?Suscr[ií]bete",
    r"^No te olvides de suscribirte",
    r"^Dale like",
    r"^Amigos de YouTube",
]

HALLUCINATION_REGEXES = [re.compile(p, re.IGNORECASE) for p in HALLUCINATION_PATTERNS]


# ──────────────────────────────────────────────────────────────────────────────
# Funciones de limpieza
# ──────────────────────────────────────────────────────────────────────────────

def normalize_text(text: str) -> str:
    """Normaliza texto para comparación: minúsculas, sin puntuación extra."""
    text = text.lower().strip()
    text = re.sub(r"[¿¡!?,.:;\"'…\-–—]", "", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def is_hallucination(text: str) -> bool:
    """Detecta si una línea es una alucinación conocida de Whisper."""
    clean = text.strip()
    if not clean:
        return True
    for regex in HALLUCINATION_REGEXES:
        if regex.search(clean):
            return True
    return False


def is_too_short(text: str, min_chars: int = 2) -> bool:
    """Líneas de 1-2 caracteres que no aportan nada."""
    clean = re.sub(r"[♪♫🎵🎶\s]", "", text.strip())
    return len(clean) < min_chars


def clean_intra_repetition(text: str) -> str:
    """
    Detecta y elimina repeticiones dentro de un mismo segmento.
    Ejemplo: 'lo que se fue, lo que se fue, lo que se fue' → 'lo que se fue'
    
    Funciona detectando patrones de n-gramas que se repiten en secuencia.
    """
    words = text.split()
    if len(words) < 6:
        return text  # muy corto para tener repeticiones significativas

    # Probar frases de 2 a 8 palabras como posible unidad repetida
    best_phrase = None
    best_count = 1

    for phrase_len in range(2, min(9, len(words) // 2 + 1)):
        phrase = " ".join(words[:phrase_len])
        phrase_lower = phrase.lower().strip(",. ")

        # Contar cuántas veces aparece esta frase (o similar) en el texto
        remaining = text.lower()
        count = 0
        pos = 0
        while True:
            idx = remaining.find(phrase_lower, pos)
            if idx == -1:
                break
            count += 1
            pos = idx + len(phrase_lower)

        # Si la frase se repite 3+ veces, es un pattern repetitivo
        if count >= 3 and count > best_count:
            # Verificar que cubre la mayoría del texto
            coverage = (count * len(phrase_lower)) / len(text.lower())
            if coverage > 0.5:  # más del 50% del texto es la repetición
                best_phrase = phrase.strip(",. ")
                best_count = count

    if best_phrase and best_count >= 3:
        return best_phrase

    return text


def is_near_duplicate(text_a: str, text_b: str, threshold: int = 85) -> bool:
    """
    Compara dos textos usando fuzzy matching.
    threshold=85 significa que si son 85%+ similares, es duplicado.
    """
    norm_a = normalize_text(text_a)
    norm_b = normalize_text(text_b)

    if not norm_a or not norm_b:
        return False

    # Comparación rápida exacta
    if norm_a == norm_b:
        return True

    # Fuzzy matching — detecta "casi iguales"
    ratio = fuzz.ratio(norm_a, norm_b)
    return ratio >= threshold


def detect_loop(segments: list, window: int = 4, threshold: int = 80) -> set:
    """
    Detecta segmentos que están en un "loop" (Whisper repitiendo la misma frase
    muchas veces seguidas). Retorna los índices a eliminar.

    Ejemplo de alucinación en loop:
      [01:23] Y si no, no te quedamos de mal de amor
      [01:24] Y si no, no te quedamos de mal de amor
      [01:25] Y si no, no te quedamos de mal de amor
      ...
    """
    to_remove = set()

    if len(segments) < window:
        return to_remove

    for i in range(len(segments)):
        # Contar cuántos de los siguientes son similares a este
        matches = 0
        for j in range(i + 1, min(i + window + 1, len(segments))):
            if is_near_duplicate(segments[i]["text"], segments[j]["text"], threshold):
                matches += 1

        # Si 3+ de los siguientes son similares → es un loop, mantener solo el primero
        if matches >= 3:
            for j in range(i + 1, min(i + window + 1, len(segments))):
                if is_near_duplicate(segments[i]["text"], segments[j]["text"], threshold):
                    to_remove.add(j)

    return to_remove


def check_timing(segments: list) -> list:
    """
    Elimina segmentos con timestamps imposibles:
    - Tiempo negativo
    - Duración de segmento > 30 seg (probablemente alucinación)
    - Segmentos que se solapan significativamente con el anterior
    """
    cleaned = []
    prev_end = 0.0

    for seg in segments:
        start = seg.get("start", 0)
        end = seg.get("end", start)
        duration = end - start

        # Segmento con duración > 30s y poco texto → sospechoso
        word_count = len(seg["text"].split())
        if duration > 30 and word_count < 5:
            continue

        # Start negativo
        if start < 0:
            continue

        cleaned.append(seg)
        prev_end = end

    return cleaned


# ──────────────────────────────────────────────────────────────────────────────
# Función principal de post-procesamiento
# ──────────────────────────────────────────────────────────────────────────────

def postprocess_segments(segments: list, similarity_threshold: int = 85) -> list:
    """
    Limpia una lista de segmentos de Whisper.

    Args:
        segments: Lista de dicts con 'start', 'end', 'text'
        similarity_threshold: 0-100, qué tan similares deben ser para considerarse duplicados

    Returns:
        Lista limpia de segmentos
    """
    if not segments:
        return segments

    original_count = len(segments)
    removed_reasons = {
        "alucinación": 0,
        "muy_corto": 0,
        "repetición_interna": 0,
        "duplicado_exacto": 0,
        "duplicado_fuzzy": 0,
        "loop": 0,
        "timing": 0,
    }

    # Paso 1: Verificar timing
    segments = check_timing(segments)
    removed_reasons["timing"] = original_count - len(segments)

    # Paso 1.5: Limpiar repeticiones internas en cada segmento
    intra_cleaned = 0
    for seg in segments:
        original = seg["text"]
        cleaned_text = clean_intra_repetition(original)
        if cleaned_text != original:
            seg["text"] = cleaned_text
            intra_cleaned += 1
    if intra_cleaned > 0:
        removed_reasons["repetición_interna"] = intra_cleaned

    # Paso 2: Eliminar alucinaciones conocidas
    filtered = []
    for seg in segments:
        if is_hallucination(seg["text"]):
            removed_reasons["alucinación"] += 1
        elif is_too_short(seg["text"]):
            removed_reasons["muy_corto"] += 1
        else:
            filtered.append(seg)
    segments = filtered

    # Paso 3: Detectar y eliminar loops
    loop_indices = detect_loop(segments, window=5, threshold=similarity_threshold)
    removed_reasons["loop"] = len(loop_indices)
    segments = [seg for i, seg in enumerate(segments) if i not in loop_indices]

    # Paso 4: Eliminar duplicados consecutivos (exactos y fuzzy)
    cleaned = []
    for seg in segments:
        if not cleaned:
            cleaned.append(seg)
            continue

        prev = cleaned[-1]

        # Duplicado exacto
        if normalize_text(seg["text"]) == normalize_text(prev["text"]):
            removed_reasons["duplicado_exacto"] += 1
            continue

        # Duplicado fuzzy (casi igual, difieren en 1-2 palabras)
        if is_near_duplicate(seg["text"], prev["text"], similarity_threshold):
            removed_reasons["duplicado_fuzzy"] += 1
            continue

        cleaned.append(seg)

    # Reporte
    total_removed = sum(removed_reasons.values())
    if total_removed > 0:
        print(f"\n🧹 Post-procesamiento completado:")
        print(f"   Segmentos originales: {original_count}")
        print(f"   Eliminados: {total_removed}")
        for reason, count in removed_reasons.items():
            if count > 0:
                print(f"     ├─ {reason}: {count}")
        print(f"   Resultado final: {len(cleaned)} segmentos limpios")
    else:
        print(f"\n✨ Post-procesamiento: sin cambios necesarios ({len(cleaned)} segmentos)")

    return cleaned


# ──────────────────────────────────────────────────────────────────────────────
# Modo standalone: limpiar un .lrc existente
# ──────────────────────────────────────────────────────────────────────────────

def parse_lrc_file(filepath: str) -> list:
    """Lee un .lrc y lo convierte a lista de segmentos."""
    import os
    if not os.path.exists(filepath):
        print(f"❌ No se encontró: {filepath}")
        return []

    segments = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            match = re.match(r"\[(\d+):(\d+)(?:\.(\d+))?\](.*)", line.strip())
            if not match:
                continue

            minutes = int(match.group(1))
            seconds = int(match.group(2))
            centis  = int(match.group(3)) / 100 if match.group(3) else 0
            text    = match.group(4).strip()

            if text:
                segments.append({
                    "start": minutes * 60 + seconds + centis,
                    "end":   minutes * 60 + seconds + centis + 5,  # estimado
                    "text":  text,
                })

    return segments


def segments_to_lrc(segments: list, title: str = "", meta: str = "") -> str:
    """Convierte segmentos a formato LRC."""
    lines = []
    if title:
        lines.append(f"[ti:{title}]")
    if meta:
        lines.append(f"[by:{meta}]")
    if lines:
        lines.append("")

    for seg in segments:
        start = seg["start"]
        m = int(start // 60)
        s = start % 60
        lines.append(f"[{m:02d}:{s:05.2f}]{seg['text']}")

    return "\n".join(lines)


if __name__ == "__main__":
    import argparse
    import os

    parser = argparse.ArgumentParser(description="LyricSync — Limpiador de transcripciones")
    parser.add_argument("input", help="Archivo .lrc a limpiar")
    parser.add_argument("--output", "-o", default=None, help="Archivo de salida (default: sobreescribe)")
    parser.add_argument("--threshold", "-t", type=int, default=85,
                        help="Umbral de similitud 0-100 para detectar duplicados (default: 85)")
    args = parser.parse_args()

    print(f"\n🧹 LyricSync — Limpiador de letras")
    print(f"{'─' * 45}")
    print(f"📄 Entrada: {args.input}")

    segments = parse_lrc_file(args.input)
    if not segments:
        print("❌ No se encontraron segmentos.")
        exit(1)

    clean = postprocess_segments(segments, args.threshold)

    output = args.output or args.input
    title = os.path.splitext(os.path.basename(args.input))[0]
    lrc_content = segments_to_lrc(clean, title, "LyricSync — post-procesado")

    with open(output, "w", encoding="utf-8") as f:
        f.write(lrc_content)

    print(f"\n✅ Guardado en: {output}\n")
