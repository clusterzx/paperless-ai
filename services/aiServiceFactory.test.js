const AiServiceFactory = require('./aiServiceFactory')
const {expect, test} = require('@jest/globals')
const config = require('../config/config')
const {OllamaService} = require("./ollamaService");
const {OpenAIService} = require("./openaiService");


test("if configured to be openai, returns an openaiService instance", () => {

  config.aiProvider = "openai"

  const service = AiServiceFactory.getService()
  expect(service).toBeInstanceOf(OpenAIService)

})

test("if configured to be ollama, returns an ollamaService instance", () => {

  config.aiProvider = "ollama"

  const service = AiServiceFactory.getService()
  expect(service).toBeInstanceOf(OllamaService)

})
