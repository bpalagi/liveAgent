let WebSocket, path, EventEmitter;

if (typeof window === 'undefined') {
    WebSocket = require('ws');
    path = require('path');
    EventEmitter = require('events').EventEmitter;
} else {
    class DummyEventEmitter {
        on() {}
        emit() {}
        removeAllListeners() {}
    }
    EventEmitter = DummyEventEmitter;
}

// Input audio: PCM int16 mono at 24kHz from the app's audio capture
// WhisperLive expects: float32 mono at 16kHz
const INPUT_SAMPLE_RATE = 24000;
const TARGET_SAMPLE_RATE = 16000;

// Client-side VAD: RMS energy threshold for silence detection
const VAD_ENERGY_THRESHOLD = 0.001;  // Lowered from 0.003 to be more sensitive
// Allow this many consecutive silence chunks through so server VAD detects end-of-speech
const VAD_SILENCE_GRACE_CHUNKS = 8;

// Single-pole IIR low-pass filter coefficient for anti-alias before downsampling.
// Cutoff at target Nyquist (8 kHz) relative to input rate (24 kHz).
// alpha = 1 - e^(-2π * fc / fs)  ≈ 0.874 for fc=8000, fs=24000
const LP_ALPHA = 1 - Math.exp(-2 * Math.PI * (TARGET_SAMPLE_RATE / 2) / INPUT_SAMPLE_RATE);

function resampleAndConvertToFloat32(pcmInt16Buffer) {
    const numInputSamples = pcmInt16Buffer.length / 2;

    // Anti-alias low-pass filter (in-place on float representation)
    const filtered = new Float32Array(numInputSamples);
    let prev = pcmInt16Buffer.readInt16LE(0) / 32768.0;
    filtered[0] = prev;
    for (let i = 1; i < numInputSamples; i++) {
        const raw = pcmInt16Buffer.readInt16LE(i * 2) / 32768.0;
        prev += LP_ALPHA * (raw - prev);
        filtered[i] = prev;
    }

    // Downsample with linear interpolation
    const ratio = TARGET_SAMPLE_RATE / INPUT_SAMPLE_RATE;
    const numOutputSamples = Math.floor(numInputSamples * ratio);
    const float32 = new Float32Array(numOutputSamples);

    for (let i = 0; i < numOutputSamples; i++) {
        const srcIdx = i / ratio;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, numInputSamples - 1);
        const frac = srcIdx - idx0;

        float32[i] = filtered[idx0] + (filtered[idx1] - filtered[idx0]) * frac;
    }

    return Buffer.from(float32.buffer);
}

class WhisperSTTSession extends EventEmitter {
    constructor(model, whisperService, sessionId, language) {
        super();
        this.model = model;
        this.whisperService = whisperService;
        this.sessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        // Always enforce English — no language detection overhead
        this.language = 'en';
        this.ws = null;
        this.isRunning = false;
        this.serverReady = false;
        this.uid = this.sessionId;
        this.emittedCompletedCount = 0;
        this.emittedCompletedKeys = new Set();
        this.lastEmittedText = '';
        this.lastPartialText = '';
        this.consecutiveSilenceChunks = 0;
        this._closedIntentionally = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 5;
        this._reconnectTimer = null;
    }

    async initialize() {
        // Reset segment tracking — server starts fresh on each connection
        this.emittedCompletedCount = 0;
        this.emittedCompletedKeys.clear();
        this.lastEmittedText = '';
        this.lastPartialText = '';
        this.consecutiveSilenceChunks = 0;

        try {
            // Ensure the WhisperLive server is running
            if (!this.whisperService.isLiveServerRunning()) {
                console.log(`[WhisperSTT-${this.sessionId}] Starting WhisperLive server...`);
                // Map the model name to the correct faster-whisper format
                const serverModel = this._mapModelName(this.model);
                await this.whisperService.startLiveServer(serverModel);
                // Wait for server to be fully ready
                await this.whisperService.waitForServerReady();
            }

            const port = this.whisperService.getLiveServerPort();
            console.log(`[WhisperSTT-${this.sessionId}] Connecting to WhisperLive on port ${port}`);

            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('WhisperLive WebSocket connection timeout'));
                }, 10000);

                this.ws = new WebSocket(`ws://localhost:${port}`);

                this.ws.on('open', () => {
                    clearTimeout(timeout);
                    // Send initial config
                    const config = {
                        uid: this.uid,
                        language: 'en',
                        task: 'transcribe',
                        model: this._mapModelName(this.model),
                        use_vad: true,
                        // Initial prompt biases decoder toward English conversational speech
                        // and suppresses common hallucination patterns
                        initial_prompt: 'This is a conversation in English.',
                        // Server-side tuning for speed + quality
                        no_speech_thresh: 0.1,          // Much lower to catch more speech
                        same_output_threshold: 0.8,      // Lower to finalize segments faster
                        send_last_n_segments: 3,         // Send fewer segments for faster updates
                        // VAD parameters for shorter segments - more aggressive for system audio
                        vad_parameters: {
                            onset: 0.1,                 // Much lower = more sensitive to speech onset
                            offset: 0.1,                // Much lower = faster cut after speech
                            // min_duration_on: 0.2,    // Removed - not supported by current VAD library
                            // min_duration_off: 0.3,   // Removed - not supported by current VAD library
                        },
                    };
                    this.ws.send(JSON.stringify(config));
                    console.log(`[WhisperSTT-${this.sessionId}] Connected, sent config: ${JSON.stringify(config)}`);
                });

                this.ws.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        this._handleServerMessage(msg);

                        // Resolve on SERVER_READY
                        if (msg.message === 'SERVER_READY') {
                            this.isRunning = true;
                            this.serverReady = true;
                            clearTimeout(timeout);
                            resolve(true);
                        }
                    } catch (e) {
                        console.error(`[WhisperSTT-${this.sessionId}] Failed to parse message:`, e);
                    }
                });

                this.ws.on('error', (err) => {
                    clearTimeout(timeout);
                    console.error(`[WhisperSTT-${this.sessionId}] WebSocket error:`, err.message);
                    this.emit('error', err);
                    if (!this.serverReady) reject(err);
                });

                this.ws.on('close', (code, reason) => {
                    clearTimeout(timeout);
                    console.log(`[WhisperSTT-${this.sessionId}] WebSocket closed: ${code} ${reason}`);
                    const wasReady = this.serverReady;
                    this.isRunning = false;
                    this.serverReady = false;
                    if (!wasReady) {
                        reject(new Error(`WebSocket closed: ${code}`));
                    } else if (!this._closedIntentionally) {
                        // Unexpected close — attempt reconnection
                        this._scheduleReconnect();
                    } else {
                        this.emit('close', { code, reason: reason?.toString() });
                    }
                });
            });
        } catch (error) {
            console.error(`[WhisperSTT-${this.sessionId}] Initialization error:`, error);
            this.emit('error', error);
            return false;
        }
    }

    _mapModelName(model) {
        // Hardcode to medium.en for all models as requested
        return 'medium.en';
    }

    _getSegmentKey(seg) {
        if (!seg) return null;

        if (seg.id !== undefined && seg.id !== null) {
            return `id:${seg.id}`;
        }

        if (seg.start === undefined || seg.start === null || seg.end === undefined || seg.end === null) {
            return null;
        }

        const start = Number(seg.start);
        const end = Number(seg.end);

        if (Number.isFinite(start) && Number.isFinite(end)) {
            return `${start.toFixed(3)}-${end.toFixed(3)}`;
        }

        return null;
    }

    _handleServerMessage(msg) {
        if (msg.message === 'SERVER_READY') {
            console.log(`[WhisperSTT-${this.sessionId}] Server ready (backend: ${msg.backend || 'unknown'})`);
            return;
        }

        if (msg.status === 'WAIT') {
            console.warn(`[WhisperSTT-${this.sessionId}] Server full, wait time: ${msg.message} min`);
            return;
        }

        if (msg.message === 'DISCONNECT') {
            console.log(`[WhisperSTT-${this.sessionId}] Server requested disconnect — will reconnect`);
            this.isRunning = false;
            this.serverReady = false;
            if (this.ws) {
                // Remove listeners before closing to avoid stale promise rejection
                this.ws.removeAllListeners();
                try { this.ws.close(); } catch (_) {}
                this.ws = null;
            }
            this._scheduleReconnect();
            return;
        }

        if (msg.segments && msg.segments.length > 0) {
            // WhisperLive sends ALL segments each time (including old completed ones).
            // Only emit newly completed segments we haven't seen before.
            const completedSegments = msg.segments.filter(s => s.completed);

            for (const seg of completedSegments) {
                const text = (seg.text || '').trim();
                if (!text) continue;

                const key = this._getSegmentKey(seg);
                if (key) {
                    if (this.emittedCompletedKeys.has(key)) continue;
                    this.emittedCompletedKeys.add(key);
                } else if (text === this.lastEmittedText) {
                    console.log(`[WhisperSTT-${this.sessionId}] Skipped duplicate: "${text}"`);
                    continue;
                }

                this.lastEmittedText = text;
                console.log(`[WhisperSTT-${this.sessionId}] Transcription: "${text}"`);
                this.emit('transcription', {
                    text: text,
                    timestamp: Date.now(),
                    confidence: 1.0,
                    sessionId: this.sessionId,
                    start: seg.start,
                    end: seg.end,
                });
            }
            this.emittedCompletedCount = completedSegments.length;

            // Emit partial (interim) result from the latest non-completed segment
            const pendingSegments = msg.segments.filter(s => !s.completed);
            if (pendingSegments.length > 0) {
                const latest = pendingSegments[pendingSegments.length - 1];
                const partialText = (latest.text || '').trim();
                if (partialText && partialText !== this.lastPartialText) {
                    this.lastPartialText = partialText;
                    this.emit('partial', {
                        text: partialText,
                        timestamp: Date.now(),
                        sessionId: this.sessionId,
                    });
                }
            } else {
                // All segments completed — clear partial
                if (this.lastPartialText) {
                    this.lastPartialText = '';
                    this.emit('partial', { text: '', timestamp: Date.now(), sessionId: this.sessionId });
                }
            }
        }

        if (msg.language) {
            console.log(`[WhisperSTT-${this.sessionId}] Detected language: ${msg.language} (prob: ${msg.language_prob})`);
        }
    }

    sendRealtimeInput(audioData) {
        if (!this.isRunning || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        // Decode base64 if needed
        if (typeof audioData === 'string') {
            try {
                audioData = Buffer.from(audioData, 'base64');
            } catch (error) {
                console.error('[WhisperSTT] Failed to decode base64 audio data:', error);
                return;
            }
        } else if (audioData instanceof ArrayBuffer) {
            audioData = Buffer.from(audioData);
        } else if (!Buffer.isBuffer(audioData)) {
            audioData = Buffer.from(audioData);
        }

        if (audioData.length === 0) return;

        // Convert PCM int16 24kHz → float32 16kHz
        const float32Buf = resampleAndConvertToFloat32(audioData);

        // Client-side VAD: compute RMS energy of the float32 samples
        const f32 = new Float32Array(float32Buf.buffer, float32Buf.byteOffset, float32Buf.byteLength / 4);
        let sumSq = 0;
        for (let i = 0; i < f32.length; i++) sumSq += f32[i] * f32[i];
        const rms = Math.sqrt(sumSq / f32.length);

        if (rms < VAD_ENERGY_THRESHOLD) {
            this.consecutiveSilenceChunks++;
            // Let a few silence chunks through so server VAD can detect end-of-speech
            if (this.consecutiveSilenceChunks > VAD_SILENCE_GRACE_CHUNKS) {
                return; // Skip sending pure silence
            }
        } else {
            this.consecutiveSilenceChunks = 0;
        }

        try {
            this.ws.send(float32Buf);
        } catch (err) {
            console.error(`[WhisperSTT-${this.sessionId}] Send error:`, err.message);
        }
    }

    _scheduleReconnect() {
        if (this._closedIntentionally) return;
        if (this._reconnectAttempts >= this._maxReconnectAttempts) {
            console.error(`[WhisperSTT-${this.sessionId}] Max reconnect attempts reached, giving up`);
            this.emit('close', { code: 1006, reason: 'Max reconnect attempts exceeded' });
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 16000);
        this._reconnectAttempts++;
        console.log(`[WhisperSTT-${this.sessionId}] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);

        this._reconnectTimer = setTimeout(async () => {
            try {
                const result = await this.initialize();
                if (result) {
                    console.log(`[WhisperSTT-${this.sessionId}] Reconnected successfully`);
                    this._reconnectAttempts = 0;
                } else {
                    this._scheduleReconnect();
                }
            } catch (err) {
                console.error(`[WhisperSTT-${this.sessionId}] Reconnect failed:`, err.message);
                this._scheduleReconnect();
            }
        }, delay);
    }

    async close() {
        console.log(`[WhisperSTT-${this.sessionId}] Closing session`);
        this._closedIntentionally = true;
        this.isRunning = false;

        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        if (this.ws) {
            try {
                if (this.ws.readyState === WebSocket.OPEN) {
                    // Signal end of audio
                    this.ws.send(Buffer.from('END_OF_AUDIO'));
                }
                this.ws.close();
            } catch (e) {
                // ignore close errors
            }
            this.ws = null;
        }

        this.removeAllListeners();
    }
}

class WhisperProvider {
    static async validateApiKey() {
        // Whisper is a local service, no API key validation needed.
        return { success: true };
    }

    constructor() {
        this.whisperService = null;
    }

    async initialize() {
        if (!this.whisperService) {
            this.whisperService = require('../../services/whisperService');
            if (!this.whisperService.isInitialized) {
                await this.whisperService.initialize();
            }
        }
    }

    async createSTT(config) {
        await this.initialize();
        
        const model = config.model || 'whisper-medium';
        const sessionType = config.sessionType || 'unknown';
        console.log(`[WhisperProvider] Creating ${sessionType} STT session with model: ${model}`);
        
        // Create unique session ID based on type
        const sessionId = `${sessionType}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const language = config.language || 'en';
        const session = new WhisperSTTSession(model, this.whisperService, sessionId, language);
        
        // Log session creation
        console.log(`[WhisperProvider] Created session: ${sessionId}`);
        
        const initialized = await session.initialize();
        if (!initialized) {
            throw new Error('Failed to initialize Whisper STT session');
        }

        if (config.callbacks) {
            if (config.callbacks.onmessage) {
                session.on('transcription', config.callbacks.onmessage);
            }
            if (config.callbacks.onpartial) {
                session.on('partial', config.callbacks.onpartial);
            }
            if (config.callbacks.onerror) {
                session.on('error', config.callbacks.onerror);
            }
            if (config.callbacks.onclose) {
                session.on('close', config.callbacks.onclose);
            }
        }

        return session;
    }

    async createLLM() {
        throw new Error('Whisper provider does not support LLM functionality');
    }

    async createStreamingLLM() {
        console.warn('[WhisperProvider] Streaming LLM is not supported by Whisper.');
        throw new Error('Whisper does not support LLM.');
    }
}

module.exports = {
    WhisperProvider,
    WhisperSTTSession
};