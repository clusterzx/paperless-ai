const config = require('../config/config');
const openaiService = require('./openaiService');
const ollamaService = require('./ollamaService');
const customService = require('./customService');
const azureService = require('./azureService');
const astraflowService = require('./astraflowService');
const astraflowCnService = require('./astraflowCnService');

class AIServiceFactory {
  static getService() {
    switch (config.aiProvider) {
      case 'ollama':
        return ollamaService;
      case 'openai':
      default:
        return openaiService;
      case 'custom':
        return customService;
      case 'azure':
        return azureService;
      case 'astraflow':
        return astraflowService;
      case 'astraflow-cn':
        return astraflowCnService;
    }
  }
}

module.exports = AIServiceFactory;