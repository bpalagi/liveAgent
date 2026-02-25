const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const SttService = require('./stt/sttService');
const SummaryService = require('./summary/summaryService');
const summaryRepository = require('./summary/repositories');
const authService = require('../common/services/authService');
const sessionRepository = require('../common/repositories/session');
const sttRepository = require('./stt/repositories');
const internalBridge = require('../../bridge/internalBridge');

class ListenService {
    constructor() {
        this.sttService = new SttService();
        this.summaryService = new SummaryService();
        this.currentSessionId = null;
        this.isInitializingSession = false;

        this.setupServiceCallbacks();
        console.log('[ListenService] Service instance created.');
    }

    setupServiceCallbacks() {
        // STT service callbacks
        this.sttService.setCallbacks({
            onTranscriptionComplete: (speaker, text) => {
                this.handleTranscriptionComplete(speaker, text);
            },
            onStatusUpdate: (status) => {
                this.sendToRenderer('update-status', status);
            }
        });

        // Summary service callbacks
        this.summaryService.setCallbacks({
            onAnalysisComplete: (data) => {
                console.log('Analysis completed:', data);
            },
            onStatusUpdate: (status) => {
                this.sendToRenderer('update-status', status);
            }
        });
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    initialize() {
        this.setupIpcHandlers();
        
        // Check if STT model is configured at startup
        this.checkSttModelReadiness();
        
        console.log('[ListenService] Initialized and ready.');
    }

    async checkSttModelReadiness() {
        try {
            const modelStateService = require('../common/services/modelStateService');
            const sttModelInfo = await modelStateService.getCurrentModelInfo('stt');
            if (!sttModelInfo || !sttModelInfo.apiKey) {
                console.warn('[ListenService] STT model is not configured. Please configure an STT provider in settings.');
            } else {
                console.log(`[ListenService] STT model ready: ${sttModelInfo.model} (provider: ${sttModelInfo.provider})`);
            }
        } catch (error) {
            console.error('[ListenService] Error checking STT model readiness:', error);
        }
    }

    async handleListenRequest(listenButtonText) {
        const { windowPool } = require('../../window/windowManager');
        const listenWindow = windowPool.get('listen');
        const header = windowPool.get('header');

        try {
            switch (listenButtonText) {
                case 'Listen':
                    console.log('[ListenService] changeSession to "Listen"');
                    internalBridge.emit('window:requestVisibility', { name: 'listen', visible: true });
                    await this.initializeSession();
                    if (listenWindow && !listenWindow.isDestroyed()) {
                        listenWindow.webContents.send('session-state-changed', { isActive: true });
                    }
                    break;
        
                case 'Stop':
                    console.log('[ListenService] changeSession to "Stop"');
                    await this.closeSession();
                    if (listenWindow && !listenWindow.isDestroyed()) {
                        listenWindow.webContents.send('session-state-changed', { isActive: false });
                    }
                    break;
        
                case 'Done':
                    console.log('[ListenService] changeSession to "Done"');
                    internalBridge.emit('window:requestVisibility', { name: 'listen', visible: false });
                    listenWindow.webContents.send('session-state-changed', { isActive: false });
                    break;
        
                default:
                    throw new Error(`[ListenService] unknown listenButtonText: ${listenButtonText}`);
            }
            
            header.webContents.send('listen:changeSessionResult', { success: true });

        } catch (error) {
            console.error('[ListenService] error in handleListenRequest:', error);
            header.webContents.send('listen:changeSessionResult', { success: false });
            throw error; 
        }
    }

    async handleTranscriptionComplete(speaker, text) {
        console.log(`[ListenService] Transcription complete: ${speaker} - ${text}`);

        // Save to database without blocking live analysis/render updates.
        this.saveConversationTurn(speaker, text);

        // Add to summary service for analysis
        this.summaryService.addConversationTurn(speaker, text);
    }

    async saveConversationTurn(speaker, transcription) {
        if (!this.currentSessionId) {
            console.error('[DB] Cannot save turn, no active session ID.');
            return;
        }
        if (transcription.trim() === '') return;

        try {
            await sessionRepository.touch(this.currentSessionId);
            await sttRepository.addTranscript({
                sessionId: this.currentSessionId,
                speaker: speaker,
                text: transcription.trim(),
            });
            console.log(`[DB] Saved transcript for session ${this.currentSessionId}: (${speaker})`);
        } catch (error) {
            console.error('Failed to save transcript to DB:', error);
        }
    }

    async initializeNewSession() {
        try {
            // The UID is no longer passed to the repository method directly.
            // The adapter layer handles UID injection. We just ensure a user is available.
            const user = authService.getCurrentUser();
            if (!user) {
                // This case should ideally not happen as authService initializes a default user.
                throw new Error("Cannot initialize session: auth service not ready.");
            }
            
            this.currentSessionId = await sessionRepository.getOrCreateActive('listen');
            console.log(`[DB] New listen session ensured: ${this.currentSessionId}`);

            // Set session ID for summary service
            this.summaryService.setSessionId(this.currentSessionId);
            
            // Reset conversation history
            this.summaryService.resetConversationHistory();

            console.log('New conversation session started:', this.currentSessionId);
            return true;
        } catch (error) {
            console.error('Failed to initialize new session in DB:', error);
            this.currentSessionId = null;
            return false;
        }
    }

    async initializeSession(language = 'en') {
        if (this.isInitializingSession) {
            console.log('Session initialization already in progress.');
            return false;
        }

        this.isInitializingSession = true;
        this.sendToRenderer('session-initializing', true);
        this.sendToRenderer('update-status', 'Initializing sessions...');

        try {
            // First, ensure STT model is configured and ready
            const modelStateService = require('../common/services/modelStateService');
            const sttModelInfo = await modelStateService.getCurrentModelInfo('stt');
            if (!sttModelInfo || !sttModelInfo.apiKey) {
                throw new Error('STT model is not configured. Please configure an STT provider in settings.');
            }
            console.log(`[ListenService] Using STT model: ${sttModelInfo.model} (provider: ${sttModelInfo.provider})`);

            // Initialize database session
            const sessionInitialized = await this.initializeNewSession();
            if (!sessionInitialized) {
                throw new Error('Failed to initialize database session');
            }

            /* ---------- STT Initialization Retry Logic ---------- */
            const MAX_RETRY = 10;
            const RETRY_DELAY_MS = 300;   // 0.3 seconds

            let sttReady = false;
            for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
                try {
                    await this.sttService.initializeSttSessions(language);
                    sttReady = true;
                    break;                         // Exit on success
                } catch (err) {
                    console.warn(
                        `[ListenService] STT init attempt ${attempt} failed: ${err.message}`
                    );
                    if (attempt < MAX_RETRY) {
                        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
                    }
                }
            }
            if (!sttReady) throw new Error('STT init failed after retries');
            /* ------------------------------------------- */

            console.log('Listen service initialized successfully.');
            
            this.sendToRenderer('update-status', 'Connected. Ready to listen.');
            
            return true;
        } catch (error) {
            console.error('Failed to initialize listen service:', error);
            this.sendToRenderer('update-status', 'Initialization failed.');
            return false;
        } finally {
            this.isInitializingSession = false;
            this.sendToRenderer('session-initializing', false);
            this.sendToRenderer('change-listen-capture-state', { status: "start" });
        }
    }

    async sendMicAudioContent(data, mimeType) {
        return await this.sttService.sendMicAudioContent(data, mimeType);
    }

    async startMacOSAudioCapture() {
        if (process.platform !== 'darwin') {
            throw new Error('macOS audio capture only available on macOS');
        }
        return await this.sttService.startMacOSAudioCapture();
    }

    async stopMacOSAudioCapture() {
        this.sttService.stopMacOSAudioCapture();
    }

    isSessionActive() {
        return this.sttService.isSessionActive();
    }

    async closeSession() {
        try {
            this.sendToRenderer('change-listen-capture-state', { status: "stop" });
            const completedSessionId = this.currentSessionId;

            // Close STT sessions
            await this.sttService.closeSessions();

            await this.stopMacOSAudioCapture();

            // End database session
            if (this.currentSessionId) {
                await sessionRepository.end(this.currentSessionId);
                console.log(`[DB] Session ${this.currentSessionId} ended.`);
            }

            if (completedSessionId) {
                try {
                    const markdownPath = await this.saveSessionAsMarkdown(completedSessionId);
                    if (markdownPath) {
                        console.log(`[ListenService] Session note saved: ${markdownPath}`);
                    }
                } catch (saveError) {
                    console.error('[ListenService] Failed to save session note:', saveError);
                }
            }

            // Reset state
            this.currentSessionId = null;
            this.summaryService.resetConversationHistory();

            console.log('Listen service session closed.');
            return { success: true };
        } catch (error) {
            console.error('Error closing listen service session:', error);
            return { success: false, error: error.message };
        }
    }

    async getNotesDirectory() {
        const appPath = app.getAppPath();
        const candidates = [
            path.resolve(appPath, '..', 'notes'),
            path.resolve(appPath, 'notes'),
            path.resolve(process.cwd(), '..', 'notes')
        ];

        for (const candidate of candidates) {
            try {
                await fs.access(candidate);
                return candidate;
            } catch {
                // continue
            }
        }

        await fs.mkdir(candidates[0], { recursive: true });
        return candidates[0];
    }

    formatDateTime(date = new Date()) {
        const pad = (value) => value.toString().padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    }

    safeArrayParse(value) {
        if (!value || typeof value !== 'string') return [];
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    buildSessionMarkdown({ sessionId, transcripts, analysisResult, summaryRecord }) {
        const generatedAt = new Date();

        const summaryText = analysisResult?.summaryCard?.summary || summaryRecord?.tldr || '';
        const summaryBullets = analysisResult?.summaryCard?.bullets?.length
            ? analysisResult.summaryCard.bullets
            : this.safeArrayParse(summaryRecord?.bullet_json);
        const followUps = analysisResult?.insights?.suggestedFollowUpQuestions?.length
            ? analysisResult.insights.suggestedFollowUpQuestions
            : this.safeArrayParse(summaryRecord?.action_json);
        const nextSentence = analysisResult?.insights?.nextSentenceToSay || '';
        const guidance = analysisResult?.insights?.questionAnswerGuidance || '';

        const transcriptLines = (transcripts || [])
            .map((entry) => {
                const speaker = entry?.speaker || 'Speaker';
                const text = (entry?.text || '').trim();
                if (!text) return null;
                return `- **${speaker}:** ${text}`;
            })
            .filter(Boolean);

        const bulletLines = summaryBullets.map((item) => `- ${item}`);
        const followUpLines = followUps.map((item) => `- ${item}`);

        return [
            '# Listen Session',
            '',
            `- Session ID: ${sessionId}`,
            `- Saved At: ${generatedAt.toISOString()}`,
            '',
            '## Insight',
            '',
            summaryText ? summaryText : '_No summary generated._',
            '',
            '### Key Points',
            ...(bulletLines.length ? bulletLines : ['- _No key points generated._']),
            '',
            '### Next Sentence To Say',
            nextSentence ? nextSentence : '_Not available._',
            '',
            '### Question/Answer Guidance',
            guidance ? guidance : '_Not available._',
            '',
            '### Suggested Follow-up Questions',
            ...(followUpLines.length ? followUpLines : ['- _No follow-up suggestions generated._']),
            '',
            '## Transcript',
            ...(transcriptLines.length ? transcriptLines : ['- _No transcript captured._']),
            ''
        ].join('\n');
    }

    async saveSessionAsMarkdown(sessionId) {
        const [transcripts, summaryRecord] = await Promise.all([
            sttRepository.getAllTranscriptsBySessionId(sessionId),
            summaryRepository.getSummaryBySessionId(sessionId)
        ]);

        const analysisResult = this.summaryService.getCurrentAnalysisData()?.previousResult || null;
        const content = this.buildSessionMarkdown({
            sessionId,
            transcripts,
            analysisResult,
            summaryRecord
        });

        const notesDirectory = await this.getNotesDirectory();
        const filename = `listen-session-${this.formatDateTime()}-${sessionId.slice(0, 8)}.md`;
        const filePath = path.join(notesDirectory, filename);
        await fs.writeFile(filePath, content, 'utf-8');
        return filePath;
    }

    getCurrentSessionData() {
        return {
            sessionId: this.currentSessionId,
            conversationHistory: this.summaryService.getConversationHistory(),
            totalTexts: this.summaryService.getConversationHistory().length,
            analysisData: this.summaryService.getCurrentAnalysisData(),
        };
    }

    getConversationHistory() {
        return this.summaryService.getConversationHistory();
    }

    _createHandler(asyncFn, successMessage, errorMessage) {
        return async (...args) => {
            try {
                const result = await asyncFn.apply(this, args);
                if (successMessage) console.log(successMessage);
                // `startMacOSAudioCapture` doesn't return { success, error } object on success,
                // so return success object here for consistent response from handler.
                // Other functions already return success object.
                return result && typeof result.success !== 'undefined' ? result : { success: true };
            } catch (e) {
                console.error(errorMessage, e);
                return { success: false, error: e.message };
            }
        };
    }

    // Dynamically create handlers using `_createHandler`
    handleSendMicAudioContent = this._createHandler(
        this.sendMicAudioContent,
        null,
        'Error sending user audio:'
    );

    handleStartMacosAudio = this._createHandler(
        async () => {
            if (process.platform !== 'darwin') {
                return { success: false, error: 'macOS audio capture only available on macOS' };
            }
            if (this.sttService.isMacOSAudioRunning?.()) {
                return { success: false, error: 'already_running' };
            }
            await this.startMacOSAudioCapture();
            return { success: true, error: null };
        },
        'macOS audio capture started.',
        'Error starting macOS audio capture:'
    );
    
    handleStopMacosAudio = this._createHandler(
        this.stopMacOSAudioCapture,
        'macOS audio capture stopped.',
        'Error stopping macOS audio capture:'
    );

    handleUpdateGoogleSearchSetting = this._createHandler(
        async (enabled) => {
            console.log('Google Search setting updated to:', enabled);
        },
        null,
        'Error updating Google Search setting:'
    );
}

const listenService = new ListenService();
module.exports = listenService;