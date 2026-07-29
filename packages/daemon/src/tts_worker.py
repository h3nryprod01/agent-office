#!/usr/bin/env python3
"""VieNeu TTS worker cho daemon Agent Office (wi-voice-vieneu).

Chạy bằng python trong venv có sẵn `vieneu` (mặc định: venv demo-app, xem tts.js).
Giao thức line-delimited JSON, model load 1 lần rồi giữ ấm:

  stdin :  {"id": 1, "text": "Xin chào"}
  stdout:  {"ready": true}                          (sau khi model load xong)
           {"id": 1, "file": "/tmp/ao-tts-x.wav"}   (48kHz mono float WAV)
           {"id": 1, "error": "..."}                (per-request, worker sống tiếp)

Node phía kia bỏ qua mọi dòng stdout không phải JSON (thư viện có thể in log).
"""
import json
import os
import sys
import tempfile


def main():
    from vieneu import Vieneu
    import numpy as np
    import soundfile as sf

    pkg = os.path.dirname(__import__("vieneu").__file__)
    samp = os.path.join(pkg, "assets", "samples")
    # Giọng Đoan (nữ miền Nam) — cùng giọng mẫu demo-app đã dùng cho video
    ref_wav = os.path.join(samp, "Đoan (nữ miền Nam).wav")
    with open(os.path.join(samp, "Đoan (nữ miền Nam).txt"), encoding="utf-8") as f:
        ref_txt = f.read().strip()

    tts = Vieneu()
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            audio = np.asarray(
                tts.infer(req["text"], ref_audio=ref_wav, ref_text=ref_txt),
                dtype=np.float32,
            )
            fd, path = tempfile.mkstemp(prefix="ao-tts-", suffix=".wav")
            os.close(fd)
            sf.write(path, np.clip(audio, -1.0, 1.0), 48000)
            print(json.dumps({"id": req.get("id"), "file": path}), flush=True)
        except Exception as e:  # noqa: BLE001 — worker phải sống qua mọi request lỗi
            rid = req.get("id") if isinstance(req, dict) else None
            print(json.dumps({"id": rid, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
