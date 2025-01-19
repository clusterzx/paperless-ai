const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { OpenAI } = require('openai');
const config = require('../config/config');

class SetupService {
  constructor(param = undefined) {
    this.envPath = param?.envPath || path.join(process.cwd(), 'data', '.env');
    this.configured = null; // Variable to store the configuration status
  }

  async loadConfig() {
    try {
      const envContent = {}

      const result = require('dotenv').config({ path: this.envPath, processEnv: envContent });

      return result.parsed
    } catch (error) {
      console.error('Error loading config:', error.message);
      return null;
    }
  }

  async validatePaperlessConfig(url, token) {
    try {
      const response = await axios.get(`${url}/documents/`, {
        headers: {
          'Authorization': `Token ${token}`
        }
      });
      return response.status === 200;
    } catch (error) {
      console.error('Paperless validation error:', error.message);
      return false;
    }
  }

  async validateOpenAIConfig(apiKey) {
    if (config.CONFIGURED === false) {
      try {
        const openai = new OpenAI({ apiKey });
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Test" }],
        });
        const now = new Date();
        const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
        console.log(`[DEBUG] [${timestamp}] OpenAI request sent`);
        return response.choices && response.choices.length > 0;
      } catch (error) {
        console.error('OpenAI validation error:', error.message);
        return false;
      }
    }else{
      return true;
    }
  }

  async validateCustomConfig(url, apiKey, model) {
    const config = {
      baseURL: url,
      apiKey: apiKey,
      model: model
    };
    try {
      const openai = new OpenAI({ 
        apiKey: config.apiKey, 
        baseURL: config.baseURL,
      });
      const completion = await openai.chat.completions.create({
        messages: [{ role: "user", content: "Test" }],
        model: config.model,
      });
      return completion.choices && completion.choices.length > 0;
    } catch (error) {
      console.error('Custom AI validation error:', error.message);
      return false;
    }
  }



  async validateOllamaConfig(url, model) {
    try {
      const response = await axios.post(`${url}/api/generate`, {
        model: model || 'llama2',
        prompt: 'Test',
        stream: false
      });
      return response.data && response.data.response;
    } catch (error) {
      console.error('Ollama validation error:', error.message);
      return false;
    }
  }

  async validateConfig(config) {
    // Validate Paperless config
    const paperlessValid = await this.validatePaperlessConfig(
      config.PAPERLESS_API_URL,
      config.PAPERLESS_API_TOKEN
    );
    
    if (!paperlessValid) {
      throw new Error('Invalid Paperless configuration');
    }

    // Validate AI provider config
    const aiProvider = config.AI_PROVIDER || 'openai';
    
    if (aiProvider === 'openai') {
      const openaiValid = await this.validateOpenAIConfig(config.OPENAI_API_KEY);
      if (!openaiValid) {
        throw new Error('Invalid OpenAI configuration');
      }
    } else if (aiProvider === 'ollama') {
      const ollamaValid = await this.validateOllamaConfig(
        config.OLLAMA_API_URL || 'http://localhost:11434',
        config.OLLAMA_MODEL
      );
      if (!ollamaValid) {
        throw new Error('Invalid Ollama configuration');
      }
    } else if (aiProvider === 'custom') {
      const customValid = await this.validateCustomConfig(
        config.CUSTOM_BASE_URL,
        config.CUSTOM_API_KEY,
        config.CUSTOM_MODEL
      );
      if (!customValid) {
        throw new Error('Invalid Custom AI configuration');
      }
    }

    return true;
  }

  async saveConfig(config) {
    try {
      // Validate the new configuration before saving
      await this.validateConfig(config);

      const JSON_STANDARD_PROMPT = `
        Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:
        
        {
          "title": "xxxxx",
          "correspondent": "xxxxxxxx",
          "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
          "document_date": "YYYY-MM-DD",
          "language": "en/de/es/..."
        }`;

      // Ensure data directory exists
      const dataDir = path.dirname(this.envPath);
      await fs.mkdir(dataDir, { recursive: true });

      const envContent = Object.entries(config)
        .map(([key, value]) => {
          if (key === "SYSTEM_PROMPT") {
            return `${key}=\`${value}\n\``;
          }
          return `${key}=${value}`;
        })
        .join('\n');

      await fs.writeFile(this.envPath, envContent);
      
      // Reload environment variables
      Object.entries(config).forEach(([key, value]) => {
        process.env[key] = value;
      });
    } catch (error) {
      console.error('Error saving config:', error.message);
      throw error;
    }
  }

  async isConfigured() {
    if (this.configured !== null) {
      return this.configured;
    }

    try {
      // Check data directory and .env file
      const dataDir = path.dirname(this.envPath);
      try {
        await fs.access(dataDir, fs.constants.F_OK);
      } catch (err) {
        console.log('Creating data directory...');
        await fs.mkdir(dataDir, { recursive: true });
      }

      // Check .env file
      try {
        await fs.access(this.envPath, fs.constants.F_OK);
      } catch (err) {
        this.configured = false;
        return false;
      }

      const config = await this.loadConfig();
      if (!config) {
        this.configured = false;
        return false;
      }

      try {
        await this.validateConfig(config);
        this.configured = true;
        return true;
      } catch (error) {
        console.error('Configuration validation failed:', error.message);
        this.configured = false;
        return false;
      }
    } catch (error) {
      console.error('Error checking configuration:', error.message);
      this.configured = false;
      return false;
    }
  }
}

module.exports = SetupService;
