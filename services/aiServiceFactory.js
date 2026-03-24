const config = require("../config/config");
const openaiService = require("./openaiService");
const ollamaService = require("./ollamaService");
const customService = require("./customService");
const azureService = require("./azureService");
const novitaService = require("./novitaService");

class AIServiceFactory {
  static getService() {
    switch (config.aiProvider) {
      case "ollama":
        return ollamaService;
      case "openai":
      default:
        return openaiService;
      case "custom":
        return customService;
      case "azure":
        return azureService;
      case "novita":
        return novitaService;
    }
  }
}

module.exports = AIServiceFactory;
