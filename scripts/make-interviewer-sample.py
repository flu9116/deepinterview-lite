"""Create a clearly synthetic, local Japanese question for desktop acceptance testing."""
from pathlib import Path
import json
import argparse
import wave
from tts_server.app import load_model, pcm_stream, SynthesisRequest

root = Path(__file__).resolve().parent.parent / "outputs"
cases = json.loads((root / "japanese-interviewer-test-cases.json").read_text(encoding="utf-8"))
parser = argparse.ArgumentParser()
parser.add_argument("--case", choices=[case["id"] for case in cases])
selected = parser.parse_args().case
if selected:
    cases = [case for case in cases if case["id"] == selected]
load_model()
results = []
for case in cases:
    request = SynthesisRequest(text=case["text"], voice="jf_alpha", speed=case["speed"])
    destination = root / case["file"]
    with wave.open(str(destination), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        for chunk in pcm_stream(request):
            output.writeframes(chunk)
    with wave.open(str(destination), "rb") as output:
        seconds = round(output.getnframes() / output.getframerate(), 3)
    results.append({"id": case["id"], "file": case["file"], "seconds": seconds, "source": "local Kokoro synthetic speech, not human"})
    print(f"Saved {destination.name}: {seconds}s", flush=True)
manifest = root / "japanese-interviewer-audio-info.json"
if selected and manifest.exists():
    previous = json.loads(manifest.read_text(encoding="utf-8"))
    results = [item for item in previous if item["id"] != selected] + results
manifest.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
