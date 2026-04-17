#!/usr/bin/env python3
"""
api_server.py — LyricSync
Microservicio local FastAPI que expone el motor Whisper como endpoints HTTP.

Uso:
    python api_server.py
    npm run api

Endpoints:
    POST /transcribe     → Transcribir audio a LRC (async con task_id)
    POST /postprocess    → Limpiar un .lrc existente
    POST /align          → Forced alignment con letra existente
    GET  /status/{id}    → Estado de una tarea en curso
    GET  /health         → Estado del servidor
    GET  /config         → Configuración actual
"""

import os
import sys
import uuid
import time
import threading
from datetime import datetime

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

from lyric_config import get_config
from logger import get_logger

log = get_logger("api")
cfg = get_config()

# ──────────────────────────────────────────────────────────────────────────────
# App FastAPI
# ──────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="LyricSync API",
    description="Motor de transcripción y sincronización de letras offline",
    version="1.0.0",
)

# CORS para futura web app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────────────────────────────────────
# Estado global
# ──────────────────────────────────────────────────────────────────────────────

tasks = {}          # {task_id: TaskState}
model_cache = {}    # {model_name: loaded_model}
_lock = threading.Lock()


class TaskState:
    def __init__(self, task_type, audio_path):
        self.task_id = str(uuid.uuid4())[:8]
        self.task_type = task_type
        self.audio_path = audio_path
        self.status = "queued"      # queued → running → done → error
        self.progress = 0
        self.result = None
        self.error = None
        self.created_at = datetime.now().isoformat()
        self.completed_at = None

    def to_dict(self):
        return {
            "task_id": self.task_id,
            "task_type": self.task_type,
            "status": self.status,
            "progress": self.progress,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


# ──────────────────────────────────────────────────────────────────────────────
# Modelos Pydantic
# ──────────────────────────────────────────────────────────────────────────────

class TranscribeRequest(BaseModel):
    audio_path: str
    model: str = "small"
    language: str = "es"
    output_path: Optional[str] = None
    word_mode: bool = False

class AlignRequest(BaseModel):
    audio_path: str
    lyrics_text: str
    model: str = "base"
    language: str = "es"
    output_path: Optional[str] = None

class PostprocessRequest(BaseModel):
    lrc_path: str
    threshold: int = 85
    output_path: Optional[str] = None


# ──────────────────────────────────────────────────────────────────────────────
# Workers (background threads)
# ──────────────────────────────────────────────────────────────────────────────

def _get_model(model_name: str):
    """Carga un modelo con cache."""
    if model_name not in model_cache:
        import stable_whisper as whisper
        from whisper_transcribe import detect_device
        device, device_name = detect_device()
        log.info(f"Cargando modelo '{model_name}' en {device} (primera vez, se cacheará)...")
        model_cache[model_name] = whisper.load_model(model_name, device=device)
    return model_cache[model_name]


def _run_transcription(task: TaskState, req: TranscribeRequest):
    """Worker de transcripción en background."""
    try:
        task.status = "running"
        task.progress = 10
        log.info(f"[{task.task_id}] Transcripción iniciada: {req.audio_path}")

        from whisper_transcribe import generate_lrc
        output = req.output_path or os.path.splitext(os.path.basename(req.audio_path))[0] + ".lrc"

        # Asegurar que el directorio de salida exista
        lrc_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lrc")
        os.makedirs(lrc_dir, exist_ok=True)
        output_full = os.path.join(lrc_dir, output) if not os.path.isabs(output) else output

        task.progress = 20
        generate_lrc(
            audio_path=req.audio_path,
            output_path=output_full,
            model_name=req.model,
            language=req.language,
            word_mode=req.word_mode,
        )

        task.progress = 100
        task.status = "done"
        task.result = {"output_path": output_full}
        task.completed_at = datetime.now().isoformat()
        log.info(f"[{task.task_id}] Transcripción completada: {output_full}")

    except Exception as e:
        task.status = "error"
        task.error = str(e)
        task.completed_at = datetime.now().isoformat()
        log.error(f"[{task.task_id}] Error en transcripción: {e}")


def _run_alignment(task: TaskState, req: AlignRequest):
    """Worker de forced alignment en background."""
    try:
        task.status = "running"
        task.progress = 10
        log.info(f"[{task.task_id}] Alineación iniciada: {req.audio_path}")

        from whisper_align import align_lyrics
        output = req.output_path or os.path.splitext(os.path.basename(req.audio_path))[0] + ".lrc"

        lrc_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lrc")
        os.makedirs(lrc_dir, exist_ok=True)
        output_full = os.path.join(lrc_dir, output) if not os.path.isabs(output) else output

        task.progress = 20
        align_lyrics(
            audio_path=req.audio_path,
            lyrics_text=req.lyrics_text,
            output_path=output_full,
            model_name=req.model,
            language=req.language,
        )

        task.progress = 100
        task.status = "done"
        task.result = {"output_path": output_full}
        task.completed_at = datetime.now().isoformat()
        log.info(f"[{task.task_id}] Alineación completada: {output_full}")

    except Exception as e:
        task.status = "error"
        task.error = str(e)
        task.completed_at = datetime.now().isoformat()
        log.error(f"[{task.task_id}] Error en alineación: {e}")


# ──────────────────────────────────────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────────────────────────────────────

@app.post("/transcribe")
async def transcribe(req: TranscribeRequest):
    """Inicia una transcripción en background. Retorna task_id para polling."""
    if not os.path.exists(req.audio_path):
        raise HTTPException(status_code=404, detail=f"Audio no encontrado: {req.audio_path}")

    task = TaskState("transcribe", req.audio_path)
    with _lock:
        tasks[task.task_id] = task

    thread = threading.Thread(target=_run_transcription, args=(task, req), daemon=True)
    thread.start()

    log.info(f"Tarea creada [{task.task_id}]: transcribe {req.audio_path}")
    return {"task_id": task.task_id, "status": "queued"}


@app.post("/align")
async def align(req: AlignRequest):
    """Inicia forced alignment en background."""
    if not os.path.exists(req.audio_path):
        raise HTTPException(status_code=404, detail=f"Audio no encontrado: {req.audio_path}")

    task = TaskState("align", req.audio_path)
    with _lock:
        tasks[task.task_id] = task

    thread = threading.Thread(target=_run_alignment, args=(task, req), daemon=True)
    thread.start()

    log.info(f"Tarea creada [{task.task_id}]: align {req.audio_path}")
    return {"task_id": task.task_id, "status": "queued"}


@app.post("/postprocess")
async def postprocess(req: PostprocessRequest):
    """Post-procesa un .lrc existente (sincrónico, es rápido)."""
    if not os.path.exists(req.lrc_path):
        raise HTTPException(status_code=404, detail=f"LRC no encontrado: {req.lrc_path}")

    from lyrics_postprocess import parse_lrc_file, postprocess_segments, segments_to_lrc

    segments = parse_lrc_file(req.lrc_path)
    if not segments:
        raise HTTPException(status_code=400, detail="No se encontraron segmentos en el LRC")

    clean = postprocess_segments(segments, req.threshold)
    output = req.output_path or req.lrc_path

    title = os.path.splitext(os.path.basename(req.lrc_path))[0]
    lrc_content = segments_to_lrc(clean, title, "LyricSync — post-procesado vía API")

    with open(output, "w", encoding="utf-8") as f:
        f.write(lrc_content)

    log.info(f"Post-procesado: {req.lrc_path} → {output} ({len(clean)} segmentos)")
    return {
        "output_path": output,
        "original_segments": len(segments),
        "clean_segments": len(clean),
    }


@app.get("/status/{task_id}")
async def get_status(task_id: str):
    """Consulta el estado de una tarea."""
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Tarea no encontrada")
    return task.to_dict()


@app.get("/tasks")
async def list_tasks():
    """Lista todas las tareas."""
    return [t.to_dict() for t in tasks.values()]


@app.get("/health")
async def health():
    """Estado del servidor."""
    return {
        "status": "ok",
        "models_loaded": list(model_cache.keys()),
        "active_tasks": len([t for t in tasks.values() if t.status in ("queued", "running")]),
        "total_tasks": len(tasks),
    }


@app.get("/config")
async def get_config_endpoint():
    """Configuración actual."""
    return get_config()


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    host = cfg["api"]["host"]
    port = cfg["api"]["port"]

    print()
    print("  ╭──────────────────────────────────────────────────╮")
    print("  │  🚀 LyricSync API — Servidor Local              │")
    print("  ╰──────────────────────────────────────────────────╯")
    print(f"  🌐 URL: http://{host}:{port}")
    print(f"  📋 Docs: http://{host}:{port}/docs")
    print()

    log.info(f"API server iniciando en {host}:{port}")

    uvicorn.run(app, host=host, port=port, log_level="warning")
