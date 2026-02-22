import { html, css, LitElement } from '../assets/lit-core-2.7.4.min.js';
import './stt/SttView.js';
import './summary/SummaryView.js';

export class ListenView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 940px;
            color: #ffffff;
            font-family: 'Helvetica Neue', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .shell {
            display: flex;
            flex-direction: column;
            width: 100%;
        }

        .board {
            width: 100%;
            border: 1px solid rgba(255, 255, 255, 0.22);
            border-radius: 8px;
            background: rgba(0, 0, 0, 0.55);
            display: grid;
            grid-template-columns: 1.1fr 1fr;
            min-height: 470px;
            overflow: hidden;
        }

        .panel {
            min-width: 0;
            min-height: 0;
            display: flex;
            flex-direction: column;
        }

        .panel + .panel {
            border-left: 1px solid rgba(255, 255, 255, 0.16);
        }

        .right {
            display: grid;
            grid-template-rows: 1fr 0.9fr;
        }

        .right .panel {
            border-left: none;
        }

        .right .panel + .panel {
            border-top: 1px solid rgba(255, 255, 255, 0.16);
        }

        .panel-title {
            padding: 12px 16px 8px;
            font-size: 14px;
            font-weight: 600;
            line-height: 1;
            text-align: center;
            color: rgba(255, 255, 255, 0.9);
            letter-spacing: 0.2px;
            flex-shrink: 0;
            text-transform: uppercase;
        }

        .panel-body {
            flex: 1;
            min-height: 0;
            overflow: auto;
            padding: 0 8px 10px;
        }

        .summary-block {
            margin: 6px 10px 12px;
            color: rgba(255, 255, 255, 0.9);
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .summary-bullets {
            margin: 0;
            padding-left: 16px;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .summary-empty {
            color: rgba(255, 255, 255, 0.55);
            font-size: 12px;
            font-style: italic;
            margin: 10px;
        }
    `;

    static properties = {
        isSessionActive: { type: Boolean },
        hasCompletedRecording: { type: Boolean },
        latestStructuredData: { type: Object },
    };

    constructor() {
        super();
        this.isSessionActive = false;
        this.hasCompletedRecording = false;
        this.latestStructuredData = this.getEmptyStructuredData();

        this.adjustWindowHeight = this.adjustWindowHeight.bind(this);
        this.handleSummaryUpdated = this.handleSummaryUpdated.bind(this);
    }

    getEmptyStructuredData() {
        return {
            insights: {
                nextSentenceToSay: '',
                questionAnswerGuidance: '',
                suggestedFollowUpQuestions: [],
            },
            summaryCard: {
                summary: '',
                bullets: [],
            },
            summary: [],
            topic: { header: '', bullets: [] },
            actions: [],
            followUps: [],
        };
    }

    connectedCallback() {
        super.connectedCallback();
        if (window.api) {
            window.api.listenView.onSessionStateChanged((event, { isActive }) => {
                const wasActive = this.isSessionActive;
                this.isSessionActive = isActive;

                if (!wasActive && isActive) {
                    this.hasCompletedRecording = false;
                    this.latestStructuredData = this.getEmptyStructuredData();
                    this.updateComplete.then(() => {
                        const sttView = this.shadowRoot.querySelector('stt-view');
                        const summaryView = this.shadowRoot.querySelector('summary-view');
                        if (sttView) sttView.resetTranscript();
                        if (summaryView) summaryView.resetAnalysis();
                        this.adjustWindowHeight();
                    });
                }

                if (wasActive && !isActive) {
                    this.hasCompletedRecording = true;
                }
            });
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
    }

    adjustWindowHeight() {
        if (!window.api) return;
        this.updateComplete.then(() => {
            const shell = this.shadowRoot.querySelector('.shell');
            if (!shell) return;
            const targetHeight = Math.min(760, Math.max(460, Math.ceil(shell.scrollHeight + 8)));
            window.api.listenView.adjustWindowHeight('listen', targetHeight);
        });
    }

    handleSummaryUpdated(event) {
        if (event?.detail?.structuredData) {
            this.latestStructuredData = event.detail.structuredData;
        }
        this.adjustWindowHeight();
    }

    handleSttMessagesUpdated() {
        this.adjustWindowHeight();
    }

    getSummaryPanelText() {
        const data = this.latestStructuredData || this.getEmptyStructuredData();
        const summary = data.summaryCard?.summary || data.summary?.[0] || '';
        const bullets = data.summaryCard?.bullets?.length ? data.summaryCard.bullets : data.topic?.bullets || [];
        return [summary, ...bullets.map(item => `• ${item}`)].filter(Boolean).join('\n');
    }

    firstUpdated() {
        this.adjustWindowHeight();
    }

    renderSummaryPanel() {
        const data = this.latestStructuredData || this.getEmptyStructuredData();
        const summary = data.summaryCard?.summary || data.summary?.[0] || '';
        const bullets = data.summaryCard?.bullets?.length ? data.summaryCard.bullets : data.topic?.bullets || [];
        const hasContent = Boolean(summary) || bullets.length > 0;

        if (!hasContent) {
            return html`<div class="summary-empty">No summary yet...</div>`;
        }

        return html`
            ${summary ? html`<div class="summary-block">${summary}</div>` : ''}
            ${bullets.length > 0
                ? html`
                      <div class="summary-block">
                          <ul class="summary-bullets">
                              ${bullets.slice(0, 5).map(item => html`<li>${item}</li>`) }
                          </ul>
                      </div>
                  `
                : ''}
        `;
    }

    render() {
        return html`
            <div class="shell">
                <div class="board">
                    <div class="panel">
                        <div class="panel-title">Insights</div>
                        <div class="panel-body">
                            <summary-view
                                @summary-updated=${this.handleSummaryUpdated}
                                .hasCompletedRecording=${this.hasCompletedRecording}
                            ></summary-view>
                        </div>
                    </div>

                    <div class="right">
                        <div class="panel">
                            <div class="panel-title">Transcript</div>
                            <div class="panel-body">
                                <stt-view @stt-messages-updated=${this.handleSttMessagesUpdated}></stt-view>
                            </div>
                        </div>

                        <div class="panel">
                            <div class="panel-title">Summary</div>
                            <div class="panel-body">
                                ${this.renderSummaryPanel()}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
}

customElements.define('listen-view', ListenView);