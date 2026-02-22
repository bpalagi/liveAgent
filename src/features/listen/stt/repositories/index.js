const sqliteRepository = require('./sqlite.repository');
const authService = require('../../../common/services/authService');

function getBaseRepository() {
    // Electron-only local mode: keep transcript writes local and low-latency.
    return sqliteRepository;
}

const sttRepositoryAdapter = {
    addTranscript: ({ sessionId, speaker, text }) => {
        const uid = authService.getCurrentUserId();
        return getBaseRepository().addTranscript({ uid, sessionId, speaker, text });
    },
    getAllTranscriptsBySessionId: (sessionId) => {
        return getBaseRepository().getAllTranscriptsBySessionId(sessionId);
    }
};

module.exports = sttRepositoryAdapter; 