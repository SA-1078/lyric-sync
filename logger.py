"""
logger.py — LyricSync
Sistema de logging profesional con niveles y salida a archivo.

Uso:
    from logger import get_logger
    log = get_logger("whisper")
    log.info("Transcripción iniciada")
    log.warn("Segmento sospechoso")
    log.error("Fallo al cargar modelo")
"""

import logging
import os
import sys
from datetime import datetime


# Cache de loggers ya configurados
_configured_loggers = set()


class SafeStreamHandler(logging.StreamHandler):
    """Handler que no crashea con emojis en Windows cp1252."""

    def emit(self, record):
        try:
            msg = self.format(record)
            stream = self.stream
            try:
                stream.write(msg + self.terminator)
            except UnicodeEncodeError:
                # Fallback: reemplazar caracteres no soportados
                stream.write(msg.encode("ascii", errors="replace").decode("ascii") + self.terminator)
            self.flush()
        except Exception:
            self.handleError(record)


def get_logger(name: str, level: str = None, to_file: bool = None, log_dir: str = None) -> logging.Logger:
    """
    Crea o retorna un logger configurado.

    Args:
        name: Nombre del módulo (ej: "whisper", "postprocess", "api")
        level: Nivel de logging (DEBUG, INFO, WARNING, ERROR). Si None, lee de config.
        to_file: Si guardar en archivo. Si None, lee de config.
        log_dir: Directorio de logs. Si None, lee de config.
    """
    logger = logging.getLogger(f"lyric-sync.{name}")

    # Evitar re-configurar si ya fue configurado
    if name in _configured_loggers:
        return logger

    # Leer config si no se proveen parámetros explícitos
    if level is None or to_file is None or log_dir is None:
        try:
            from lyric_config import get_config
            cfg = get_config().get("logging", {})
        except ImportError:
            cfg = {}

        if level is None:
            level = cfg.get("level", "INFO")
        if to_file is None:
            to_file = cfg.get("to_file", True)
        if log_dir is None:
            log_dir = cfg.get("log_dir", "logs")

    # Mapear nivel
    level_map = {
        "DEBUG": logging.DEBUG,
        "INFO": logging.INFO,
        "WARN": logging.WARNING,
        "WARNING": logging.WARNING,
        "ERROR": logging.ERROR,
    }
    log_level = level_map.get(level.upper(), logging.INFO)
    logger.setLevel(log_level)

    # Formato rico
    fmt = logging.Formatter(
        "%(asctime)s │ %(levelname)-5s │ %(name)s │ %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )

    # Console handler (con protección Unicode)
    ch = SafeStreamHandler(sys.stdout)
    ch.setLevel(log_level)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    # File handler
    if to_file:
        try:
            # Ruta relativa al directorio del proyecto
            project_dir = os.path.dirname(os.path.abspath(__file__))
            full_log_dir = os.path.join(project_dir, log_dir)
            os.makedirs(full_log_dir, exist_ok=True)

            log_file = os.path.join(full_log_dir, f"{datetime.now():%Y-%m-%d}.log")
            fh = logging.FileHandler(log_file, encoding="utf-8")
            fh.setLevel(log_level)
            fh.setFormatter(fmt)
            logger.addHandler(fh)
        except Exception:
            pass  # Si falla el file handler, continuar solo con console

    # Evitar propagación al logger raíz (evita duplicados)
    logger.propagate = False

    _configured_loggers.add(name)
    return logger
