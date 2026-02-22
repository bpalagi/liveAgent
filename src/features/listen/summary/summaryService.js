const { getSystemPrompt } = require('../../common/prompts/promptBuilder.js');
const { createLLM } = require('../../common/ai/factory');
const sessionRepository = require('../../common/repositories/session');
const summaryRepository = require('./repositories');
const modelStateService = require('../../common/services/modelStateService');

class SummaryService {
    constructor() {
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.conversationHistory = [];
        this.currentSessionId = null;

        this.turnsBetweenAnalysis = 3;
        this.lastAnalyzedConversationLength = 0;
        this.analysisInProgress = false;
        this.analysisPending = false;
        this.analysisRunId = 0;

        this.onAnalysisComplete = null;
        this.onStatusUpdate = null;
    }

    setCallbacks({ onAnalysisComplete, onStatusUpdate }) {
        this.onAnalysisComplete = onAnalysisComplete;
        this.onStatusUpdate = onStatusUpdate;
    }

    setSessionId(sessionId) {
        this.currentSessionId = sessionId;
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    addConversationTurn(speaker, text) {
        const conversationText = `${speaker.toLowerCase()}: ${text.trim()}`;
        this.conversationHistory.push(conversationText);
        this.triggerAnalysisIfNeeded();
    }

    getConversationHistory() {
        return this.conversationHistory;
    }

    resetConversationHistory() {
        this.conversationHistory = [];
        this.previousAnalysisResult = null;
        this.analysisHistory = [];
        this.lastAnalyzedConversationLength = 0;
        this.analysisInProgress = false;
        this.analysisPending = false;
        this.analysisRunId = 0;
    }

    formatConversationForPrompt(conversationTexts, maxTurns = 30) {
        if (conversationTexts.length === 0) return '';
        return conversationTexts.slice(-maxTurns).join('\n');
    }

    async makeOutlineAndRequests(conversationTexts, maxTurns = 30) {
        if (conversationTexts.length === 0) {
            return null;
        }

        const recentConversation = this.formatConversationForPrompt(conversationTexts, maxTurns);

        let contextualPrompt = '';
        if (this.previousAnalysisResult) {
            const previousSummary = this.previousAnalysisResult.summaryCard?.summary || this.previousAnalysisResult.summary?.[0] || '';
            const previousBullets = this._normalizeStringArray(
                this.previousAnalysisResult.summaryCard?.bullets?.length
                    ? this.previousAnalysisResult.summaryCard.bullets
                    : this.previousAnalysisResult.topic?.bullets,
                5
            );
            const previousQuestions = this._normalizeStringArray(
                this.previousAnalysisResult.insights?.suggestedFollowUpQuestions?.length
                    ? this.previousAnalysisResult.insights.suggestedFollowUpQuestions
                    : this.previousAnalysisResult.actions,
                4
            );
            contextualPrompt = `
Previous analysis context:
- Summary: ${previousSummary}
- Key points: ${previousBullets.slice(0, 3).join(', ')}
- Suggested follow-up questions: ${previousQuestions.slice(0, 2).join(', ')}

Build on this context while prioritizing the latest conversation turns.
`;
        }

        const basePrompt = getSystemPrompt('pickle_glass_analysis', '', false);
        const systemPrompt = basePrompt.replace('{{CONVERSATION_HISTORY}}', recentConversation);

        try {
            if (this.currentSessionId) {
                await sessionRepository.touch(this.currentSessionId);
            }

            const modelInfo = await modelStateService.getCurrentModelInfo('llm');
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key is not configured.');
            }

            const messages = [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: `${contextualPrompt}

Analyze the conversation and return STRICT JSON only (no markdown, no prose, no code fences) with exactly this schema:
{
  "next_sentence_to_say": "string",
  "question_answer_guidance": "string",
  "suggested_follow_up_questions": ["string"],
  "summary": "string",
  "summary_bullets": ["string"]
}

Rules:
- Output valid JSON only.
- Keep suggested_follow_up_questions to at most 4 items.
- Keep summary_bullets to at most 5 items.
- Keep all fields concise and relevant to the latest turns.`,
                },
            ];

            const llm = createLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                temperature: 0.7,
                maxTokens: 1024,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            const completion = await llm.chat(messages);
            const responseText = completion.content;
            const structuredData = this.parseResponseText(responseText, this.previousAnalysisResult);

            if (this.currentSessionId) {
                try {
                    summaryRepository.saveSummary({
                        sessionId: this.currentSessionId,
                        text: responseText,
                        tldr: structuredData.summaryCard?.summary || structuredData.summary.join('\n'),
                        bullet_json: JSON.stringify(
                            structuredData.summaryCard?.bullets?.length
                                ? structuredData.summaryCard.bullets
                                : structuredData.topic.bullets
                        ),
                        action_json: JSON.stringify(
                            structuredData.insights?.suggestedFollowUpQuestions?.length
                                ? structuredData.insights.suggestedFollowUpQuestions
                                : structuredData.actions
                        ),
                        model: modelInfo.model,
                    });
                } catch (err) {
                    console.error('[DB] Failed to save summary:', err);
                }
            }

            this.previousAnalysisResult = structuredData;
            this.analysisHistory.push({
                timestamp: Date.now(),
                data: structuredData,
                conversationLength: conversationTexts.length,
            });

            if (this.analysisHistory.length > 10) {
                this.analysisHistory.shift();
            }

            return structuredData;
        } catch (error) {
            console.error('❌ Error during analysis generation:', error.message);
            if (this.onStatusUpdate) {
                this.onStatusUpdate('Analysis failed.');
            }
            return null;
        }
    }

    parseResponseText(responseText, previousResult) {
        try {
            const parsedJson = this._extractAndParseJson(responseText);
            if (parsedJson) {
                const normalized = this._normalizeJsonSchema(parsedJson, previousResult);
                return this._buildStructuredDataFromNewSchema(normalized, previousResult);
            }

            return this._parseLegacyMarkdownToNewSchema(responseText, previousResult);
        } catch (error) {
            console.error('❌ Error parsing response text:', error);
            return this._buildStructuredDataFromNewSchema(
                {
                    next_sentence_to_say: previousResult?.insights?.nextSentenceToSay || '',
                    question_answer_guidance: previousResult?.insights?.questionAnswerGuidance || '',
                    suggested_follow_up_questions: previousResult?.insights?.suggestedFollowUpQuestions || previousResult?.actions || [],
                    summary: previousResult?.summaryCard?.summary || previousResult?.summary?.[0] || '',
                    summary_bullets: previousResult?.summaryCard?.bullets || previousResult?.topic?.bullets || [],
                },
                previousResult
            );
        }
    }

    _extractAndParseJson(responseText) {
        if (!responseText || typeof responseText !== 'string') return null;

        const candidates = [];
        const trimmed = responseText.trim();
        if (trimmed) candidates.push(trimmed);

        const jsonBlockMatch = responseText.match(/```json\s*([\s\S]*?)```/i);
        if (jsonBlockMatch?.[1]) candidates.unshift(jsonBlockMatch[1].trim());

        const genericBlockMatch = responseText.match(/```\s*([\s\S]*?)```/i);
        if (genericBlockMatch?.[1]) candidates.push(genericBlockMatch[1].trim());

        const braceStart = responseText.indexOf('{');
        const braceEnd = responseText.lastIndexOf('}');
        if (braceStart !== -1 && braceEnd > braceStart) {
            candidates.push(responseText.slice(braceStart, braceEnd + 1).trim());
        }

        for (const candidate of candidates) {
            try {
                return JSON.parse(candidate);
            } catch {
                continue;
            }
        }

        return null;
    }

    _normalizeString(value, fallback = '') {
        if (typeof value === 'string') {
            const normalized = value.trim();
            if (normalized) return normalized;
        }
        return fallback;
    }

    _normalizeStringArray(value, maxItems = 5, fallback = []) {
        const source = Array.isArray(value) ? value : fallback;
        const deduped = [];
        for (const item of source) {
            const text = this._normalizeString(item);
            if (text && !deduped.includes(text)) deduped.push(text);
            if (deduped.length >= maxItems) break;
        }
        return deduped;
    }

    _normalizeJsonSchema(parsedJson, previousResult) {
        const previousQuestions = this._normalizeStringArray(
            previousResult?.insights?.suggestedFollowUpQuestions?.length
                ? previousResult.insights.suggestedFollowUpQuestions
                : previousResult?.actions,
            4
        );
        const previousBullets = this._normalizeStringArray(
            previousResult?.summaryCard?.bullets?.length
                ? previousResult.summaryCard.bullets
                : previousResult?.topic?.bullets,
            5
        );
        const previousSummary = this._normalizeString(previousResult?.summaryCard?.summary || previousResult?.summary?.[0], '');

        return {
            next_sentence_to_say: this._normalizeString(parsedJson?.next_sentence_to_say, previousResult?.insights?.nextSentenceToSay || ''),
            question_answer_guidance: this._normalizeString(parsedJson?.question_answer_guidance, previousResult?.insights?.questionAnswerGuidance || ''),
            suggested_follow_up_questions: this._normalizeStringArray(parsedJson?.suggested_follow_up_questions, 4, previousQuestions),
            summary: this._normalizeString(parsedJson?.summary, previousSummary),
            summary_bullets: this._normalizeStringArray(parsedJson?.summary_bullets, 5, previousBullets),
        };
    }

    _buildStructuredDataFromNewSchema(normalized, previousResult) {
        const summaryText = this._normalizeString(
            normalized.summary,
            previousResult?.summaryCard?.summary || previousResult?.summary?.[0] || ''
        );
        const bullets = this._normalizeStringArray(
            normalized.summary_bullets,
            5,
            previousResult?.summaryCard?.bullets?.length ? previousResult.summaryCard.bullets : previousResult?.topic?.bullets || []
        );
        const suggestedFollowUps = this._normalizeStringArray(
            normalized.suggested_follow_up_questions,
            4,
            previousResult?.insights?.suggestedFollowUpQuestions?.length
                ? previousResult.insights.suggestedFollowUpQuestions
                : previousResult?.actions || []
        );

        const summary = this._normalizeStringArray([summaryText, ...bullets], 5, previousResult?.summary || []);

        return {
            insights: {
                nextSentenceToSay: this._normalizeString(normalized.next_sentence_to_say, previousResult?.insights?.nextSentenceToSay || ''),
                questionAnswerGuidance: this._normalizeString(
                    normalized.question_answer_guidance,
                    previousResult?.insights?.questionAnswerGuidance || ''
                ),
                suggestedFollowUpQuestions: suggestedFollowUps,
            },
            summaryCard: {
                summary: summaryText,
                bullets,
            },
            summary,
            topic: {
                header: this._normalizeString(previousResult?.topic?.header, 'Summary:'),
                bullets,
            },
            actions: suggestedFollowUps,
            followUps: suggestedFollowUps,
        };
    }

    _parseLegacyMarkdownToNewSchema(responseText, previousResult) {
        const legacy = {
            summary: this._normalizeStringArray(previousResult?.summary, 5),
            topic: {
                header: this._normalizeString(previousResult?.topic?.header, 'Summary:'),
                bullets: this._normalizeStringArray(previousResult?.topic?.bullets, 5),
            },
            actions: this._normalizeStringArray(previousResult?.actions, 4),
        };

        const lines = (responseText || '').split('\n');
        let currentSection = '';

        for (const line of lines) {
            const trimmedLine = line.trim();

            if (trimmedLine.startsWith('**Summary Overview**')) {
                currentSection = 'summary-overview';
                continue;
            }
            if (trimmedLine.startsWith('**Key Topic:')) {
                currentSection = 'topic';
                const topicName = trimmedLine.match(/\*\*Key Topic: (.+?)\*\*/)?.[1] || '';
                if (topicName) legacy.topic.header = `${topicName}:`;
                continue;
            }
            if (trimmedLine.startsWith('**Suggested Questions**')) {
                currentSection = 'questions';
                continue;
            }

            if (trimmedLine.startsWith('-') && currentSection === 'summary-overview') {
                const summaryPoint = this._normalizeString(trimmedLine.substring(1));
                if (summaryPoint && !legacy.summary.includes(summaryPoint)) {
                    legacy.summary.unshift(summaryPoint);
                    legacy.summary = legacy.summary.slice(0, 5);
                }
                continue;
            }

            if (trimmedLine.startsWith('-') && currentSection === 'topic') {
                const bullet = this._normalizeString(trimmedLine.substring(1));
                if (bullet && !legacy.topic.bullets.includes(bullet)) {
                    legacy.topic.bullets.push(bullet);
                    legacy.topic.bullets = legacy.topic.bullets.slice(0, 5);
                }
                continue;
            }

            if (trimmedLine.match(/^\d+\./) && currentSection === 'questions') {
                const question = this._normalizeString(trimmedLine.replace(/^\d+\.\s*/, ''));
                if (question && !legacy.actions.includes(question)) {
                    legacy.actions.push(question);
                    legacy.actions = legacy.actions.slice(0, 4);
                }
            }
        }

        const summaryText = this._normalizeString(legacy.summary[0], previousResult?.summaryCard?.summary || '');
        const bullets = this._normalizeStringArray(legacy.topic.bullets, 5, previousResult?.summaryCard?.bullets || []);
        const followUps = this._normalizeStringArray(legacy.actions, 4, previousResult?.insights?.suggestedFollowUpQuestions || []);

        return this._buildStructuredDataFromNewSchema(
            {
                next_sentence_to_say: previousResult?.insights?.nextSentenceToSay || '',
                question_answer_guidance: previousResult?.insights?.questionAnswerGuidance || '',
                suggested_follow_up_questions: followUps,
                summary: summaryText,
                summary_bullets: bullets,
            },
            previousResult
        );
    }

    async triggerAnalysisIfNeeded() {
        const interval = this.turnsBetweenAnalysis || 3;
        const currentLength = this.conversationHistory.length;

        if (currentLength < interval) return;
        const targetLength = Math.floor(currentLength / interval) * interval;
        if (targetLength <= this.lastAnalyzedConversationLength) return;

        if (this.analysisInProgress) {
            this.analysisPending = true;
            return;
        }

        this.analysisInProgress = true;
        this.analysisPending = false;

        const snapshot = [...this.conversationHistory];
        const snapshotLength = snapshot.length;
        const targetLengthForRun = Math.floor(snapshotLength / interval) * interval;
        const runId = ++this.analysisRunId;

        try {
            const data = await this.makeOutlineAndRequests(snapshot);
            if (data) {
                data.meta = {
                    conversationLength: snapshotLength,
                    milestoneConversationLength: targetLengthForRun,
                    analysisRunId: runId,
                    createdAt: Date.now(),
                };

                this.sendToRenderer('summary-update', data);

                if (this.onAnalysisComplete) {
                    this.onAnalysisComplete(data);
                }

                this.lastAnalyzedConversationLength = targetLengthForRun;
            }
        } finally {
            this.analysisInProgress = false;
            if (this.analysisPending) {
                this.analysisPending = false;
                this.triggerAnalysisIfNeeded();
            }
        }
    }

    getCurrentAnalysisData() {
        return {
            previousResult: this.previousAnalysisResult,
            history: this.analysisHistory,
            conversationLength: this.conversationHistory.length,
        };
    }
}

module.exports = SummaryService;