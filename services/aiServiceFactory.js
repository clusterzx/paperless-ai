const config = require('../config/config');
const openaiService = require('./openaiService');
const ollamaService = require('./ollamaService');
const customService = require('./customService');
const azureService = require('./azureService');
const ionosService = require('./ionosService');

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
      case 'ionos':
        return ionosService;
    }
  }
}

module.exports = AIServiceFactory;