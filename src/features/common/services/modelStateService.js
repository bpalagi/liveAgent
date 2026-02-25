const { EventEmitter } = require('events');
const Store = require('electron-store');
const { PROVIDERS, getProviderClass } = require('../ai/factory');
const encryptionService = require('./encryptionService');
const providerSettingsRepository = require('../repositories/providerSettings');
const authService = require('./authService');
const ollamaModelRepository = require('../repositories/ollamaModel');

class ModelStateService extends EventEmitter {
    constructor() {
        super();
        this.authService = authService;
        // electron-store is used only for legacy data migration purposes.
        this.store = new Store({ name: 'pickle-glass-model-state' });
    }

    async initialize() {
        console.log('[ModelStateService] Initializing one-time setup...');
        await this._initializeEncryption();
        await this._runMigrations();
        await this._ensureDefaultProviders();
        this.setupLocalAIStateSync();
        await this._autoSelectAvailableModels([], true);
        console.log('[ModelStateService] One-time setup complete.');
    }

    /**
     * Ensure default providers are always available so the app can start
     * without requiring the user to go through the API-key / login flow.
     * Whisper (local STT) is provisioned automatically.
     * Environment-variable API keys are auto-provisioned for LLM + STT.
     */
    async _ensureDefaultProviders() {
        // --- Auto-provision API keys from environment variables ---
        const ENV_KEY_MAP = {
            gemini:    ['GEMINI_API_KEY'],
            openai:    ['OPENAI_API_KEY'],
            anthropic: ['ANTHROPIC_API_KEY'],
            deepgram:  ['DEEPGRAM_API_KEY'],
            zen:       ['ZEN_API_KEY', 'OPENCODE_API_KEY'],
        };

        for (const [provider, envNames] of Object.entries(ENV_KEY_MAP)) {
            const existing = await providerSettingsRepository.getByProvider(provider);
            if (existing && existing.api_key) continue;           // already configured

            const envKey = envNames.map(n => process.env[n]).find(v => v && v.trim());
            if (envKey) {
                console.log(`[ModelStateService] Auto-provisioning ${provider} from env var`);
                await providerSettingsRepository.upsert(provider, {
                    ...(existing || {}),
                    api_key: envKey.trim(),
                });
            }
        }

        // --- Provision Whisper as default STT — it runs locally, no API key needed ---
        const whisperSettings = await providerSettingsRepository.getByProvider('whisper');
        if (!whisperSettings || !whisperSettings.api_key) {
            console.log('[ModelStateService] Provisioning Whisper as default STT provider...');
            await providerSettingsRepository.upsert('whisper', { api_key: 'local' });
        }

        // If no STT model is currently active, select whisper-medium.
        const activeStt = await providerSettingsRepository.getActiveProvider('stt');
        if (!activeStt) {
            console.log('[ModelStateService] Auto-selecting whisper-medium as default STT model...');
            await this.setSelectedModel('stt', 'whisper-medium');
        }

        // If no LLM model is currently active, auto-select the first available.
        const activeLlm = await providerSettingsRepository.getActiveProvider('llm');
        if (!activeLlm) {
            const available = await this.getAvailableModels('llm');
            if (available.length > 0) {
                console.log(`[ModelStateService] Auto-selecting LLM model: ${available[0].id}`);
                await this.setSelectedModel('llm', available[0].id);
            }
        }
    }

    async _initializeEncryption() {
        try {
            const rows = await providerSettingsRepository.getRawApiKeys();
            if (rows.some(r => r.api_key && encryptionService.looksEncrypted(r.api_key))) {
                console.log('[ModelStateService] Encrypted keys detected, initializing encryption...');
                const userIdForMigration = this.authService.getCurrentUserId();
                await encryptionService.initializeKey(userIdForMigration);
            } else {
                console.log('[ModelStateService] No encrypted keys detected, skipping encryption initialization.');
            }
        } catch (err) {
            console.warn('[ModelStateService] Error while checking encrypted keys:', err.message);
        }
    }

    async _runMigrations() {
        console.log('[ModelStateService] Checking for data migrations...');
        const userId = this.authService.getCurrentUserId();
        
        try {
            const sqliteClient = require('./sqliteClient');
            const db = sqliteClient.getDb();
            const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_model_selections'").get();
            
            if (tableExists) {
                const selections = db.prepare('SELECT * FROM user_model_selections WHERE uid = ?').get(userId);
                if (selections) {
                    console.log('[ModelStateService] Migrating from user_model_selections table...');
                    if (selections.llm_model) {
                        const llmProvider = this.getProviderForModel(selections.llm_model, 'llm');
                        if (llmProvider) {
                            await this.setSelectedModel('llm', selections.llm_model);
                        }
                    }
                    if (selections.stt_model) {
                        const sttProvider = this.getProviderForModel(selections.stt_model, 'stt');
                        if (sttProvider) {
                            await this.setSelectedModel('stt', selections.stt_model);
                        }
                    }
                    db.prepare('DROP TABLE user_model_selections').run();
                    console.log('[ModelStateService] user_model_selections migration complete.');
                }
            }
        } catch (error) {
            console.error('[ModelStateService] user_model_selections migration failed:', error);
        }

        try {
            const legacyData = this.store.get(`users.${userId}`);
            if (legacyData && legacyData.apiKeys) {
                console.log('[ModelStateService] Migrating from electron-store...');
                for (const [provider, apiKey] of Object.entries(legacyData.apiKeys)) {
                    if (apiKey && PROVIDERS[provider]) {
                        await this.setApiKey(provider, apiKey);
                    }
                }
                if (legacyData.selectedModels?.llm) {
                    await this.setSelectedModel('llm', legacyData.selectedModels.llm);
                }
                if (legacyData.selectedModels?.stt) {
                    await this.setSelectedModel('stt', legacyData.selectedModels.stt);
                }
                this.store.delete(`users.${userId}`);
                console.log('[ModelStateService] electron-store migration complete.');
            }
        } catch (error) {
            console.error('[ModelStateService] electron-store migration failed:', error);
        }
    }
    
    setupLocalAIStateSync() {
        const localAIManager = require('./localAIManager');
        localAIManager.on('state-changed', (service, status) => {
            this.handleLocalAIStateChange(service, status);
        });
    }

    async handleLocalAIStateChange(service, state) {
        console.log(`[ModelStateService] LocalAI state changed: ${service}`, state);

        // Skip Ollama entirely - never process or register it
        if (service === 'ollama') {
            console.log(`[ModelStateService] Ignoring Ollama state change - Ollama is disabled`);
            return;
        }

        // Auto-register local providers with api_key='local' when detected as installed
        if (state.installed) {
            const existing = await providerSettingsRepository.getByProvider(service);
            if (!existing || !existing.api_key) {
                console.log(`[ModelStateService] Auto-registering ${service} with api_key='local'`);
                const settings = existing || {};
                await providerSettingsRepository.upsert(service, { ...settings, api_key: 'local' });
            }
        }

        // Only trigger auto-selection if the service is actually available (installed AND running)
        // This prevents unnecessary model switches when services are not running
        // Note: We only auto-select LLM models now - STT models remain constant
        const types = [];
        // STT models are no longer auto-switched when services become available
        // if (service === 'whisper' && state.installed) {
        //     types.push('stt');
        // }
        
        if (types.length > 0) {
            await this._autoSelectAvailableModels(types);
            this.emit('state-updated', await this.getLiveState());
        }
    }

    async getLiveState() {
        const providerSettings = await providerSettingsRepository.getAll();
        const apiKeys = {};
        Object.keys(PROVIDERS).forEach(provider => {
            const setting = providerSettings.find(s => s.provider === provider);
            apiKeys[provider] = setting?.api_key || null;
        });

        const activeSettings = await providerSettingsRepository.getActiveSettings();
        const selectedModels = {
            llm: activeSettings.llm?.selected_llm_model || null,
            stt: activeSettings.stt?.selected_stt_model || null
        };
        
        return { apiKeys, selectedModels };
    }

    async _autoSelectAvailableModels(forceReselectionForTypes = [], isInitialBoot = false) {
        console.log(`[ModelStateService] Running auto-selection. Force re-selection for: [${forceReselectionForTypes.join(', ')}]`);
        const { apiKeys, selectedModels } = await this.getLiveState();
        // Only auto-select LLM models - STT models should remain constant after initial selection
        const types = ['llm'];

        for (const type of types) {
            const currentModelId = selectedModels[type];
            let isCurrentModelValid = false;
            const forceReselection = forceReselectionForTypes.includes(type);

            // Skip STT model selection if a listening session is active
            if (type === 'stt' && currentModelId) {
                try {
                    const listenService = require('../listen/listenService');
                    if (listenService.isSessionActive()) {
                        console.log(`[ModelStateService] STT session is active, skipping model auto-selection to avoid interruption`);
                        continue;
                    }
                } catch (err) {
                    // listenService might not be initialized, continue with normal flow
                }
            }

            if (currentModelId && !forceReselection) {
                const provider = this.getProviderForModel(currentModelId, type);
                const apiKey = apiKeys[provider];
                if (provider && apiKey) {
                    isCurrentModelValid = true;
                }
            }

            if (!isCurrentModelValid) {
                console.log(`[ModelStateService] No valid ${type.toUpperCase()} model selected or selection forced. Finding an alternative...`);
                const availableModels = await this.getAvailableModels(type);
                console.log(`[ModelStateService] Available ${type.toUpperCase()} models:`, availableModels.map(m => `${m.id} (${this.getProviderForModel(m.id, type)})`));
                
                if (availableModels.length > 0) {
                    let newModel;
                    if (forceReselection) {
                        // When force-reselecting, prefer Whisper for STT, API providers for LLM
                        if (type === 'stt') {
                            const whisperModel = availableModels.find(model => {
                                const provider = this.getProviderForModel(model.id, type);
                                return provider === 'whisper' && model.id === 'whisper-medium';
                            });
                            // If medium not found, get any whisper model
                            const anyWhisperModel = whisperModel || availableModels.find(model => {
                                const provider = this.getProviderForModel(model.id, type);
                                return provider === 'whisper';
                            });
                            newModel = anyWhisperModel || availableModels[0];
                            console.log(`[ModelStateService] Force re-selecting STT: chose ${newModel.id} (provider: ${this.getProviderForModel(newModel.id, type)})`);
                        } else {
                            // For LLM, prefer API providers
                            const apiModel = availableModels.find(model => {
                                const provider = this.getProviderForModel(model.id, type);
                                return provider && provider !== 'whisper';
                            });
                            newModel = apiModel || availableModels[0];
                        }
                    } else {
                        // On initial/normal selection, prefer API providers over local (except Whisper for STT)
                        if (type === 'stt') {
                            // For STT, Whisper medium is preferred
                            const whisperModel = availableModels.find(model => {
                                const provider = this.getProviderForModel(model.id, type);
                                return provider === 'whisper' && model.id === 'whisper-medium';
                            });
                            // If medium not found, get any whisper model
                            const anyWhisperModel = whisperModel || availableModels.find(model => {
                                const provider = this.getProviderForModel(model.id, type);
                                return provider === 'whisper';
                            });
                            newModel = anyWhisperModel || availableModels[0];
                            console.log(`[ModelStateService] Normal STT selection: chose ${newModel.id} (provider: ${this.getProviderForModel(newModel.id, type)})`);
                        } else {
                            // For LLM, prefer API providers
                            const apiModel = availableModels.find(model => {
                                const provider = this.getProviderForModel(model.id, type);
                                return provider && provider !== 'ollama' && provider !== 'whisper';
                            });
                            newModel = apiModel || availableModels[0];
                        }
                    }
                    await this.setSelectedModel(type, newModel.id);
                    console.log(`[ModelStateService] Auto-selected ${type.toUpperCase()} model: ${newModel.id}`);
                } else {
                    await providerSettingsRepository.setActiveProvider(null, type);
                    if (!isInitialBoot) {
                       this.emit('state-updated', await this.getLiveState());
                    }
                }
            }
        }
    }
    
    async setFirebaseVirtualKey(virtualKey) {
        console.log(`[ModelStateService] Setting Firebase virtual key.`);

        // Before setting the key, check if the previous openai-glass key existed.
        const previousSettings = await providerSettingsRepository.getByProvider('openai-glass');
        const wasPreviouslyConfigured = !!previousSettings?.api_key;

        // Always update with the new virtual key.
        await this.setApiKey('openai-glass', virtualKey);

        if (virtualKey) {
            // Only set default models on first-time setup
            if (!wasPreviouslyConfigured) {
                // This now uses whisper-medium as the default STT model
                console.log('[ModelStateService] First-time setup for openai-glass, setting default models.');
                const llmModel = PROVIDERS['openai-glass']?.llmModels[0];
                if (llmModel) await this.setSelectedModel('llm', llmModel.id);
                // Override STT to use whisper-medium for better quality
                await this.setSelectedModel('stt', 'whisper-medium');
            } else {
                console.log('[ModelStateService] openai-glass key updated, but respecting user\'s existing model selection.');
            }
        } else {
            // On logout, switch to another model only if the currently active model is openai-glass.
            const selected = await this.getSelectedModels();
            const llmProvider = this.getProviderForModel(selected.llm, 'llm');
            const sttProvider = this.getProviderForModel(selected.stt, 'stt');
            
            const typesToReselect = [];
            if (llmProvider === 'openai-glass') typesToReselect.push('llm');
            if (sttProvider === 'openai-glass') typesToReselect.push('stt');

            if (typesToReselect.length > 0) {
                // Only auto-select LLM models - STT models remain constant
                const llmTypesToReselect = typesToReselect.filter(t => t === 'llm');
                if (llmTypesToReselect.length > 0) {
                    console.log('[ModelStateService] Logged out, re-selecting LLM models');
                    await this._autoSelectAvailableModels(llmTypesToReselect);
                }
            }
        }
    }

    async setApiKey(provider, key) {
        console.log(`[ModelStateService] setApiKey for ${provider}`);
        if (!provider) {
            throw new Error('Provider is required');
        }

        // 'openai-glass' uses its own authentication key, so skip validation.
        if (provider !== 'openai-glass') {
            const validationResult = await this.validateApiKey(provider, key);
            if (!validationResult.success) {
                console.warn(`[ModelStateService] API key validation failed for ${provider}: ${validationResult.error}`);
                return validationResult;
            }
        }

        const finalKey = (provider === 'ollama' || provider === 'whisper') ? 'local' : key;
        const existingSettings = await providerSettingsRepository.getByProvider(provider) || {};
        await providerSettingsRepository.upsert(provider, { ...existingSettings, api_key: finalKey });
        
        // Only auto-select LLM models when keys are added/changed - STT models remain constant
        await this._autoSelectAvailableModels([]);
        
        this.emit('state-updated', await this.getLiveState());
        this.emit('settings-updated');
        return { success: true };
    }

    async getAllApiKeys() {
        const allSettings = await providerSettingsRepository.getAll();
        const apiKeys = {};
        allSettings.forEach(s => {
            if (s.provider !== 'openai-glass') {
                apiKeys[s.provider] = s.api_key;
            }
        });
        return apiKeys;
    }

    async removeApiKey(provider) {
        const setting = await providerSettingsRepository.getByProvider(provider);
        if (setting && setting.api_key) {
            await providerSettingsRepository.upsert(provider, { ...setting, api_key: null });
            // Only auto-select LLM models when API keys are removed - STT models remain constant
            await this._autoSelectAvailableModels(['llm']);
            this.emit('state-updated', await this.getLiveState());
            this.emit('settings-updated');
            return true;
        }
        return false;
    }

    /**
     * Check if user is logged in to Firebase.
     */
    isLoggedInWithFirebase() {
        return this.authService.getCurrentUser().isLoggedIn;
    }

    /**
     * Check if at least one valid API key is configured.
     */
    async hasValidApiKey() {
        if (this.isLoggedInWithFirebase()) return true;
        
        const allSettings = await providerSettingsRepository.getAll();
        return allSettings.some(s => s.api_key && s.api_key.trim().length > 0);
    }

    getProviderForModel(arg1, arg2) {
        // Compatibility: support both (type, modelId) old order and (modelId, type) new order
        let type, modelId;
        if (arg1 === 'llm' || arg1 === 'stt') {
            type = arg1;
            modelId = arg2;
        } else {
            modelId = arg1;
            type = arg2;
        }
        if (!modelId || !type) return null;
        for (const providerId in PROVIDERS) {
            // Skip Ollama - it's disabled
            if (providerId === 'ollama') continue;
            
            const models = type === 'llm' ? PROVIDERS[providerId].llmModels : PROVIDERS[providerId].sttModels;
            if (models && models.some(m => m.id === modelId)) {
                return providerId;
            }
        }
        // Remove Ollama fallback check - Ollama is disabled
        return null;
    }

    async getSelectedModels() {
        const active = await providerSettingsRepository.getActiveSettings();
        return {
            llm: active.llm?.selected_llm_model || null,
            stt: active.stt?.selected_stt_model || null,
        };
    }
    
    async setSelectedModel(type, modelId) {
        const provider = this.getProviderForModel(modelId, type);
        if (!provider) {
            console.warn(`[ModelStateService] No provider found for model ${modelId}`);
            return false;
        }

        const existingSettings = await providerSettingsRepository.getByProvider(provider) || {};
        const newSettings = { ...existingSettings };

        if (type === 'llm') {
            newSettings.selected_llm_model = modelId;
        } else {
            newSettings.selected_stt_model = modelId;
        }
        
        await providerSettingsRepository.upsert(provider, newSettings);
        await providerSettingsRepository.setActiveProvider(provider, type);
        
        console.log(`[ModelStateService] Selected ${type} model: ${modelId} (provider: ${provider})`);
        
        // Skip Ollama warm-up - Ollama is disabled
        if (type === 'llm' && provider === 'ollama') {
            console.log(`[ModelStateService] Skipping Ollama warm-up - Ollama is disabled`);
        }
        
        this.emit('state-updated', await this.getLiveState());
        this.emit('settings-updated');
        return true;
    }

    async getAvailableModels(type) {
        const allSettings = await providerSettingsRepository.getAll();
        const available = [];
        const modelListKey = type === 'llm' ? 'llmModels' : 'sttModels';

        for (const setting of allSettings) {
            if (!setting.api_key) continue;

            const providerId = setting.provider;
            // Skip Ollama entirely - never include its models
            if (providerId === 'ollama') {
                continue;
            } else if (PROVIDERS[providerId]?.[modelListKey]) {
                available.push(...PROVIDERS[providerId][modelListKey]);
            }
        }
        return [...new Map(available.map(item => [item.id, item])).values()];
    }

    async getCurrentModelInfo(type) {
        const activeSetting = await providerSettingsRepository.getActiveProvider(type);
        if (!activeSetting) return null;
        
        const model = type === 'llm' ? activeSetting.selected_llm_model : activeSetting.selected_stt_model;
        if (!model) return null;

        return {
            provider: activeSetting.provider,
            model: model,
            apiKey: activeSetting.api_key,
        };
    }

    // --- Handler and Utility Methods ---

    async validateApiKey(provider, key) {
        if (!key || (key.trim() === '' && provider !== 'ollama' && provider !== 'whisper')) {
            return { success: false, error: 'API key cannot be empty.' };
        }
        const ProviderClass = getProviderClass(provider);
        if (!ProviderClass || typeof ProviderClass.validateApiKey !== 'function') {
            return { success: true };
        }
        try {
            return await ProviderClass.validateApiKey(key);
        } catch (error) {
            return { success: false, error: 'An unexpected error occurred during validation.' };
        }
    }

    getProviderConfig() {
        const config = {};
        for (const key in PROVIDERS) {
            const { handler, ...rest } = PROVIDERS[key];
            config[key] = rest;
        }
        return config;
    }
    
    async handleRemoveApiKey(provider) {
        const success = await this.removeApiKey(provider);
        if (success) {
            const selectedModels = await this.getSelectedModels();
            if (!selectedModels.llm && !selectedModels.stt) {
                this.emit('force-show-apikey-header');
            }
        }
        return success;
    }

    /*-------------- Compatibility Helpers --------------*/
    async handleValidateKey(provider, key) {
        return await this.setApiKey(provider, key);
    }

    async handleSetSelectedModel(type, modelId) {
        return await this.setSelectedModel(type, modelId);
    }

    async areProvidersConfigured() {
        // Always return true — the login / API-key gate has been removed.
        // Default providers (Whisper STT) are auto-provisioned at startup.
        return true;
    }
}

const modelStateService = new ModelStateService();
module.exports = modelStateService;