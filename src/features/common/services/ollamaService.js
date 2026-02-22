const { EventEmitter } = require('events');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { app } = require('electron');
const { spawnAsync } = require('../utils/spawnHelper');
const { DOWNLOAD_CHECKSUMS } = require('../config/checksums');
const ollamaModelRepository = require('../repositories/ollamaModel');

const execAsync = promisify(exec);

class OllamaService extends EventEmitter {
    constructor() {
        super();
        this.serviceName = 'OllamaService';
        this.baseUrl = 'http://localhost:11434';
        
        // Simplified state management
        this.installState = {
            isInstalled: false,
            isInstalling: false,
            progress: 0
        };
        
        // Simplified request management (remove complex queue)
        this.activeRequest = null;
        this.requestTimeout = 30000; // 30 second timeout
        
        // Model status
        this.installedModels = new Map();
        this.modelWarmupStatus = new Map();
        
        // Checkpoint system (for rollback)
        this.installCheckpoints = [];
        
        // Installation progress management
        this.installationProgress = new Map();
        
        // Warming related (keep existing)
        this.warmingModels = new Map();
        this.warmedModels = new Set();
        this.lastWarmUpAttempt = new Map();
        this.warmupTimeout = 120000; // 120s for model warmup
        
        // State synchronization
        this._lastState = null;
        this._syncInterval = null;
        this._lastLoadedModels = [];
        this.modelLoadStatus = new Map();
        
        // Service termination state tracking
        this.isShuttingDown = false;
    }


    // Base class methods integration
    getPlatform() {
        return process.platform;
    }

    async checkCommand(command) {
        try {
            const platform = this.getPlatform();
            const checkCmd = platform === 'win32' ? 'where' : 'which';
            const { stdout } = await execAsync(`${checkCmd} ${command}`);
            return stdout.trim();
        } catch (error) {
            return null;
        }
    }

    async waitForService(checkFn, maxAttempts = 30, delayMs = 1000) {
        for (let i = 0; i < maxAttempts; i++) {
            if (await checkFn()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        throw new Error(`${this.serviceName} service failed to start within timeout`);
    }

    getInstallProgress(modelName) {
        return this.installationProgress.get(modelName) || 0;
    }

    setInstallProgress(modelName, progress) {
        this.installationProgress.set(modelName, progress);
    }

    clearInstallProgress(modelName) {
        this.installationProgress.delete(modelName);
    }

    async getStatus() {
        try {
            const installed = await this.isInstalled();
            if (!installed) {
                return { success: true, installed: false, running: false, models: [] };
            }

            const running = await this.isServiceRunning();
            if (!running) {
                return { success: true, installed: true, running: false, models: [] };
            }

            const models = await this.getInstalledModels();
            return { success: true, installed: true, running: true, models };
        } catch (error) {
            console.error('[OllamaService] Error getting status:', error);
            return { success: false, error: error.message, installed: false, running: false, models: [] };
        }
    }

    getOllamaCliPath() {
        if (this.getPlatform() === 'darwin') {
            return '/Applications/Ollama.app/Contents/Resources/ollama';
        }
        return 'ollama';
    }

    // === Runtime Management (Simplified) ===
    async makeRequest(endpoint, options = {}) {
        // Do not request if service is shutting down
        if (this.isShuttingDown) {
            throw new Error('Service is shutting down');
        }
        
        // Prevent concurrent requests (simple lock)
        if (this.activeRequest) {
            await this.activeRequest;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

        this.activeRequest = fetch(`${this.baseUrl}${endpoint}`, {
            ...options,
            signal: controller.signal
        }).finally(() => {
            clearTimeout(timeoutId);
            this.activeRequest = null;
        });

        return this.activeRequest;
    }

    async isInstalled() {
        try {
            const platform = this.getPlatform();
            
            if (platform === 'darwin') {
                try {
                    await fs.access('/Applications/Ollama.app');
                    return true;
                } catch {
                    const ollamaPath = await this.checkCommand(this.getOllamaCliPath());
                    return !!ollamaPath;
                }
            } else {
                const ollamaPath = await this.checkCommand(this.getOllamaCliPath());
                return !!ollamaPath;
            }
        } catch (error) {
            return false;
        }
    }

    async isServiceRunning() {
        try {
            // Use /api/ps to check if service is running
            // This is more reliable than /api/tags which may not show models not in memory
            const response = await this.makeRequest('/api/ps', {
                method: 'GET'
            });
            
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    async startService() {
        // Reset shutdown flag when starting service
        this.isShuttingDown = false;
        
        const platform = this.getPlatform();
        
        try {
            if (platform === 'darwin') {
                try {
                    await spawnAsync('open', ['-a', 'Ollama']);
                    await this.waitForService(() => this.isServiceRunning());
                    return true;
                } catch {
                    spawn(this.getOllamaCliPath(), ['serve'], {
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                    await this.waitForService(() => this.isServiceRunning());
                    return true;
                }
            } else {
                spawn(this.getOllamaCliPath(), ['serve'], {
                    detached: true,
                    stdio: 'ignore',
                    shell: platform === 'win32'
                }).unref();
                await this.waitForService(() => this.isServiceRunning());
                return true;
            }
        } catch (error) {
            console.error('[OllamaService] Failed to start service:', error);
            throw error;
        }
    }

    async stopService() {
        return await this.shutdown();
    }

    // Comprehensive health check using multiple endpoints
    async healthCheck() {
        try {
            const checks = {
                serviceRunning: false,
                apiResponsive: false,
                modelsAccessible: false,
                memoryStatus: false
            };
            
            // 1. Basic service check with /api/ps
            try {
                const psResponse = await this.makeRequest('/api/ps', { method: 'GET' });
                checks.serviceRunning = psResponse.ok;
                checks.memoryStatus = psResponse.ok;
            } catch (error) {
            }
            
            // 2. Check if API is responsive with root endpoint
            try {
                const rootResponse = await this.makeRequest('/', { method: 'GET' });
                checks.apiResponsive = rootResponse.ok;
            } catch (error) {
            }
            
            // 3. Check if models endpoint is accessible
            try {
                const tagsResponse = await this.makeRequest('/api/tags', { method: 'GET' });
                checks.modelsAccessible = tagsResponse.ok;
            } catch (error) {
            }
            
            const allHealthy = Object.values(checks).every(v => v === true);
            
            return {
                healthy: allHealthy,
                checks,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('[OllamaService] Health check failed:', error);
            return {
                healthy: false,
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    async getInstalledModels() {
        // Return empty array if service is shutting down
        if (this.isShuttingDown) {
            return [];
        }
        
        try {
            const response = await this.makeRequest('/api/tags', {
                method: 'GET'
            });
            
            const data = await response.json();
            return data.models || [];
        } catch (error) {
            console.error('[OllamaService] Failed to get installed models:', error.message);
            return [];
        }
    }

    // Get models currently loaded in memory using /api/ps
    async getLoadedModels() {
        // Return empty array if service is shutting down
        if (this.isShuttingDown) {
            return [];
        }
        
        try {
            const response = await this.makeRequest('/api/ps', {
                method: 'GET'
            });
            
            if (!response.ok) {
                return [];
            }
            
            const data = await response.json();
            // Extract model names from running processes
            return (data.models || []).map(m => m.name);
        } catch (error) {
            console.error('[OllamaService] Error getting loaded models:', error);
            return [];
        }
    }
    
    // Get detailed memory info for loaded models
    async getLoadedModelsWithMemoryInfo() {
        try {
            const response = await this.makeRequest('/api/ps', {
                method: 'GET'
            });
            
            if (!response.ok) {
                return [];
            }
            
            const data = await response.json();
            // Return full model info including memory usage
            return data.models || [];
        } catch (error) {
            console.error('[OllamaService] Error getting loaded models info:', error);
            return [];
        }
    }
    
    // Check if a specific model is loaded in memory
    async isModelLoaded(modelName) {
        const loadedModels = await this.getLoadedModels();
        return loadedModels.includes(modelName);
    }

    async getInstalledModelsList() {
        try {
            const { stdout } = await spawnAsync(this.getOllamaCliPath(), ['list']);
            const lines = stdout.split('\n').filter(line => line.trim());
            
            // Skip header line (NAME, ID, SIZE, MODIFIED)
            const modelLines = lines.slice(1);
            
            const models = [];
            for (const line of modelLines) {
                if (!line.trim()) continue;
                
                // Parse line: "model:tag    model_id    size    modified_time"
                const parts = line.split(/\s+/);
                if (parts.length >= 3) {
                    models.push({
                        name: parts[0],
                        id: parts[1],
                        size: parts[2] + (parts[3] === 'GB' || parts[3] === 'MB' ? ' ' + parts[3] : ''),
                        status: 'installed'
                    });
                }
            }
            
            return models;
        } catch (error) {
            // Fallback to API if CLI fails
            const apiModels = await this.getInstalledModels();
            return apiModels.map(model => ({
                name: model.name,
                id: model.digest || 'unknown',
                size: model.size || 'Unknown',
                status: 'installed'
            }));
        }
    }

    async getModelSuggestions() {
        try {
            // Get actually installed models
            const installedModels = await this.getInstalledModelsList();
            
            // Get user input history from storage (we'll implement this in the frontend)
            // For now, just return installed models
            return installedModels;
        } catch (error) {
            console.error('[OllamaService] Failed to get model suggestions:', error);
            return [];
        }
    }

    async isModelInstalled(modelName) {
        const models = await this.getInstalledModels();
        return models.some(model => model.name === modelName);
    }

    async pullModel(modelName) {
        if (!modelName?.trim()) {
            throw new Error(`Invalid model name: ${modelName}`);
        }
        
        // Emit progress event - LocalAIManager will handle
        this.emit('install-progress', { 
            model: modelName, 
            progress: 0,
            status: 'starting'
        });
        
        try {
            const response = await fetch(`${this.baseUrl}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelName,
                    stream: true
                })
            });

            if (!response.ok) {
                throw new Error(`Pull API failed: ${response.status} ${response.statusText}`);
            }

            // Handle Node.js streaming response
            return new Promise((resolve, reject) => {
                let buffer = '';
                
                response.body.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    
                    // Keep incomplete line in buffer
                    buffer = lines.pop() || '';
                    
                    // Process complete lines
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        
                        try {
                            const data = JSON.parse(line);
                            const progress = this._parseOllamaPullProgress(data, modelName);
                            
                            if (progress !== null) {
                                this.setInstallProgress(modelName, progress);
                                // Emit progress event - LocalAIManager will handle
                                this.emit('install-progress', { 
                                    model: modelName, 
                                    progress,
                                    status: data.status || 'downloading'
                                });
                            }

                            // Handle completion
                            if (data.status === 'success') {
                                this.emit('model-pull-complete', { model: modelName });
                                this.clearInstallProgress(modelName);
                                resolve();
                                return;
                            }
                        } catch (parseError) {
                            console.warn('[OllamaService] Failed to parse response line:', line);
                        }
                    }
                });

                response.body.on('end', () => {
                    // Process any remaining data in buffer
                    if (buffer.trim()) {
                        try {
                            const data = JSON.parse(buffer);
                            if (data.status === 'success') {
                                this.emit('model-pull-complete', { model: modelName });
                            }
                        } catch (parseError) {
                            console.warn('[OllamaService] Failed to parse final buffer:', buffer);
                        }
                    }
                    this.clearInstallProgress(modelName);
                    resolve();
                });

                response.body.on('error', (error) => {
                    console.error(`[OllamaService] Stream error for ${modelName}:`, error);
                    this.clearInstallProgress(modelName);
                    reject(error);
                });
            });
        } catch (error) {
            this.clearInstallProgress(modelName);
            console.error(`[OllamaService] Pull model failed:`, error);
            throw error;
        }
    }

    _parseOllamaPullProgress(data, modelName) {
        // Handle Ollama API response format
        if (data.status === 'success') {
            return 100;
        }

        // Handle downloading progress
        if (data.total && data.completed !== undefined) {
            const progress = Math.round((data.completed / data.total) * 100);
            return Math.min(progress, 99); // Don't show 100% until success
        }

        // Handle status-based progress
        const statusProgress = {
            'pulling manifest': 5,
            'downloading': 10,
            'verifying sha256 digest': 90,
            'writing manifest': 95,
            'removing any unused layers': 98
        };

        if (data.status && statusProgress[data.status] !== undefined) {
            return statusProgress[data.status];
        }

        return null;
    }



    async downloadFile(url, destination, options = {}) {
        const { 
            onProgress = null,
            headers = { 'User-Agent': 'Glass-App' },
            timeout = 300000,
            modelId = null
        } = options;

        return new Promise((resolve, reject) => {
            const file = require('fs').createWriteStream(destination);
            let downloadedSize = 0;
            let totalSize = 0;

            const request = https.get(url, { headers }, (response) => {
                if ([301, 302, 307, 308].includes(response.statusCode)) {
                    file.close();
                    require('fs').unlink(destination, () => {});

                    if (!response.headers.location) {
                        reject(new Error('Redirect without location header'));
                        return;
                    }

                    this.downloadFile(response.headers.location, destination, options)
                        .then(resolve)
                        .catch(reject);
                    return;
                }

                if (response.statusCode !== 200) {
                    file.close();
                    require('fs').unlink(destination, () => {});
                    reject(new Error(`Download failed: ${response.statusCode} ${response.statusMessage}`));
                    return;
                }

                totalSize = parseInt(response.headers['content-length'], 10) || 0;

                response.on('data', (chunk) => {
                    downloadedSize += chunk.length;

                    if (totalSize > 0) {
                        const progress = Math.round((downloadedSize / totalSize) * 100);

                        if (onProgress) {
                            onProgress(progress, downloadedSize, totalSize);
                        }
                    }
                });

                response.pipe(file);

                file.on('finish', () => {
                    file.close(() => {
                        resolve({ success: true, size: downloadedSize });
                    });
                });
            });

            request.on('timeout', () => {
                request.destroy();
                file.close();
                require('fs').unlink(destination, () => {});
                reject(new Error('Download timeout'));
            });

            request.on('error', (err) => {
                file.close();
                require('fs').unlink(destination, () => {});
                this.emit('download-error', { url, error: err, modelId });
                reject(err);
            });

            request.setTimeout(timeout);

            file.on('error', (err) => {
                require('fs').unlink(destination, () => {});
                reject(err);
            });
        });
    }

    async downloadWithRetry(url, destination, options = {}) {
        const { 
            maxRetries = 3, 
            retryDelay = 1000, 
            expectedChecksum = null,
            modelId = null,
            ...downloadOptions 
        } = options;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const result = await this.downloadFile(url, destination, { 
                    ...downloadOptions, 
                    modelId 
                });
                
                if (expectedChecksum) {
                    const isValid = await this.verifyChecksum(destination, expectedChecksum);
                    if (!isValid) {
                        require('fs').unlinkSync(destination);
                        throw new Error('Checksum verification failed');
                    }
                }
                
                return result;
            } catch (error) {
                if (attempt === maxRetries) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            }
        }
    }

    async verifyChecksum(filePath, expectedChecksum) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = require('fs').createReadStream(filePath);
            
            stream.on('data', (data) => hash.update(data));
            stream.on('end', () => {
                const fileChecksum = hash.digest('hex');
                resolve(fileChecksum === expectedChecksum);
            });
            stream.on('error', reject);
        });
    }

    async autoInstall(onProgress) {
        const platform = this.getPlatform();
        
        try {
            switch(platform) {
                case 'darwin':
                    return await this.installMacOS(onProgress);
                case 'win32':
                    return await this.installWindows(onProgress);
                case 'linux':
                    return await this.installLinux();
                default:
                    throw new Error(`Unsupported platform: ${platform}`);
            }
        } catch (error) {
            console.error(`[${this.serviceName}] Auto-installation failed:`, error);
            throw error;
        }
    }

    async installMacOS(onProgress) {
        try {
            const dmgUrl = 'https://ollama.com/download/Ollama.dmg';
            const tempDir = app.getPath('temp');
            const dmgPath = path.join(tempDir, 'Ollama.dmg');
            const mountPoint = path.join(tempDir, 'OllamaMount');

            // Save checkpoint
            await this.saveCheckpoint('pre-install');

            onProgress?.({ stage: 'downloading', message: 'Downloading Ollama installer...', progress: 0 });
            const checksumInfo = DOWNLOAD_CHECKSUMS.ollama.dmg;
            await this.downloadWithRetry(dmgUrl, dmgPath, {
                expectedChecksum: checksumInfo?.sha256,
                onProgress: (progress) => {
                    onProgress?.({ stage: 'downloading', message: `Downloading... ${progress}%`, progress });
                }
            });
            
            await this.saveCheckpoint('post-download');

            onProgress?.({ stage: 'mounting', message: 'Mounting disk image...', progress: 0 });
            await fs.mkdir(mountPoint, { recursive: true });
            await spawnAsync('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint]);
            onProgress?.({ stage: 'mounting', message: 'Disk image mounted.', progress: 100 });

            onProgress?.({ stage: 'installing', message: 'Installing Ollama application...', progress: 0 });
            await spawnAsync('cp', ['-R', `${mountPoint}/Ollama.app`, '/Applications/']);
            onProgress?.({ stage: 'installing', message: 'Application installed.', progress: 100 });
            
            await this.saveCheckpoint('post-install');

            onProgress?.({ stage: 'linking', message: 'Creating command-line shortcut...', progress: 0 });
            try {
                const script = `do shell script "mkdir -p /usr/local/bin && ln -sf '${this.getOllamaCliPath()}' '/usr/local/bin/ollama'" with administrator privileges`;
                await spawnAsync('osascript', ['-e', script]);
                onProgress?.({ stage: 'linking', message: 'Shortcut created.', progress: 100 });
            } catch (linkError) {
                console.error('[OllamaService] CLI symlink creation failed:', linkError.message);
                onProgress?.({ stage: 'linking', message: 'Shortcut creation failed (permissions?).', progress: 100 });
                // Not throwing an error, as the app might still work
            }

            onProgress?.({ stage: 'cleanup', message: 'Cleaning up installation files...', progress: 0 });
            await spawnAsync('hdiutil', ['detach', mountPoint]);
            await fs.unlink(dmgPath).catch(() => {});
            await fs.rmdir(mountPoint).catch(() => {});
            onProgress?.({ stage: 'cleanup', message: 'Cleanup complete.', progress: 100 });
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            return true;
        } catch (error) {
            console.error('[OllamaService] macOS installation failed:', error);
            // Clean up on installation failure
            await fs.unlink(dmgPath).catch(() => {});
            throw new Error(`Failed to install Ollama on macOS: ${error.message}`);
        }
    }

    async installWindows(onProgress) {
        try {
            const exeUrl = 'https://ollama.com/download/OllamaSetup.exe';
            const tempDir = app.getPath('temp');
            const exePath = path.join(tempDir, 'OllamaSetup.exe');

            onProgress?.({ stage: 'downloading', message: 'Downloading Ollama installer...', progress: 0 });
            const checksumInfo = DOWNLOAD_CHECKSUMS.ollama.exe;
            await this.downloadWithRetry(exeUrl, exePath, {
                expectedChecksum: checksumInfo?.sha256,
                onProgress: (progress) => {
                    onProgress?.({ stage: 'downloading', message: `Downloading... ${progress}%`, progress });
                }
            });

            onProgress?.({ stage: 'installing', message: 'Installing Ollama...', progress: 0 });
            await spawnAsync(exePath, ['/VERYSILENT', '/NORESTART']);
            onProgress?.({ stage: 'installing', message: 'Installation complete.', progress: 100 });

            onProgress?.({ stage: 'cleanup', message: 'Cleaning up installation files...', progress: 0 });
            await fs.unlink(exePath).catch(() => {});
            onProgress?.({ stage: 'cleanup', message: 'Cleanup complete.', progress: 100 });
            
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            return true;
        } catch (error) {
            console.error('[OllamaService] Windows installation failed:', error);
            throw new Error(`Failed to install Ollama on Windows: ${error.message}`);
        }
    }

    async installLinux() {
        throw new Error('Manual installation required on Linux. Please visit https://ollama.com/download/linux');
    }

    // === Checkpoint & Rollback System ===
    async saveCheckpoint(name) {
        this.installCheckpoints.push({
            name,
            timestamp: Date.now(),
            state: { ...this.installState }
        });
    }

    async rollbackToLastCheckpoint() {
        const checkpoint = this.installCheckpoints.pop();
        if (checkpoint) {
            // Execute platform-specific rollback logic
            await this._executeRollback(checkpoint);
        }
    }

    async _executeRollback(checkpoint) {
        const platform = this.getPlatform();
        
        if (platform === 'darwin' && checkpoint.name === 'post-install') {
            // macOS rollback
            await fs.rm('/Applications/Ollama.app', { recursive: true, force: true }).catch(() => {});
        } else if (platform === 'win32') {
            // Windows rollback (registry, etc.)
            // TODO: Implement Windows rollback
        }
        
        this.installState = checkpoint.state;
    }

    // === State Synchronization (Internal Processing) ===
    async syncState() {
        // Skip if service is shutting down
        if (this.isShuttingDown) {
            return this.installState;
        }
        
        try {
            const isInstalled = await this.isInstalled();
            const isRunning = await this.isServiceRunning();
            const models = isRunning && !this.isShuttingDown ? await this.getInstalledModels() : [];
            const loadedModels = isRunning && !this.isShuttingDown ? await this.getLoadedModels() : [];
            
            // Update status
            this.installState.isInstalled = isInstalled;
            this.installState.isRunning = isRunning;
            this.installState.lastSync = Date.now();
            
            // Track memory load status
            const previousLoadedModels = this._lastLoadedModels || [];
            const loadedChanged = loadedModels.length !== previousLoadedModels.length || 
                               !loadedModels.every(m => previousLoadedModels.includes(m));
            
            if (loadedChanged) {
                this._lastLoadedModels = loadedModels;
                
                // Remove warmed status of models unloaded from memory
                for (const modelName of this.warmedModels) {
                    if (!loadedModels.includes(modelName)) {
                        this.warmedModels.delete(modelName);
                    }
                }
            }
            
            // Update model status in DB
            if (isRunning && models.length > 0) {
                for (const model of models) {
                    try {
                        const isLoaded = loadedModels.includes(model.name);
                        // Store only installed status in DB, manage loaded status in memory
                        await ollamaModelRepository.updateInstallStatus(model.name, true, false);
                        
                        // Store load status in instance variable
                        if (!this.modelLoadStatus) {
                            this.modelLoadStatus = new Map();
                        }
                        this.modelLoadStatus.set(model.name, isLoaded);
                    } catch (dbError) {
                        console.warn(`[OllamaService] Failed to update DB for model ${model.name}:`, dbError);
                    }
                }
            }
            
            // UI notification (only on status change)
            if (this._lastState?.isRunning !== isRunning || 
                this._lastState?.isInstalled !== isInstalled ||
                loadedChanged) {
                // Emit state change event - LocalAIManager will handle
                this.emit('state-changed', {
                    installed: isInstalled,
                    running: isRunning,
                    models: models.length,
                    loadedModels: loadedModels
                });
            }
            
            this._lastState = { isInstalled, isRunning, modelsCount: models.length };
            return { isInstalled, isRunning, models };
            
        } catch (error) {
            console.error('[OllamaService] State sync failed:', error);
            return { 
                isInstalled: this.installState.isInstalled || false,
                isRunning: false,
                models: []
            };
        }
    }

    // Start periodic synchronization
    startPeriodicSync() {
        if (this._syncInterval) return;
        
        this._syncInterval = setInterval(() => {
            this.syncState();
        }, 30000); // Every 30 seconds
    }

    stopPeriodicSync() {
        if (this._syncInterval) {
            clearInterval(this._syncInterval);
            this._syncInterval = null;
        }
    }

    async warmUpModel(modelName, forceRefresh = false) {
        if (!modelName?.trim()) {
            console.warn(`[OllamaService] Invalid model name for warm-up`);
            return false;
        }

        // Check if already warmed (and not forcing refresh)
        if (!forceRefresh && this.warmedModels.has(modelName)) {
            return true;
        }

        // Check if currently warming - return existing Promise
        if (this.warmingModels.has(modelName)) {
            return await this.warmingModels.get(modelName);
        }

        // Check rate limiting (prevent too frequent attempts)
        const lastAttempt = this.lastWarmUpAttempt.get(modelName);
        const now = Date.now();
        if (lastAttempt && (now - lastAttempt) < 5000) { // 5 second cooldown
            return false;
        }

        // Create and store the warming Promise
        const warmingPromise = this._performWarmUp(modelName);
        this.warmingModels.set(modelName, warmingPromise);
        this.lastWarmUpAttempt.set(modelName, now);

        try {
            const result = await warmingPromise;
            
            if (result) {
                this.warmedModels.add(modelName);
            }
            
            return result;
        } finally {
            // Always clean up the warming Promise
            this.warmingModels.delete(modelName);
        }
    }

    async _performWarmUp(modelName) {
        try {
            const response = await this.makeRequest('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelName,
                    messages: [
                        { role: 'user', content: 'Hi' }
                    ],
                    stream: false,
                    options: {
                        num_predict: 1, // Minimal response
                        temperature: 0
                    }
                })
            });

            return true;
        } catch (error) {
            // Check if it's a 404 error (model not found/installed)
            if (error.message.includes('HTTP 404') || error.message.includes('Not Found')) {
                try {
                    // Try to install the model
                    await this.pullModel(modelName);
                    
                    // Update database to reflect installation
                    await ollamaModelRepository.updateInstallStatus(modelName, true, false);
                    
                    // Retry warm-up after installation
                    const retryResponse = await this.makeRequest('/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: modelName,
                            messages: [
                                { role: 'user', content: 'Hi' }
                            ],
                            stream: false,
                            options: {
                                num_predict: 1,
                                temperature: 0
                            }
                        })
                    });
                    
                    return true;
                    
                } catch (installError) {
                    console.error(`[OllamaService] Failed to auto-install model ${modelName}:`, installError.message);
                    await ollamaModelRepository.updateInstallStatus(modelName, false, false);
                    return false;
                }
            } else {
                console.error(`[OllamaService] Failed to warm up model ${modelName}:`, error.message);
                return false;
            }
        }
    }

    async autoWarmUpSelectedModel() {
        try {
            // Get selected model from ModelStateService
            const modelStateService = global.modelStateService;
            if (!modelStateService) {
                return false;
            }

            const selectedModels = await modelStateService.getSelectedModels();
            const llmModelId = selectedModels.llm;
            
            // Check if it's an Ollama model
            const provider = modelStateService.getProviderForModel('llm', llmModelId);
            if (provider !== 'ollama') {
                return false;
            }

            // Check if Ollama service is running
            const isRunning = await this.isServiceRunning();
            if (!isRunning) {
                this._clearWarmUpCache();
                return false;
            }

            // Remove installation check - _performWarmUp automatically handles installation
            const result = await this.warmUpModel(llmModelId);
            
            // Notify LocalAIManager on success
            if (result) {
                this.emit('model-warmed-up', { model: llmModelId });
            }
            
            return result;
            
        } catch (error) {
            console.error('[OllamaService] Auto warm-up failed:', error);
            return false;
        }
    }

    _clearWarmUpCache() {
        this.warmedModels.clear();
        this.warmingModels.clear();
        this.lastWarmUpAttempt.clear();
    }

    async getWarmUpStatus() {
        const loadedModels = await this.getLoadedModels();
        
        return {
            warmedModels: Array.from(this.warmedModels),
            warmingModels: Array.from(this.warmingModels.keys()),
            loadedModels: loadedModels,  // Models actually loaded in memory
            lastAttempts: Object.fromEntries(this.lastWarmUpAttempt)
        };
    }

    async shutdown(force = false) {
        // Set shutdown flag
        this.isShuttingDown = true;
        
        if (!force && this.warmingModels.size > 0) {
            const warmingList = Array.from(this.warmingModels.keys());
            
            const warmingPromises = Array.from(this.warmingModels.values());
            try {
                // Use Promise.allSettled instead of race with setTimeout
                const results = await Promise.allSettled(warmingPromises);
                const completed = results.filter(r => r.status === 'fulfilled').length;
            } catch (error) {
            }
        }

        // Clean up all resources
        this._clearWarmUpCache();
        this.stopPeriodicSync();
        
        // Terminate process
        const isRunning = await this.isServiceRunning();
        if (!isRunning) {
            return true;
        }

        const platform = this.getPlatform();
        
        try {
            switch(platform) {
                case 'darwin':
                    return await this.shutdownMacOS(force);
                case 'win32':
                    return await this.shutdownWindows(force);
                case 'linux':
                    return await this.shutdownLinux(force);
                default:
                    console.warn(`[OllamaService] Unsupported platform for shutdown: ${platform}`);
                    return false;
            }
        } catch (error) {
            console.error(`[OllamaService] Error during shutdown:`, error);
            return false;
        }
    }

    async shutdownMacOS(force) {
        try {
            // 1. First, try to kill ollama server process
            try {
                await spawnAsync('pkill', ['-f', 'ollama serve']);
            } catch (e) {
                // Process might not be running
            }
            
            // 2. Then quit the Ollama.app
            try {
                await spawnAsync('osascript', ['-e', 'tell application "Ollama" to quit']);
            } catch (e) {
            }
            
            // 3. Wait a moment for shutdown
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // 4. Force kill any remaining ollama processes
            if (force || await this.isServiceRunning()) {
                try {
                    // Kill all ollama processes
                    await spawnAsync('pkill', ['-9', '-f', 'ollama']);
                } catch (e) {
                    // Ignore errors - process might not exist
                }
            }
            
            // 5. Final check
            await new Promise(resolve => setTimeout(resolve, 1000));
            const stillRunning = await this.isServiceRunning();
            if (stillRunning) {
                console.warn('[OllamaService] Warning: Ollama may still be running');
                return false;
            }
            return true;
        } catch (error) {
            console.error('[OllamaService] Shutdown error:', error);
            return false;
        }
    }

    async shutdownWindows(force) {
        try {
            // Try to stop the service gracefully
            await spawnAsync('taskkill', ['/IM', 'ollama.exe', '/T']);
            return true;
        } catch (error) {
            try {
                await spawnAsync('taskkill', ['/IM', 'ollama.exe', '/F', '/T']);
                return true;
            } catch (killError) {
                console.error('[OllamaService] Failed to force kill Ollama on Windows:', killError);
                return false;
            }
        }
    }

    async shutdownLinux(force) {
        try {
            await spawnAsync('pkill', ['-f', this.getOllamaCliPath()]);
            return true;
        } catch (error) {
            if (force) {
                await spawnAsync('pkill', ['-9', '-f', this.getOllamaCliPath()]).catch(() => {});
            }
            console.error('[OllamaService] Failed to shutdown Ollama on Linux:', error);
            return false;
        }
    }

    async getAllModelsWithStatus() {
        // Get all installed models directly from Ollama
        const installedModels = await this.getInstalledModels();
        
        // Get loaded models from memory
        const loadedModels = await this.getLoadedModels();
        
        const models = [];
        for (const model of installedModels) {
            const isWarmingUp = this.warmingModels.has(model.name);
            const isWarmedUp = this.warmedModels.has(model.name);
            const isLoaded = loadedModels.includes(model.name);
            
            models.push({
                name: model.name,
                displayName: model.name, // Use model name as display name
                size: model.size || 'Unknown',
                description: `Ollama model: ${model.name}`,
                installed: true,
                installing: this.installationProgress.has(model.name),
                progress: this.getInstallProgress(model.name),
                warmedUp: isWarmedUp,
                isWarmingUp,
                isLoaded,  // Actually loaded in memory
                status: isWarmingUp ? 'warming' : (isLoaded ? 'loaded' : (isWarmedUp ? 'ready' : 'cold'))
            });
        }
        
        // Also add any models currently being installed
        for (const [modelName, progress] of this.installationProgress) {
            if (!models.find(m => m.name === modelName)) {
                models.push({
                    name: modelName,
                    displayName: modelName,
                    size: 'Unknown',
                    description: `Ollama model: ${modelName}`,
                    installed: false,
                    installing: true,
                    progress: progress
                });
            }
        }
        
        return models;
    }

    async handleGetStatus() {
        try {
            const installed = await this.isInstalled();
            if (!installed) {
                return { success: true, installed: false, running: false, models: [] };
            }

            const running = await this.isServiceRunning();
            if (!running) {
                return { success: true, installed: true, running: false, models: [] };
            }

            const models = await this.getAllModelsWithStatus();
            return { success: true, installed: true, running: true, models };
        } catch (error) {
            console.error('[OllamaService] Error getting status:', error);
            return { success: false, error: error.message, installed: false, running: false, models: [] };
        }
    }

    async handleInstall() {
        try {
            const onProgress = (data) => {
                // Emit progress event - LocalAIManager will handle
                this.emit('install-progress', data);
            };

            await this.autoInstall(onProgress);
            
            // Installation verification
            onProgress({ stage: 'verifying', message: 'Verifying installation...', progress: 0 });
            const verifyResult = await this.verifyInstallation();
            if (!verifyResult.success) {
                throw new Error(`Installation verification failed: ${verifyResult.error}`);
            }
            onProgress({ stage: 'verifying', message: 'Installation verified.', progress: 100 });

            if (!await this.isServiceRunning()) {
                onProgress({ stage: 'starting', message: 'Starting Ollama service...', progress: 0 });
                await this.startService();
                onProgress({ stage: 'starting', message: 'Ollama service started.', progress: 100 });
            }
            
            this.installState.isInstalled = true;
            // Emit completion event - LocalAIManager will handle
            this.emit('installation-complete');
            return { success: true };
        } catch (error) {
            console.error('[OllamaService] Failed to install:', error);
            await this.rollbackToLastCheckpoint();
            // Emit error event - LocalAIManager will handle
            this.emit('error', {
                errorType: 'installation-failed',
                error: error.message
            });
            return { success: false, error: error.message };
        }
    }

    async handleStartService() {
        try {
            if (!await this.isServiceRunning()) {
                await this.startService();
            }
            this.emit('install-complete', { success: true });
            return { success: true };
        } catch (error) {
            console.error('[OllamaService] Failed to start service:', error);
            this.emit('install-complete', { success: false, error: error.message });
            return { success: false, error: error.message };
        }
    }

    async handleEnsureReady() {
        try {
            if (await this.isInstalled() && !await this.isServiceRunning()) {
                await this.startService();
            }
            return { success: true };
        } catch (error) {
            console.error('[OllamaService] Failed to ensure ready:', error);
            return { success: false, error: error.message };
        }
    }

    async handleGetModels() {
        try {
            const models = await this.getAllModelsWithStatus();
            return { success: true, models };
        } catch (error) {
            console.error('[OllamaService] Failed to get models:', error);
            return { success: false, error: error.message };
        }
    }

    async handleGetModelSuggestions() {
        try {
            const suggestions = await this.getModelSuggestions();
            return { success: true, suggestions };
        } catch (error) {
            console.error('[OllamaService] Failed to get model suggestions:', error);
            return { success: false, error: error.message };
        }
    }

    async handlePullModel(modelName) {
        try {
            await ollamaModelRepository.updateInstallStatus(modelName, false, true);

            await this.pullModel(modelName);

            await ollamaModelRepository.updateInstallStatus(modelName, true, false);
            return { success: true };
        } catch (error) {
            console.error('[OllamaService] Failed to pull model:', error);
            await ollamaModelRepository.updateInstallStatus(modelName, false, false);
            // Emit error event - LocalAIManager will handle
            this.emit('error', { 
                errorType: 'model-pull-failed',
                model: modelName, 
                error: error.message 
            });
            return { success: false, error: error.message };
        }
    }

    async handleIsModelInstalled(modelName) {
        try {
            const installed = await this.isModelInstalled(modelName);
            return { success: true, installed };
        } catch (error) {
            console.error('[OllamaService] Failed to check model installation:', error);
            return { success: false, error: error.message };
        }
    }

    async handleWarmUpModel(modelName) {
        try {
            const success = await this.warmUpModel(modelName);
            return { success };
        } catch (error) {
            console.error('[OllamaService] Failed to warm up model:', error);
            return { success: false, error: error.message };
        }
    }

    async handleAutoWarmUp() {
        try {
            const success = await this.autoWarmUpSelectedModel();
            return { success };
        } catch (error) {
            console.error('[OllamaService] Failed to auto warm-up:', error);
            return { success: false, error: error.message };
        }
    }

    async handleGetWarmUpStatus() {
        try {
            const status = await this.getWarmUpStatus();
            return { success: true, status };
        } catch (error) {
            console.error('[OllamaService] Failed to get warm-up status:', error);
            return { success: false, error: error.message };
        }
    }

    async handleShutdown(force = false) {
        try {
            const success = await this.shutdown(force);
            
            // Update status and reset flag after shutdown
            if (success) {
                // Reset flag after shutdown complete
                this.isShuttingDown = false;
                await this.syncState();
            }
            
            return { success };
        } catch (error) {
            console.error('[OllamaService] Failed to shutdown Ollama:', error);
            return { success: false, error: error.message };
        }
    }
    
    // Installation verification
    async verifyInstallation() {
        try {
            // 1. Check binary
            const isInstalled = await this.isInstalled();
            if (!isInstalled) {
                return { success: false, error: 'Ollama binary not found' };
            }
            
            // 2. Test CLI command
            try {
                const { stdout } = await spawnAsync(this.getOllamaCliPath(), ['--version']);
            } catch (error) {
                return { success: false, error: 'Ollama CLI not responding' };
            }
            
            // 3. Check if service can start
            const platform = this.getPlatform();
            if (platform === 'darwin') {
                // macOS: Check app bundle
                try {
                    await fs.access('/Applications/Ollama.app/Contents/MacOS/Ollama');
                } catch (error) {
                    return { success: false, error: 'Ollama.app executable not found' };
                }
            }
            
            return { success: true };
            
        } catch (error) {
            console.error('[OllamaService] Verification failed:', error);
            return { success: false, error: error.message };
        }
    }
}

// Export singleton instance
const ollamaService = new OllamaService();
module.exports = ollamaService;