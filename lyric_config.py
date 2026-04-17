"""
lyric_config.py — LyricSync
Cargador de configuración centralizada desde config.yaml.

Uso:
    from lyric_config import get_config
    cfg = get_config()
    model = cfg["whisper"]["default_model"]
"""

import os
import yaml


# Valores por defecto (fallback si config.yaml no existe o faltan keys)
DEFAULTS = {
    "whisper": {
        "default_model": "small",
        "default_language": "es",
        "beam_size": 8,
        "temperature": [0.0, 0.1, 0.2, 0.4],
        "no_speech_threshold": 0.55,
        "compression_ratio_threshold": 2.8,
        "word_timestamps": True,
        "condition_on_previous_text": False,
        "vad": False,
        "adjust_by_silence": True,
    },
    "postprocess": {
        "similarity_threshold": 85,
        "min_chars": 2,
        "loop_window": 5,
        "max_segment_duration": 30,
    },
    "api": {
        "host": "127.0.0.1",
        "port": 8642,
        "auto_start": False,
    },
    "batch": {
        "max_workers": 2,
    },
    "ffmpeg": {
        "use_bundled": True,
        "bundled_path": "bin",
    },
    "logging": {
        "level": "INFO",
        "to_file": True,
        "log_dir": "logs",
    },
    "paths": {
        "lrc_output": "lrc",
        "music_folder": "",
    },
}


def _deep_merge(base: dict, override: dict) -> dict:
    """Merge profundo: override sobreescribe base, preservando keys no mencionadas."""
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def get_config(config_path: str = None) -> dict:
    """
    Lee config.yaml y lo merga con los defaults.
    Si config.yaml no existe, retorna los defaults puros.
    """
    if config_path is None:
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.yaml")

    if os.path.exists(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                user_config = yaml.safe_load(f) or {}
            return _deep_merge(DEFAULTS, user_config)
        except Exception:
            pass  # Si falla la lectura, usar defaults

    return DEFAULTS.copy()
