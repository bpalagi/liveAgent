const sqliteRepository = require('./sqlite.repository');
const authService = require('../../common/services/authService');

function getBaseRepository() {
    // Electron-only local mode: persist ask history in SQLite.
    return sqliteRepository;
}

// The adapter layer that injects the UID
const askRepositoryAdapter = {
    addAiMessage: ({ sessionId, role, content, model }) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().addAiMessage({ uid, sessionId, role, content, model });
    },
    getAllAiMessagesBySessionId: (sessionId) => {
        // This function does not require a UID at the service level.
        return getBaseRepository().getAllAiMessagesBySessionId(sessionId);
    }
};

module.exports = askRepositoryAdapter; 