from __future__ import annotations

import os
import sys
import time
import types
from collections.abc import Iterator

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

# kokoro.pipeline imports its optional English modules eagerly even for a
# Japanese-only pipeline. Stub those modules so Windows installs do not pull
# spaCy/espeak just to use Misaki's Japanese G2P.
from misaki.token import MToken

english_stub = types.ModuleType("misaki.en")
english_stub.MToken = MToken  # type: ignore[attr-defined]
sys.modules.setdefault("misaki.en", english_stub)
sys.modules.setdefault("misaki.espeak", types.ModuleType("misaki.espeak"))

from kokoro import KPipeline
from pydantic import BaseModel, Field

app = FastAPI(title="DeepInterview Kokoro Japanese Sidecar")
pipeline: KPipeline | None = None
started_at = time.perf_counter()


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: str = Field(default="jf_alpha", pattern=r"^j[fm]_[a-z]+$")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@app.on_event("startup")
def load_model() -> None:
    global pipeline
    pipeline = KPipeline(lang_code="j")


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": pipeline is not None,
        "language": "ja",
        "default_voice": os.getenv("KOKORO_VOICE", "jf_alpha"),
        "uptime_seconds": round(time.perf_counter() - started_at, 3),
    }


def pcm_stream(request: SynthesisRequest) -> Iterator[bytes]:
    if pipeline is None:
        raise HTTPException(status_code=503, detail="Kokoro is still loading")
    for _graphemes, _phonemes, audio in pipeline(
        request.text,
        voice=request.voice,
        speed=request.speed,
        split_pattern=r"[。！？!?]+",
    ):
        samples = audio.detach().cpu().numpy()
        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
        yield pcm.tobytes()


@app.post("/synthesize")
def synthesize(request: SynthesisRequest) -> StreamingResponse:
    return StreamingResponse(
        pcm_stream(request),
        media_type="audio/pcm",
        headers={"x-sample-rate": "24000", "x-audio-format": "pcm_s16le"},
    )

