const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { OpenAI } = require('openai');
const config = require('../config/config');
const AzureOpenAI = require('openai').AzureOpenAI;

class SetupService {
  constructor() {
    this.envPath = path.join(process.cwd(), 'data', '.env');
    this.configured = null; // Variable to store the configuration status
  }

  async loadConfig() {
    try {
      const envContent = await fs.readFile(this.envPath, 'utf8');
      const config = {};
      envContent.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) {
          config[key.trim()] = value.trim();
        }
      });
      return config;
    } catch (error) {
      console.error('Error loading config:', error.message);
      return null;
    }
  }

  async validatePaperlessConfig(url, token) {
    try {
      console.log('Validating Paperless config for:', url + '/api/documents/');
      const response = await axios.get(`${url}/api/documents/`, {
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

  async validateApiPermissions(url, token) {
    for (const endpoint of ['correspondents', 'tags', 'documents', 'document_types', 'custom_fields', 'users']) {
      try {
        console.log(`Validating API permissions for ${url}/api/${endpoint}/`);
        const response = await axios.get(`${url}/api/${endpoint}/`, {
          headers: {
            'Authorization': `Token ${token}`
          }
        });
        console.log(`API permissions validated for ${endpoint}, ${response.status}`);
        if (response.status !== 200) {
          console.error(`API permissions validation failed for ${endpoint}`);
          return { success: false, message: `API permissions validation failed for endpoint '/api/${endpoint}/'` };
        }
      } catch (error) {
        console.error(`API permissions validation failed for ${endpoint}:`, error.message);
        return { success: false, message: `API permissions validation failed for endpoint '/api/${endpoint}/'` };
      }
    }
    return { success: true, message: 'API permissions validated successfully' };
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
    const safeConfig = {
      baseURL: config.baseURL,
      apiKey: config.apiKey
        ? (config.apiKey.length > 8
          ? `${config.apiKey.substring(0, 4)}...${config.apiKey.substring(config.apiKey.length - 4)}`
          : '***')
        : 'not set',
      model: config.model
    };
    console.log('Custom AI config:', safeConfig);
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
      console.error('Custom AI validation error:', error);
      return false;
    }
  }



  async validateOllamaConfig(url, model) {
    try {
      const response = await axios.post(`${url}/api/generate`, {
        model: model || 'llama3.2',
        prompt: 'Test',
        stream: false
      });
      return response.data && response.data.response;
    } catch (error) {
      console.error('Ollama validation error:', error.message);
      return false;
    }
  }

  async validateAzureConfig(apiKey, endpoint, deploymentName, apiVersion) {
    console.log('Endpoint: ', endpoint);
    if (config.CONFIGURED === false) {
      try {
        const openai = new AzureOpenAI({ apiKey: apiKey,
                endpoint: endpoint,
                deploymentName: deploymentName,
                apiVersion: apiVersion });
        const response = await openai.chat.completions.create({
          model: deploymentName,
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

  async validateConfig(config) {
    // Validate Paperless config
    const paperlessApiUrl = config.PAPERLESS_API_URL.replace(/\/api/g, '');
    const paperlessValid = await this.validatePaperlessConfig(
      paperlessApiUrl,
      config.PAPERLESS_API_TOKEN
    );

    if (!paperlessValid) {
      throw new Error('Invalid Paperless configuration');
    }

    // Validate AI provider config
    const aiProvider = config.AI_PROVIDER || 'openai';

    console.log('AI provider:', aiProvider);

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
    } else if (aiProvider === 'azure') {
      const azureValid = await this.validateAzureConfig(
        config.AZURE_API_KEY,
        config.AZURE_ENDPOINT,
        config.AZURE_DEPLOYMENT_NAME,
        config.AZURE_API_VERSION
      );
      if (!azureValid) {
        throw new Error('Invalid Azure configuration');
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

    const maxAttempts = 60; // 5 minutes = 300 seconds, attempting every 5 seconds = 60 attempts
    const delayBetweenAttempts = 5000; // 5 seconds in milliseconds
    let attempts = 0;

    // First check if .env exists and if PAPERLESS_API_URL is set
    try {
      // Check if .env file exists
      try {
        await fs.access(this.envPath, fs.constants.F_OK);
      } catch (err) {
        console.log('No .env file found. Starting setup process...');
        this.configured = false;
        return false;
      }

      // Load and check for PAPERLESS_API_URL
      const config = await this.loadConfig();
      if (!config || !config.PAPERLESS_API_URL) {
        console.log('PAPERLESS_API_URL not set. Starting setup process...');
        this.configured = false;
        return false;
      }
    } catch (error) {
      console.error('Error checking initial configuration:', error.message);
      this.configured = false;
      return false;
    }

    const attemptConfiguration = async () => {
      try {
        // Check data directory and create if needed
        const dataDir = path.dirname(this.envPath);
        try {
          await fs.access(dataDir, fs.constants.F_OK);
        } catch (err) {
          console.log('Creating data directory...');
          await fs.mkdir(dataDir, { recursive: true });
        }

        // Load and validate full configuration
        const config = await this.loadConfig();
        if (!config) {
          throw new Error('Failed to load configuration');
        }

        await this.validateConfig(config);
        this.configured = true;
        return true;
      } catch (error) {
        console.error('Configuration attempt failed:', error.message);
        throw error;
      }
    };

    // Only enter retry loop if we have PAPERLESS_API_URL set
    while (attempts < maxAttempts) {
      try {
        const result = await attemptConfiguration();
        return result;
      } catch (error) {
        attempts++;
        if (attempts === maxAttempts) {
          console.error('Max configuration attempts reached. Final error:', error.message);
          this.configured = false;
          return false;
        }
        console.log(`Retrying configuration (attempt ${attempts}/${maxAttempts}) in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenAttempts));
      }
    }

    this.configured = false;
    return false;
  }
}

module.exports = new SetupService();
