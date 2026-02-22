"""
Minimal WhisperLive server launcher for Glass app.
Starts a faster_whisper backend on a configurable port.
"""
import sys
import argparse
import os
from whisper_live.server import TranscriptionServer
from whisper_live.vad import VoiceActivityDetector

# Monkey patch VoiceActivityDetector to use custom threshold from environment
original_init = VoiceActivityDetector.__init__

def patched_init(self, threshold=0.5, frame_rate=16000):
    # Use custom threshold from environment if available, otherwise default to 0.3
    vad_threshold = float(os.environ.get('WHISPER_LIVE_VAD_THRESHOLD', 0.3))
    original_init(self, threshold=vad_threshold, frame_rate=frame_rate)
    print(f"[WhisperLive] Using VAD threshold: {vad_threshold}", flush=True)

VoiceActivityDetector.__init__ = patched_init

def main():
    parser = argparse.ArgumentParser(description="WhisperLive Server for Glass")
    parser.add_argument("--port", type=int, default=9090, help="WebSocket port")
    parser.add_argument("--model", type=str, default="small.en", help="Whisper model size (use .en suffix for English-only)")
    parser.add_argument("--vad_threshold", type=float, default=0.3, help="VAD threshold for speech detection (lower = more sensitive)")
    args = parser.parse_args()

    # Set VAD threshold as environment variable for the server to use
    os.environ['WHISPER_LIVE_VAD_THRESHOLD'] = str(args.vad_threshold)
    
    server = TranscriptionServer()
    model_path = args.model if "/" in args.model else None
    print(f"[WhisperLive] Starting server on port {args.port} with model={args.model}, vad_threshold={args.vad_threshold}", flush=True)
    server.run(
        "0.0.0.0",
        port=args.port,
        backend="faster_whisper",
        faster_whisper_custom_model_path=model_path,
        single_model=True,
    )

if __name__ == "__main__":
    main()
