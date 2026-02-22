// src/bridge/internalBridge.js
const { EventEmitter } = require('events');

// Internal event bus that connects FeatureCore and WindowCore
const internalBridge = new EventEmitter();
module.exports = internalBridge;

// Example event
// internalBridge.on('content-protection-changed', (enabled) => {
//   // Handle in windowManager
// });