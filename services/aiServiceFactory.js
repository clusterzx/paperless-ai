const config = require('../config/config');
const openaiService = require('./openaiService');
const ollamaService = require('./ollamaService');
const customService = require('./customService');
const azureService = require('./azureService');
const { isCustomOpenAICompatibleProvider } = require('./providerUtils');

class AIServiceFactory {
  static getService() {
    if (isCustomOpenAICompatibleProvider(config.aiProvider)) {
      return customService;
    }

    switch (config.aiProvider) {
      case 'ollama':
        return ollamaService;
      case 'openai':
      default:
        return openaiService;
      case 'azure':
        return azureService;
    }
  }
}

module.exports = AIServiceFactory;
