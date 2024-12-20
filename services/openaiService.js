const OpenAI = require('openai');
const config = require('../config/config');

class OpenAIService {
  constructor() {
    this.client = null;
  }

  initialize() {
    if (!this.client && config.openai.apiKey) {
      this.client = new OpenAI({
        apiKey: config.openai.apiKey
      });
    }
  }

  async analyzeDocument(content, existingTags = []) {
    try {
      this.initialize();

      if (!this.client) {
        console.error('OpenAI client not initialized - missing API key');
        return { tags: [], correspondent: null };
      }

      // Formatiere existierende Tags für den Prompt
      const existingTagsList = existingTags
        .map(tag => tag.name)
        .join(', ');
      
      const systemPrompt = process.env.SYSTEM_PROMPT;
      const model = process.env.OPENAI_MODEL;

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: content
          }
        ],
        temperature: 0.3,
      });

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      const parsedResponse = JSON.parse(jsonContent);
      
      if (!Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure');
      }
      
      return parsedResponse;
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return { tags: [], correspondent: null };
    }
  }
}

module.exports = new OpenAIService();