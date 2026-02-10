import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';
import './stt/SttView.js';
import './summary/SummaryView.js';

export class ListenView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 720px;
            transform: translate3d(0, 0, 0);
            backface-visibility: hidden;
            transition: transform 0.2s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.2s ease-out;
            will-change: transform, opacity;
        }

        :host(.hiding) {
            animation: slideUp 0.3s cubic-bezier(0.4, 0, 0.6, 1) forwards;
        }

        :host(.showing) {
            animation: slideDown 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }

        :host(.hidden) {
            opacity: 0;
            transform: translateY(-150%) scale(0.85);
            pointer-events: none;
        }


        * {
            font-family: 'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            cursor: default;
            user-select: none;
        }

/* Allow text selection in insights responses */
.insights-container, .insights-container *, .markdown-content {
    user-select: text !important;
    cursor: text !important;
}

/* highlight.js 스타일 추가 */
.insights-container pre {
    background: rgba(0, 0, 0, 0.4) !important;
    border-radius: 8px !important;
    padding: 12px !important;
    margin: 8px 0 !important;
    overflow-x: auto !important;
    border: 1px solid rgba(255, 255, 255, 0.1) !important;
    white-space: pre !important;
    word-wrap: normal !important;
    word-break: normal !important;
}

.insights-container code {
    font-family: 'Monaco', 'Menlo', 'Consolas', monospace !important;
    font-size: 11px !important;
    background: transparent !important;
    white-space: pre !important;
    word-wrap: normal !important;
    word-break: normal !important;
}

.insights-container pre code {
    white-space: pre !important;
    word-wrap: normal !important;
    word-break: normal !important;
    display: block !important;
}

.insights-container p code {
    background: rgba(255, 255, 255, 0.1) !important;
    padding: 2px 4px !important;
    border-radius: 3px !important;
    color: #ffd700 !important;
}

.hljs-keyword {
    color: #ff79c6 !important;
}

.hljs-string {
    color: #f1fa8c !important;
}

.hljs-comment {
    color: #6272a4 !important;
}

.hljs-number {
    color: #bd93f9 !important;
}

.hljs-function {
    color: #50fa7b !important;
}

.hljs-title {
    color: #50fa7b !important;
}

.hljs-variable {
    color: #8be9fd !important;
}

.hljs-built_in {
    color: #ffb86c !important;
}

.hljs-attr {
    color: #50fa7b !important;
}

.hljs-tag {
    color: #ff79c6 !important;
}
        .assistant-container {
            display: flex;
            flex-direction: column;
            color: #ffffff;
            box-sizing: border-box;
            position: relative;
            background: rgba(0, 0, 0, 0.6);
            overflow: hidden;
            border-radius: 12px;
            width: 100%;
            height: 100%;
        }

        .assistant-container::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            border-radius: 12px;
            padding: 1px;
            background: linear-gradient(169deg, rgba(255, 255, 255, 0.17) 0%, rgba(255, 255, 255, 0.08) 50%, rgba(255, 255, 255, 0.17) 100%);
            -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
            -webkit-mask-composite: destination-out;
            mask-composite: exclude;
            pointer-events: none;
        }

        .assistant-container::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.15);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            border-radius: 12px;
            z-index: -1;
        }

        .top-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 16px;
            min-height: 32px;
            position: relative;
            z-index: 1;
            width: 100%;
            box-sizing: border-box;
            flex-shrink: 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .bar-left-text {
            color: white;
            font-size: 13px;
            font-family: 'Helvetica Neue', sans-serif;
            font-weight: 500;
            position: relative;
            overflow: hidden;
            white-space: nowrap;
            flex: 1;
            min-width: 0;
            max-width: 200px;
        }

        .bar-left-text-content {
            display: inline-block;
            transition: transform 0.3s ease;
        }

        .bar-left-text-content.slide-in {
            animation: slideIn 0.3s ease forwards;
        }

        .bar-controls {
            display: flex;
            gap: 4px;
            align-items: center;
            flex-shrink: 0;
            width: 120px;
            justify-content: flex-end;
            box-sizing: border-box;
            padding: 4px;
        }

        .toggle-button {
            display: flex;
            align-items: center;
            gap: 5px;
            background: transparent;
            color: rgba(255, 255, 255, 0.9);
            border: none;
            outline: none;
            box-shadow: none;
            padding: 4px 8px;
            border-radius: 5px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            height: 24px;
            white-space: nowrap;
            transition: background-color 0.15s ease;
            justify-content: center;
        }

        .toggle-button:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .toggle-button svg {
            flex-shrink: 0;
            width: 12px;
            height: 12px;
        }

        .copy-button {
            background: transparent;
            color: rgba(255, 255, 255, 0.9);
            border: none;
            outline: none;
            box-shadow: none;
            padding: 4px;
            border-radius: 3px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 24px;
            height: 24px;
            flex-shrink: 0;
            transition: background-color 0.15s ease;
            position: relative;
            overflow: hidden;
        }

        .copy-button:hover {
            background: rgba(255, 255, 255, 0.15);
        }

        .copy-button svg {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
        }

        .copy-button .check-icon {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.5);
        }

        .copy-button.copied .copy-icon {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.5);
        }

        .copy-button.copied .check-icon {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }

        .timer {
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 10px;
            color: rgba(255, 255, 255, 0.7);
        }

        .split-content {
            display: flex;
            flex-direction: row;
            flex: 1;
            min-height: 0;
            max-height: 600px;
        }

        .pane {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-width: 0;
            min-height: 0;
        }

        .pane-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 16px;
            flex-shrink: 0;
        }

        .pane-label {
            font-size: 10px;
            font-weight: 600;
            color: rgba(255, 255, 255, 0.45);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            white-space: nowrap;
        }

        .pane-header-line {
            flex: 1;
            height: 1px;
            background: rgba(255, 255, 255, 0.1);
        }

        .pane-body {
            flex: 1;
            overflow-y: auto;
            min-height: 0;
        }

        .pane-body::-webkit-scrollbar {
            width: 6px;
        }
        .pane-body::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.1);
            border-radius: 3px;
        }
        .pane-body::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 3px;
        }
        .pane-body::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .vertical-divider {
            width: 1px;
            background: rgba(255, 255, 255, 0.1);
            flex-shrink: 0;
        }

        /* ────────────────[ GLASS BYPASS ]─────────────── */
        :host-context(body.has-glass) .assistant-container,
        :host-context(body.has-glass) .top-bar,
        :host-context(body.has-glass) .copy-button,
        :host-context(body.has-glass) .split-content,
        :host-context(body.has-glass) .pane,
        :host-context(body.has-glass) .pane-header,
        :host-context(body.has-glass) .pane-body,
        :host-context(body.has-glass) .vertical-divider,
        :host-context(body.has-glass) .transcription-container,
        :host-context(body.has-glass) .insights-container,
        :host-context(body.has-glass) .stt-message,
        :host-context(body.has-glass) .outline-item,
        :host-context(body.has-glass) .request-item,
        :host-context(body.has-glass) .markdown-content,
        :host-context(body.has-glass) .insights-container pre,
        :host-context(body.has-glass) .insights-container p code,
        :host-context(body.has-glass) .insights-container pre code {
            background: transparent !important;
            border: none !important;
            outline: none !important;
            box-shadow: none !important;
            filter: none !important;
            backdrop-filter: none !important;
        }

        :host-context(body.has-glass) .assistant-container::before,
        :host-context(body.has-glass) .assistant-container::after {
            display: none !important;
        }

        :host-context(body.has-glass) .copy-button:hover,
        :host-context(body.has-glass) .outline-item:hover,
        :host-context(body.has-glass) .request-item.clickable:hover,
        :host-context(body.has-glass) .markdown-content:hover {
            background: transparent !important;
            transform: none !important;
        }

        :host-context(body.has-glass) * {
            animation: none !important;
            transition: none !important;
            transform: none !important;
            filter: none !important;
            backdrop-filter: none !important;
            box-shadow: none !important;
        }

        :host-context(body.has-glass) .assistant-container,
        :host-context(body.has-glass) .stt-message,
        :host-context(body.has-glass) .copy-button {
            border-radius: 0 !important;
        }

        :host-context(body.has-glass) ::-webkit-scrollbar,
        :host-context(body.has-glass) ::-webkit-scrollbar-track,
        :host-context(body.has-glass) ::-webkit-scrollbar-thumb {
            background: transparent !important;
            width: 0 !important;
        }
    `;

    static properties = {
        isHovering: { type: Boolean },
        isAnimating: { type: Boolean },
        copyState: { type: String },
        elapsedTime: { type: String },
        captureStartTime: { type: Number },
        isSessionActive: { type: Boolean },
        hasCompletedRecording: { type: Boolean },
    };

    constructor() {
        super();
        this.isSessionActive = false;
        this.hasCompletedRecording = false;
        this.isHovering = false;
        this.isAnimating = false;
        this._shouldAutoFollow = true;
        this._autoFollowThresholdPx = 80;
        this.elapsedTime = '00:00';
        this.captureStartTime = null;
        this.timerInterval = null;
        this.adjustHeightThrottle = null;
        this.isThrottled = false;
        this.copyState = 'idle';
        this.copyTimeout = null;

        this.adjustWindowHeight = this.adjustWindowHeight.bind(this);
        this.handleSplitContentScroll = this.handleSplitContentScroll.bind(this);
        this.handleSummaryUpdated = this.handleSummaryUpdated.bind(this);
    }

    connectedCallback() {
        super.connectedCallback();
        // Only start timer if session is active
        if (this.isSessionActive) {
            this.startTimer();
        }
        if (window.api) {
            window.api.listenView.onSessionStateChanged((event, { isActive }) => {
                const wasActive = this.isSessionActive;
                this.isSessionActive = isActive;

                if (!wasActive && isActive) {
                    this.hasCompletedRecording = false;
                    this._shouldAutoFollow = true;
                    this.startTimer();
                    // Reset child components
                    this.updateComplete.then(() => {
                        const sttView = this.shadowRoot.querySelector('stt-view');
                        const summaryView = this.shadowRoot.querySelector('summary-view');
                        if (sttView) sttView.resetTranscript();
                        if (summaryView) summaryView.resetAnalysis();
                    });
                    this.requestUpdate();
                }
                if (wasActive && !isActive) {
                    this.hasCompletedRecording = true;
                    this.stopTimer();
                    this.requestUpdate();
                }
            });
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        this.stopTimer();

        if (this.adjustHeightThrottle) {
            clearTimeout(this.adjustHeightThrottle);
            this.adjustHeightThrottle = null;
        }
        if (this.copyTimeout) {
            clearTimeout(this.copyTimeout);
        }
    }

    startTimer() {
        this.captureStartTime = Date.now();
        this.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.captureStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60)
                .toString()
                .padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            this.elapsedTime = `${minutes}:${seconds}`;
            this.requestUpdate();
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    adjustWindowHeight() {
        if (!window.api) return;

        this.updateComplete
            .then(() => {
                const topBar = this.shadowRoot.querySelector('.top-bar');
                const paneHeaders = this.shadowRoot.querySelectorAll('.pane-header');
                const summaryView = this.shadowRoot.querySelector('summary-view');
                const sttView = this.shadowRoot.querySelector('stt-view');

                if (!topBar) return;

                const topBarHeight = topBar.offsetHeight;
                const paneHeaderHeight = paneHeaders.length > 0 ? paneHeaders[0].offsetHeight : 0;
                const summaryHeight = summaryView ? summaryView.scrollHeight : 0;
                const sttHeight = sttView ? sttView.scrollHeight : 0;

                // Side-by-side: height is driven by the taller pane
                const tallerPaneContent = Math.max(summaryHeight, sttHeight);
                const idealHeight = topBarHeight + paneHeaderHeight + tallerPaneContent;

                const targetHeight = Math.min(700, idealHeight);

                window.api.listenView.adjustWindowHeight('listen', targetHeight);
            })
            .catch(error => {
                console.error('Error in adjustWindowHeight:', error);
            });
    }

    handleSplitContentScroll(event) {
        const container = event?.target;
        if (!container) return;

        const threshold = this._autoFollowThresholdPx || 0;
        const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
        this._shouldAutoFollow = distanceFromBottom <= threshold;
    }

    scrollToLatestIfFollowing() {
        if (!this._shouldAutoFollow) return;

        const paneBodies = this.shadowRoot?.querySelectorAll('.pane-body');
        const summaryView = this.shadowRoot?.querySelector('summary-view');
        const sttView = this.shadowRoot?.querySelector('stt-view');
        if (!paneBodies || paneBodies.length === 0) return;

        const doScroll = () => {
            if (!this._shouldAutoFollow) return;
            paneBodies.forEach(pane => {
                pane.scrollTop = pane.scrollHeight;
            });
        };

        const waits = [];
        if (summaryView && typeof summaryView.updateComplete?.then === 'function') {
            waits.push(summaryView.updateComplete);
        }
        if (sttView && typeof sttView.updateComplete?.then === 'function') {
            waits.push(sttView.updateComplete);
        }

        if (waits.length > 0) {
            Promise.all(waits).then(() => requestAnimationFrame(doScroll));
        } else {
            requestAnimationFrame(doScroll);
        }
    }

    handleSummaryUpdated(event) {
        this.adjustWindowHeightThrottled();
        this.scrollToLatestIfFollowing();
    }

    handleCopyHover(isHovering) {
        this.isHovering = isHovering;
        if (isHovering) {
            this.isAnimating = true;
        } else {
            this.isAnimating = false;
        }
        this.requestUpdate();
    }

    async handleCopy() {
        if (this.copyState === 'copied') return;

        const summaryView = this.shadowRoot.querySelector('summary-view');
        const sttView = this.shadowRoot.querySelector('stt-view');
        const insightsText = summaryView ? summaryView.getSummaryText() : '';
        const transcriptText = sttView ? sttView.getTranscriptText() : '';

        let textToCopy = '';
        if (insightsText && transcriptText) {
            textToCopy = `--- Insights ---\n${insightsText}\n\n--- Transcript ---\n${transcriptText}`;
        } else {
            textToCopy = insightsText || transcriptText;
        }

        try {
            await navigator.clipboard.writeText(textToCopy);
            console.log('Content copied to clipboard');

            this.copyState = 'copied';
            this.requestUpdate();

            if (this.copyTimeout) {
                clearTimeout(this.copyTimeout);
            }

            this.copyTimeout = setTimeout(() => {
                this.copyState = 'idle';
                this.requestUpdate();
            }, 1500);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    }

    adjustWindowHeightThrottled() {
        if (this.isThrottled) {
            return;
        }

        this.adjustWindowHeight();

        this.isThrottled = true;

        this.adjustHeightThrottle = setTimeout(() => {
            this.isThrottled = false;
        }, 16);
    }

    updated(changedProperties) {
        super.updated(changedProperties);
    }

    handleSttMessagesUpdated(event) {
        // Handle messages update from SttView if needed
        this.adjustWindowHeightThrottled();
        this.scrollToLatestIfFollowing();
    }

    firstUpdated() {
        super.firstUpdated();
        setTimeout(() => {
            this.adjustWindowHeight();
            this.scrollToLatestIfFollowing();
        }, 200);
    }

    render() {
        const displayText = this.isHovering
            ? 'Copy All'
            : this.isSessionActive
            ? `Glass is Listening ${this.elapsedTime}`
            : `Live insights`;

        return html`
            <div class="assistant-container">
                <div class="top-bar">
                    <div class="bar-left-text">
                        <span class="bar-left-text-content ${this.isAnimating ? 'slide-in' : ''}">${displayText}</span>
                    </div>
                    <div class="bar-controls">
                        <button
                            class="copy-button ${this.copyState === 'copied' ? 'copied' : ''}"
                            @click=${this.handleCopy}
                            @mouseenter=${() => this.handleCopyHover(true)}
                            @mouseleave=${() => this.handleCopyHover(false)}
                        >
                            <svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                            </svg>
                            <svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <path d="M20 6L9 17l-5-5" />
                            </svg>
                        </button>
                    </div>
                </div>

                <div class="split-content">
                    <div class="pane">
                        <div class="pane-header">
                            <span class="pane-label">Insights</span>
                            <span class="pane-header-line"></span>
                        </div>
                        <div class="pane-body" @scroll=${this.handleSplitContentScroll}>
                            <summary-view
                                @summary-updated=${this.handleSummaryUpdated}
                                .hasCompletedRecording=${this.hasCompletedRecording}
                            ></summary-view>
                        </div>
                    </div>

                    <div class="vertical-divider"></div>

                    <div class="pane">
                        <div class="pane-header">
                            <span class="pane-label">Transcript</span>
                            <span class="pane-header-line"></span>
                        </div>
                        <div class="pane-body" @scroll=${this.handleSplitContentScroll}>
                            <stt-view
                                @stt-messages-updated=${this.handleSttMessagesUpdated}
                            ></stt-view>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('listen-view', ListenView);
