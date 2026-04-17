"""
lyrics_postprocess.py — LyricSync
Post-procesador inteligente de transcripciones de Whisper.

Corrige problemas comunes:
  1. Líneas duplicadas exactas consecutivas (alucinaciones)
  2. Líneas casi idénticas (difieren solo en puntuación o 1-2 palabras)
  3. Patrones de alucinación conocidos de Whisper
  4. Líneas demasiado cortas o sin sentido
  5. Segmentos que se repiten en bucle
  6. Normalización de etiquetas musicales (♪, music, etc.)
  7. Líneas incompletas/cortadas → merge con siguiente
  8. Corrección semántica fuzzy contra repeticiones previas
  9. Gaps grandes sin voz → insertar (instrumental)

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


def normalize_music_tags(text: str) -> str:
    """
    Normaliza cualquier etiqueta musical a un formato consistente.
    Detecta patrones reales que Whisper produce:
      "Music"  → "(música)"
      "♪"      → "(música)"
      "♪♪♪"   → "(música)"
      "música" → "(música)"
    """
    stripped = text.strip()
    lower = stripped.lower()

    # Detectar patrones reales de etiquetas musicales
    if any(tag in lower for tag in ["music", "música", "musica"]):
        return "(música)"
    if re.match(r'^[♪♫🎵🎶\s\-–—\.]+$', stripped):
        return "(música)"

    return text


def merge_short_lines(segments: list, min_words: int = 3, max_gap: float = 2.0) -> list:
    """
    Fusiona líneas incompletas/cortadas con la siguiente.
    Ejemplo:
      [01:47.00] "Eres mi"           (2 palabras, corta)
      [01:50.88] "Y la estrella..."   → se fusiona
      Resultado: [01:47.00] "Eres mi / Y la estrella..."

    Solo fusiona si:
    - La línea actual tiene < min_words palabras
    - El gap temporal con la siguiente es < max_gap segundos
    - La línea NO es una etiqueta (música), (instrumental), etc.
    """
    if len(segments) < 2:
        return segments

    merged = []
    skip_next = False

    for i in range(len(segments)):
        if skip_next:
            skip_next = False
            continue

        seg = segments[i]
        text = seg["text"].strip()
        word_count = len(text.split())

        # No fusionar etiquetas
        if re.match(r'^\(.*\)$', text):
            merged.append(seg)
            continue

        # Línea corta + hay siguiente segmento
        if word_count < min_words and i + 1 < len(segments):
            next_seg = segments[i + 1]
            gap = next_seg.get("start", 0) - seg.get("end", seg.get("start", 0))

            # Solo fusionar si el gap es pequeño (forman parte de la misma frase)
            if gap < max_gap:
                # Limpiar puntuación final del fragmento corto para evitar ", ,"
                clean_tail = text.rstrip(" ,;.")
                merged_seg = {
                    "start": seg["start"],
                    "end": next_seg.get("end", next_seg.get("start", 0)),
                    "text": f"{clean_tail}, {next_seg['text'].strip()}",
                }
                # Copiar avg_logprob si existe (usar el peor de los dos)
                if "avg_logprob" in seg or "avg_logprob" in next_seg:
                    merged_seg["avg_logprob"] = min(
                        seg.get("avg_logprob", 0),
                        next_seg.get("avg_logprob", 0)
                    )
                merged.append(merged_seg)
                skip_next = True
                continue

        merged.append(seg)

    return merged


def fix_semantic_errors(segments: list, similarity_floor: int = 60, similarity_ceil: int = 84) -> list:
    """
    Corrige errores semánticos por comparación con repeticiones previas.

    Si un segmento es "parecido pero no idéntico" a uno anterior (60-84% similar),
    probablemente Whisper transcribió mal una palabra en una frase que se repite
    (ej: "huerta" en vez de "alma" en "quiero ser tu alma, tu corazón").

    En ese caso, usa la versión con mayor confianza (avg_logprob más alto).
    Si no hay logprob, usa la primera aparición (normalmente más confiable).
    """
    if len(segments) < 2:
        return segments

    corrected = 0

    for i in range(1, len(segments)):
        current = segments[i]
        current_norm = normalize_text(current["text"])
        if not current_norm or len(current_norm.split()) < 4:
            continue  # Líneas muy cortas no aplican

        # Buscar en segmentos anteriores (no adyacentes) una versión similar
        for j in range(max(0, i - 30), i):
            prev = segments[j]
            prev_norm = normalize_text(prev["text"])
            if not prev_norm or len(prev_norm.split()) < 4:
                continue

            ratio = fuzz.ratio(current_norm, prev_norm)

            # Rango "parecido pero no duplicado" → probable error de transcripción
            if similarity_floor <= ratio <= similarity_ceil:
                # Determinar cuál versión es mejor
                conf_current = current.get("avg_logprob", -1.0)
                conf_prev = prev.get("avg_logprob", -0.5)  # bias hacia la primera

                if conf_prev > conf_current:
                    # La versión anterior es más confiable → corregir la actual
                    current["text"] = prev["text"]
                    corrected += 1
                break  # Solo comparar con la mejor coincidencia

    return segments


def insert_instrumental_gaps(segments: list, min_gap: float = 10.0) -> list:
    """
    Detecta gaps de silencio/instrumental >min_gap segundos entre segmentos
    e inserta una etiqueta "(instrumental)".

    Ejemplo:
      [00:48.68] "Amor chiquita"
      ← gap de 28 segundos sin voz →
      [01:16.56] "Con la unidad de siempre"

    Resultado:
      [00:48.68] "Amor chiquita"
      [00:53.68] "(instrumental)"
      [01:16.56] "Con la unidad de siempre"
    """
    if len(segments) < 2:
        return segments

    result = []

    for i in range(len(segments)):
        result.append(segments[i])

        if i + 1 < len(segments):
            end_current = segments[i].get("end", segments[i].get("start", 0))
            start_next = segments[i + 1].get("start", 0)
            gap = start_next - end_current

            if gap >= min_gap:
                # Insertar etiqueta instrumental en medio del gap
                instrumental_start = end_current + 2.0  # 2s después del último segmento
                result.append({
                    "start": instrumental_start,
                    "end": start_next - 1.0,
                    "text": "(instrumental)",
                })

    return result


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


def is_legitimate_repetition(seg_a: dict, seg_b: dict) -> bool:
    """
    Determina si dos segmentos idénticos/similares son una repetición
    musical legítima (coro, estribillo, frase repetida) vs una alucinación.

    Criterios:
    - Gap temporal razonable entre repeticiones (>1s sugiere que es cantada de nuevo)
    - Ambos segmentos tienen duración razonable (>1.5s cada uno)
    """
    start_a = seg_a.get("start", 0)
    end_a = seg_a.get("end", start_a)
    start_b = seg_b.get("start", 0)
    end_b = seg_b.get("end", start_b)

    time_gap = start_b - end_a
    duration_a = end_a - start_a
    duration_b = end_b - start_b

    # Gap temporal razonable entre repeticiones (>1s sugiere que es canto real)
    if time_gap > 1.0:
        return True

    # Si ambos segmentos tienen duración razonable (>1.5s), es canto real
    if duration_a > 1.5 and duration_b > 1.5:
        return True

    # Si el gap es casi nulo y las duraciones son muy cortas → alucinación
    return False


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
        "etiqueta_normalizada": 0,
        "líneas_fusionadas": 0,
        "corrección_semántica": 0,
        "instrumental_insertado": 0,
        "repetición_interna": 0,
        "duplicado_exacto": 0,
        "duplicado_fuzzy": 0,
        "loop": 0,
        "timing": 0,
    }

    # Paso 1: Verificar timing
    segments = check_timing(segments)
    removed_reasons["timing"] = original_count - len(segments)

    # Paso 1.2: Normalizar etiquetas musicales (♪, music, etc. → "(música)")
    music_normalized = 0
    for seg in segments:
        original = seg["text"]
        normalized = normalize_music_tags(original)
        if normalized != original:
            seg["text"] = normalized
            music_normalized += 1
    removed_reasons["etiqueta_normalizada"] = music_normalized

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
    #         PERO mantener repeticiones musicales legítimas (frases cantadas 2 veces)
    cleaned = []
    for seg in segments:
        if not cleaned:
            cleaned.append(seg)
            continue

        prev = cleaned[-1]

        # Duplicado exacto — verificar si es repetición legítima
        if normalize_text(seg["text"]) == normalize_text(prev["text"]):
            if is_legitimate_repetition(prev, seg):
                cleaned.append(seg)  # Mantener: repetición musical legítima
            else:
                removed_reasons["duplicado_exacto"] += 1
            continue

        # Duplicado fuzzy (casi igual, difieren en 1-2 palabras)
        if is_near_duplicate(seg["text"], prev["text"], similarity_threshold):
            if is_legitimate_repetition(prev, seg):
                cleaned.append(seg)  # Mantener: repetición musical legítima
            else:
                removed_reasons["duplicado_fuzzy"] += 1
            continue

        cleaned.append(seg)

    # Paso 5: Fusionar líneas cortas/incompletas con la siguiente
    count_before_merge = len(cleaned)
    cleaned = merge_short_lines(cleaned, min_words=3, max_gap=2.0)
    removed_reasons["líneas_fusionadas"] = count_before_merge - len(cleaned)

    # Paso 6: Corrección semántica (fuzzy contra repeticiones previas)
    cleaned_before_semantic = [seg["text"] for seg in cleaned]
    cleaned = fix_semantic_errors(cleaned, similarity_floor=60, similarity_ceil=84)
    semantic_fixes = sum(1 for i, seg in enumerate(cleaned) if seg["text"] != cleaned_before_semantic[i])
    removed_reasons["corrección_semántica"] = semantic_fixes

    # Paso 7: Insertar (instrumental) en gaps grandes (>10s sin voz)
    count_before_gaps = len(cleaned)
    cleaned = insert_instrumental_gaps(cleaned, min_gap=10.0)
    removed_reasons["instrumental_insertado"] = len(cleaned) - count_before_gaps

    # Reporte
    total_actions = sum(removed_reasons.values())
    if total_actions > 0:
        print(f"\n🧹 Post-procesamiento completado:")
        print(f"   Segmentos originales: {original_count}")
        print(f"   Acciones realizadas: {total_actions}")
        for reason, count in removed_reasons.items():
            if count > 0:
                print(f"     ├─ {reason}: {count}")
        print(f"   Resultado final: {len(cleaned)} segmentos")
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
