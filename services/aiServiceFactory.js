const config = require('../config/config');
const openaiService = require('./openaiService');
const ollamaService = require('./ollamaService');
const geminiService = require('./geminiService');

class AIServiceFactory {
  static getService() {
    return this.getServiceForProvider(config.aiProvider);
  }

  static getServiceForProvider(provider){
    switch (provider) {
      case 'ollama':
        return ollamaService;
      case 'gemini':
        return geminiService;  
      case 'openai':
      default:
        return openaiService;
    }
  }
}

module.exports = AIServiceFactory;