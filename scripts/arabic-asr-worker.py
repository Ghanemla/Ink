import json
import os
import re
import sys
import traceback

MODEL_ROOT = os.environ.get("INK_ARABIC_ASR_MODEL", "").strip()
MODEL = None


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def load_model():
    global MODEL
    if MODEL is not None:
        return MODEL
    if not MODEL_ROOT or not os.path.isdir(MODEL_ROOT):
        raise RuntimeError("Arabic dialect model folder is missing. Repair the Arabic speech pack in Ink Settings.")
    import onnx_asr
    # The OpenVoiceOS export follows onnx-asr's stock Whisper layout. INT8 is
    # intentionally CPU-first: predictable on ordinary Windows laptops and avoids
    # binding this optional pack to one CUDA runtime version.
    MODEL = onnx_asr.load_model(
        "whisper",
        MODEL_ROOT,
        quantization="int8",
        providers=["CPUExecutionProvider"],
    )
    return MODEL


def transcribe(wav_path):
    if not wav_path or not os.path.isfile(wav_path):
        raise RuntimeError("Ink could not find the recorded audio for Arabic recognition.")
    model = load_model()
    result = model.recognize(wav_path, language="ar")
    if hasattr(result, "text"):
        text = result.text
        logprobs = getattr(result, "logprobs", None)
    else:
        text = result
        logprobs = None
    confidence = 0.0
    if logprobs:
        try:
            import math
            values = [float(x) for x in logprobs if x is not None]
            if values:
                confidence = max(0.0, min(1.0, math.exp(sum(values) / len(values))))
        except Exception:
            confidence = 0.0
    return {
        "text": clean_text(text),
        "confidence": confidence,
        "engine": "Arabic Dialect Pack v2 · ONNX INT8",
    }


# Load once at process start so the first Arabic translation pays the load cost
# when the worker is warmed, not after the user finishes speaking.
try:
    load_model()
    emit({"event": "ready"})
except Exception as exc:
    emit({"event": "ready", "warning": str(exc)})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request_id = None
    try:
        request = json.loads(line)
        request_id = request.get("id")
        command = request.get("command")
        if command == "warm":
            load_model()
            result = {"ready": True}
        elif command == "transcribe":
            result = transcribe(request.get("wavPath"))
        else:
            raise RuntimeError(f"Unknown Arabic ASR command: {command}")
        emit({"id": request_id, "ok": True, "result": result})
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        emit({"id": request_id, "ok": False, "error": str(exc)})
