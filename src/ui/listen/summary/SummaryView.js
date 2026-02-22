import { html, css, LitElement } from '../../assets/lit-core-2.7.4.min.js';

export class SummaryView extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 100%;
            color: #ffffff;
        }

        .insights-container {
            padding: 10px 12px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .section-title {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.78);
            font-weight: 600;
        }

        .content-block {
            font-size: 12px;
            line-height: 1.45;
            color: rgba(255, 255, 255, 0.92);
            white-space: pre-wrap;
            word-break: break-word;
            padding: 0 2px;
        }

        .question-list {
            margin: 0;
            padding-left: 16px;
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .question-item {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.9);
            cursor: pointer;
            line-height: 1.4;
        }

        .question-item:hover {
            color: #ffffff;
        }

        .empty-state {
            color: rgba(255, 255, 255, 0.58);
            font-size: 12px;
            font-style: italic;
            min-height: 80px;
            display: flex;
            align-items: center;
        }
    `;

    static properties = {
        structuredData: { type: Object },
        hasCompletedRecording: { type: Boolean },
    };

    constructor() {
        super();
        this.hasCompletedRecording = false;
        this.structuredData = this.getEmptyData();
    }

    getEmptyData() {
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
            window.api.summaryView.onSummaryUpdate((event, data) => {
                this.structuredData = data || this.getEmptyData();
                this.requestUpdate();
                this.dispatchEvent(
                    new CustomEvent('summary-updated', {
                        detail: { structuredData: this.structuredData },
                        bubbles: true,
                        composed: true,
                    })
                );
            });
        }
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        if (window.api) {
            window.api.summaryView.removeAllSummaryUpdateListeners();
        }
    }

    resetAnalysis() {
        this.structuredData = this.getEmptyData();
        this.requestUpdate();
    }

    async handleRequestClick(requestText) {
        if (!requestText || !window.api) return;
        try {
            await window.api.summaryView.sendQuestionFromSummary(requestText);
        } catch (error) {
            console.error('Error sending summary question:', error);
        }
    }

    getNormalizedData() {
        const data = this.structuredData || this.getEmptyData();
        const nextSentence = data.insights?.nextSentenceToSay || data.actions?.[0] || '';
        const guidance = data.insights?.questionAnswerGuidance || data.summary?.[0] || '';
        const followUps = (data.insights?.suggestedFollowUpQuestions?.length
            ? data.insights.suggestedFollowUpQuestions
            : data.followUps?.length
            ? data.followUps
            : data.actions || []
        ).slice(0, 4);

        return {
            nextSentence,
            guidance,
            followUps,
        };
    }

    getSummaryText() {
        const data = this.structuredData || this.getEmptyData();
        const normalized = this.getNormalizedData();
        const summary = data.summaryCard?.summary || data.summary?.[0] || '';
        const bullets = data.summaryCard?.bullets?.length ? data.summaryCard.bullets : data.topic?.bullets || [];

        return [
            normalized.nextSentence ? `Best next sentence to say:\n${normalized.nextSentence}` : '',
            normalized.guidance ? `Answer guidance:\n${normalized.guidance}` : '',
            normalized.followUps.length ? `Suggested follow-up questions:\n${normalized.followUps.map(item => `• ${item}`).join('\n')}` : '',
            summary ? `Summary:\n${summary}` : '',
            bullets.length ? `Key points:\n${bullets.map(item => `• ${item}`).join('\n')}` : '',
        ]
            .filter(Boolean)
            .join('\n\n');
    }

    render() {
        const { nextSentence, guidance, followUps } = this.getNormalizedData();
        const hasAnyContent = Boolean(nextSentence) || Boolean(guidance) || followUps.length > 0;

        if (!hasAnyContent) {
            return html`<div class="insights-container"><div class="empty-state">No insights yet...</div></div>`;
        }

        return html`
            <div class="insights-container">
                ${nextSentence
                    ? html`
                          <div>
                              <div class="section-title">Best “next sentence to say”</div>
                              <div class="content-block">${nextSentence}</div>
                          </div>
                      `
                    : ''}

                ${guidance
                    ? html`
                          <div>
                              <div class="section-title">Answer guidance</div>
                              <div class="content-block">${guidance}</div>
                          </div>
                      `
                    : ''}

                ${followUps.length > 0
                    ? html`
                          <div>
                              <div class="section-title">Suggested Follow-up Questions</div>
                              <ol class="question-list">
                                  ${followUps.map(
                                      question => html`
                                          <li class="question-item" @click=${() => this.handleRequestClick(question)}>
                                              ${question}
                                          </li>
                                      `
                                  )}
                              </ol>
                          </div>
                      `
                    : ''}
            </div>
        `;
    }
}

customElements.define('summary-view', SummaryView);