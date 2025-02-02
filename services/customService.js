const OpenAI = require('openai');
const config = require('../config/config');
const tiktoken = require('tiktoken');
const fs = require('fs').promises;
const {ThumbnailService} = require("./thumbnailService");

class CustomOpenAIService {
  constructor() {
    this.client = null;
    this.tokenizer = null;
  }

  initialize() {
    if (!this.client && config.aiProvider === 'custom') {
      this.client = new OpenAI({
        baseURL: config.custom.apiUrl,
        apiKey: config.custom.apiKey
      });
    }
  }

    // Calculate tokens for a given text
    async calculateTokens(text) {
      if (!this.tokenizer) {
        // Use the appropriate model encoding
        this.tokenizer = await tiktoken.encoding_for_model(process.env.OPENAI_MODEL || "gpt-4o-mini");
      }
      return this.tokenizer.encode(text).length;
    }
  
    // Calculate tokens for a given text
    async calculateTotalPromptTokens(systemPrompt, additionalPrompts = []) {
      let totalTokens = 0;
      
      // Count tokens for system prompt
      totalTokens += await this.calculateTokens(systemPrompt);
      
      // Count tokens for additional prompts
      for (const prompt of additionalPrompts) {
        if (prompt) { // Only count if prompt exists
          totalTokens += await this.calculateTokens(prompt);
        }
      }
      
      // Add tokens for message formatting (approximately 4 tokens per message)
      const messageCount = 1 + additionalPrompts.filter(p => p).length; // Count system + valid additional prompts
      totalTokens += messageCount * 4;
      
      return totalTokens;
    }
  
    // Truncate text to fit within token limit
    async truncateToTokenLimit(text, maxTokens) {
      const tokens = await this.calculateTokens(text);
      if (tokens <= maxTokens) return text;
  
      // Simple truncation strategy - could be made more sophisticated
      const ratio = maxTokens / tokens;
      return text.slice(0, Math.floor(text.length * ratio));
    }
  
  async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], id) {
    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      
      if (!this.client) {
        throw new Error('Custom OpenAI client not initialized');
      }

      // Handle thumbnail caching
      // FIXME why is this done in here? The thumbnail is not used at all
      await new ThumbnailService().getThumbnailPath(id);
      
      // Format existing tags
      const existingTagsList = existingTags
        .map(tag => tag.name)
        .join(', ');

      
      let systemPrompt = '';
      let promptTags = '';
      const model = config.custom.model;
      // Get system prompt and model
      if(process.env.USE_EXISTING_DATA === 'yes') {
        systemPrompt = `
        Prexisting tags: ${existingTagsList}\n\n
        Prexisiting correspondent: ${existingCorrespondentList}\n\n
        ` + process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt;
        promptTags = '';
      } else {
        systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt;
        promptTags = '';
      }
      if (process.env.USE_PROMPT_TAGS === 'yes') {
        promptTags = process.env.PROMPT_TAGS;
        systemPrompt = `
        Take these tags and try to match one or more to the document content.\n\n
        ` + config.specialPromptPreDefinedTags;
      }

      // Calculate total prompt tokens including all components
      const totalPromptTokens = await this.calculateTotalPromptTokens(
        systemPrompt,
        process.env.USE_PROMPT_TAGS === 'yes' ? [promptTags] : []
      );
        
        // Calculate available tokens
        const maxTokens = 128000; // Model's maximum context length
        const reservedTokens = totalPromptTokens + 1000; // Reserve for response
        const availableTokens = maxTokens - reservedTokens;
        
        // Truncate content if necessary
        const truncatedContent = await this.truncateToTokenLimit(content, availableTokens);
      
      // Make API request
      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        temperature: 0.3,
      });
      
      // Handle response
      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }
      
      // Log token usage
      console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);
      
      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from API');
      }

      // Validate response structure
      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure: missing tags array or correspondent string');
      }

      return { 
        document: parsedResponse, 
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length
      };
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return { 
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message 
      };
    }
  }

  async writePromptToFile(systemPrompt, truncatedContent) {
    const filePath = './logs/prompt.txt';
    const maxSize = 10 * 1024 * 1024;
  
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > maxSize) {
        await fs.unlink(filePath); // Delete the file if is biger 10MB
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[WARNING] Error checking file size:', error);
      }
    }
  
    try {
      await fs.appendFile(filePath, systemPrompt + truncatedContent + '\n\n');
    } catch (error) {
      console.error('[ERROR] Error writing to file:', error);
    }
  }

  async analyzePlayground(content, prompt) {
    const musthavePrompt = `
    Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:  
        {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
        }`;

    try {
      this.initialize();
      const now = new Date();
      const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      
      if (!this.client) {
        throw new Error('OpenAI client not initialized - missing API key');
      }
      
      // Calculate total prompt tokens including musthavePrompt
      const totalPromptTokens = await this.calculateTotalPromptTokens(
        prompt + musthavePrompt // Combined system prompt
      );
      
      // Calculate available tokens
      const maxTokens = 128000;
      const reservedTokens = totalPromptTokens + 1000; // Reserve for response
      const availableTokens = maxTokens - reservedTokens;
      
      // Truncate content if necessary
      const truncatedContent = await this.truncateToTokenLimit(content, availableTokens);
      
      // Make API request
      const response = await this.client.chat.completions.create({
        model: config.custom.model,
        messages: [
          {
            role: "system",
            content: prompt + musthavePrompt
          },
          {
            role: "user",
            content: truncatedContent
          }
        ],
        temperature: 0.3,
      });
      
      // Handle response
      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('Invalid API response structure');
      }
      
      // Log token usage
      console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
      console.log(`[DEBUG] [${timestamp}] Total tokens: ${response.usage.total_tokens}`);
      
      const usage = response.usage;
      const mappedUsage = {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
      };

      console.log(mappedUsage);

      let jsonContent = response.choices[0].message.content;
      jsonContent = jsonContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

      let parsedResponse;
      try {
        parsedResponse = JSON.parse(jsonContent);
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        throw new Error('Invalid JSON response from API');
      }

      // Validate response structure
      if (!parsedResponse || !Array.isArray(parsedResponse.tags) || typeof parsedResponse.correspondent !== 'string') {
        throw new Error('Invalid response structure: missing tags array or correspondent string');
      }

      return { 
        document: parsedResponse, 
        metrics: mappedUsage,
        truncated: truncatedContent.length < content.length
      };
    } catch (error) {
      console.error('Failed to analyze document:', error);
      return { 
        document: { tags: [], correspondent: null },
        metrics: null,
        error: error.message 
      };
    }
  }
}

module.exports = new CustomOpenAIService();