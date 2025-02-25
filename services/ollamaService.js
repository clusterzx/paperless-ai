const axios = require('axios');
const config = require('../config/config');
const fs = require('fs').promises;
const path = require('path');
const paperlessService = require('./paperlessService');
const os = require('os');
const { Console } = require('console');

class OllamaService {
    constructor() {
        this.apiUrl = config.ollama.apiUrl;
        this.model = config.ollama.model;
        this.structuredOutput = config.ollama.structuredOutput;
        this.client = axios.create({
            timeout: 1800000 // 30 minutes timeout
        });
    }

    async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], id, customPrompt = null) {
        const cachePath = path.join('./public/images', `${id}.png`);
        try {
            // Handle thumbnail caching
            try {
                await fs.access(cachePath);
                console.debug('Thumbnail already cached');
            } catch (err) {
                console.info('Thumbnail not cached, fetching from Paperless');
                const thumbnailData = await paperlessService.getThumbnailImage(id);
                if (!thumbnailData) {
                    console.warn('Thumbnail not found');
                }
                await fs.mkdir(path.dirname(cachePath), {recursive: true});
                await fs.writeFile(cachePath, thumbnailData);
            }

            const response = await this._postOllamaRequest(content, existingTags, existingCorrespondentList, customPrompt, true);
            return this._convertToOpenAiResponse(response);
        } catch (error) {
            console.error('Error analyzing document with Ollama:', error);
            return {
                document: {tags: [], correspondent: null},
                metrics: null,
                error: error.message
            };
        }
    }

    async analyzePlayground(content, existingTags = [], existingCorrespondentList = [], prompt) {
        try {
            const response = await this._postOllamaRequest(content, existingTags, existingCorrespondentList, prompt);
            return this._convertToOpenAiResponse(response);
        } catch (error) {
            console.error('Error analyzing document with Ollama:', error);
            return {
                document: { tags: [], correspondent: null },
                metrics: null,
                error: error.message
            };
        }
    }

    _buildSystemPrompt(existingTags = [], existingCorrespondent = [], prompt = null) {
        let systemPrompt = '';

        if (this.structuredOutput === 'yes') {
            if (process.env.USE_PROMPT_TAGS === 'yes') {
                systemPrompt = config.specialPromptPreDefinedTagsWithoutJson;
            } else {
                systemPrompt = config.mustHavePromptWithoutJson;
            }
        } else {
            if (process.env.USE_PROMPT_TAGS === 'yes') {
                systemPrompt += config.specialPromptPreDefinedTags.replace('%CUSTOMFIELDS%', this._getCustomFields());
            } else {
                systemPrompt += config.mustHavePrompt.replace('%CUSTOMFIELDS%', this._getCustomFields());
            }
        }

        // Format existing tags
        const existingTagsList = Array.isArray(existingTags)
            ? existingTags
                .filter(tag => tag && tag.name)
                .map(tag => tag.name)
                .join(', ')
            : '';

        // Format existing correspondents - handle both array of objects and array of strings
        const existingCorrespondentList =  Array.isArray(existingCorrespondent)
            ? existingCorrespondent
                .filter(Boolean)  // Remove any null/undefined entries
                .map(correspondent => {
                    if (typeof correspondent === 'string') return correspondent;
                    return correspondent?.name || '';
                })
                .filter(name => name.length > 0)  // Remove empty strings
                .join(', ')
            : '';
    
        if (process.env.USE_EXISTING_DATA === 'yes') {
            systemPrompt = `${systemPrompt}
                ${config.existingDataPrompt}
                Existing tags: ${existingTagsList}
                Existing Correspondents: ${existingCorrespondentList}`;
        }

        if (prompt) {
            console.debug('Replace system prompt with custom prompt');
            systemPrompt += "\n\n" + prompt;
        }
        else {
            systemPrompt += "\n\n" + process.env.SYSTEM_PROMPT;
        }

        return systemPrompt;
    }

    _parseResponse(response) {
      try {
          // Find JSON in response using regex
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
              //console.warn('No JSON found in response:', response);
              return { tags: [], correspondent: null };
          }
  
          let jsonStr = jsonMatch[0];
          console.log('Extracted JSON String:', jsonStr);
  
          try {
              // Attempt to parse the JSON
              const result = JSON.parse(jsonStr);
  
              // Validate and return the result
              return {
                  tags: Array.isArray(result.tags) ? result.tags : [],
                  correspondent: result.correspondent || null,
                  title: result.title || null,
                  document_date: result.document_date || null,
                  document_type: result.document_type || null,
                  language: result.language || null,
                  custom_fields: result.custom_fields || null
              };
  
          } catch (error) {
              console.warn('Error parsing JSON from response:', error.message);
              console.warn('Attempting to sanitize the JSON...');
  
              // Optionally sanitize the JSON here
              jsonStr = jsonStr
                  .replace(/,\s*}/g, '}') // Remove trailing commas before closing braces
                  .replace(/,\s*]/g, ']') // Remove trailing commas before closing brackets
                  .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":'); // Ensure property names are quoted
  
              try {
                  const sanitizedResult = JSON.parse(jsonStr);
                  return {
                      tags: Array.isArray(sanitizedResult.tags) ? sanitizedResult.tags : [],
                      correspondent: sanitizedResult.correspondent || null,
                      title: sanitizedResult.title || null,
                      document_date: sanitizedResult.document_date || null,
                      language: sanitizedResult.language || null
                  };
              } catch (finalError) {
                  console.error('Final JSON parsing failed after sanitization.\nThis happens when the JSON structure is too complex or invalid.\nThat indicates an issue with the generated JSON string by Ollama.\nSwitch to OpenAI for better results or fine tune your prompt.');
                  //console.error('Sanitized JSON String:', jsonStr);
                  return { tags: [], correspondent: null };
              }
          }
      } catch (error) {
          console.error('Error parsing Ollama response:', error.message);
          console.error('Raw response:', response);
          return { tags: [], correspondent: null };
      }
  }

    _truncateContent(content) {
        // if process.env.CONTENT_MAX_LENGTH is set, truncate the content to the specified length
        try {
            if (process.env.CONTENT_MAX_LENGTH) {
                console.log('Truncating content to max length:', process.env.CONTENT_MAX_LENGTH);
                content = content.substring(0, process.env.CONTENT_MAX_LENGTH);
            }
        } catch (error) {
            console.error('Error truncating content:', error);
        }
        return content;
    }

    _getCustomFields() {
        // Parse CUSTOM_FIELDS from environment variable
        let customFieldsObj;
        try {
            customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
        } catch (error) {
            console.error('Failed to parse CUSTOM_FIELDS:', error);
            customFieldsObj = { custom_fields: [] };
        }

        // Generate custom fields template for the prompt
        const customFieldsTemplate = {};

        customFieldsObj.custom_fields.forEach((field, index) => {
            customFieldsTemplate[index] = {
                field_name: field.value,
                value: "Fill in the value based on your analysis"
            };
        });

        // Convert template to string for replacement and wrap in custom_fields
        const customFieldsStr = '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
            .split('\n')
            .map(line => '    ' + line)  // Add proper indentation
            .join('\n');

        return customFieldsStr;
    }

    _getFormat() {
        if (!this.structuredOutput) {
            return "json";
        }

        // Parse CUSTOM_FIELDS from environment variable
        let customFieldsObj;
        try {
            customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
        } catch (error) {
            console.error('Failed to parse CUSTOM_FIELDS:', error);
            customFieldsObj = { custom_fields: [] };
        }

        const format = { ...config.jsonFormat };

        if (customFieldsObj.custom_fields.length !== 0) {
            format.properties.custom_fields = {
                "type": "object",
                "properties": {}
            };

            customFieldsObj.custom_fields.forEach((field, index) => {
                format.properties.custom_fields.properties[index] = {
                    "type": "object",
                    "properties": {
                        "field_name": {
                            "type": "string",
                            "const": field.value
                        },
                        "value": {
                            "type": "string"
                        }
                    }
                };
                if (field.data_type === 'float'
                    || field.data_type === 'monetary') {
                    format.properties.custom_fields.properties[index].properties.value.type = "number";
                } else if (field.data_type === 'integer') {
                    format.properties.custom_fields.properties[index].properties.value.type = "integer";
                }
            });

        }
        return format;
    }

    _calculatePromptTokenCount(prompt) {
        return Math.ceil(prompt.length / 4);
    }

    _calculateNumCtx(prompt, expectedResponseTokens) {
        const promptTokenCount = this._calculatePromptTokenCount(prompt);
        const totalTokenUsage = promptTokenCount + expectedResponseTokens;
        const maxCtxLimit = 128000;

        const numCtx = Math.min(totalTokenUsage, maxCtxLimit);

        console.log('Prompt Token Count:', promptTokenCount);
        console.log('Expected Response Tokens:', expectedResponseTokens);
        console.log('Dynamic calculated num_ctx:', numCtx);

        return numCtx;
    }

    async _writePromptToFile(systemPrompt) {
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
            await fs.appendFile(filePath, '================================================================================' + systemPrompt + '\n\n' + '================================================================================\n\n');
        } catch (error) {
            console.error('[ERROR] Error writing to file:', error);
        }
    }

    async _postOllamaRequest(content, existingTags = [], existingCorrespondent = [], customPrompt = null, writeToFile = false) {
        const systemPrompt = this._buildSystemPrompt(existingTags, existingCorrespondent, customPrompt);
        let format = this._getFormat();

        const expectedResponseTokens = 1024;
        const numCtx = this._calculateNumCtx(content, expectedResponseTokens);
        const truncatedContent = this._truncateContent(content);
        console.debug('Ollama Request:',
            `\nSystem Prompt: ${systemPrompt}\n\nPrompt: ${truncatedContent}\n\nnum_ctx: ${numCtx}\n\nFormat: ${JSON.stringify(format)}`)

        const response = await this.client.post(`${this.apiUrl}/api/generate`, {
            model: this.model,
            prompt: truncatedContent,
            system: systemPrompt,
            format: format,
            stream: false,
            options: {
                temperature: 0.7,
                top_p: 0.9,
                repeat_penalty: 1.1,
                top_k: 7,
                num_predict: 256,
                num_ctx: numCtx
            }
            //   options: {
            //     temperature: 0.3,        // Moderately low for balance between consistency and creativity
            //     top_p: 0.7,             // More reasonable value to allow sufficient token diversity
            //     repeat_penalty: 1.1,     // Return to original value as 1.2 might be too restrictive
            //     top_k: 40,              // Increased from 10 to allow more token options
            //     num_predict: 512,        // Reduced from 1024 to a more stable value
            //     num_ctx: 2048           // Reduced context window for more stable processing
            // }
        });

        if (!response.data || !response.data.response) {
            throw new Error('Invalid response from Ollama API');
        }
        console.debug('Ollama response:', response.data.response);

        const parsedResponse = this._parseResponse(response.data.response);
        console.debug('Ollama response (parsed):', parsedResponse);

        if (writeToFile) {
            await this._writePromptToFile(systemPrompt + "\n\n" + truncatedContent + "\n\n" + JSON.stringify(parsedResponse));
        }

        if (parsedResponse.tags.length === 0 && parsedResponse.correspondent === null) {
            console.warn('No tags or correspondent found in response from Ollama for Document.\nPlease review your prompt or switch to OpenAI for better results.',);
        }

        return parsedResponse;
    }

    _convertToOpenAiResponse(ollamaResponse) {
        return {
            document: ollamaResponse,
            metrics: {
                promptTokens: 0, // Ollama doesn't provide token metrics
                completionTokens: 0,
                totalTokens: 0
            },
            truncated: false
        }
    }
}

module.exports = new OllamaService();