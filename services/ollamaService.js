const axios = require('axios');
const config = require('../config/config');
const fs = require('fs').promises;
const path = require('path');
const paperlessService = require('./paperlessService');

class OllamaService {
    constructor() {
        this.apiUrl = config.ollama.apiUrl;
        this.model = config.ollama.model;
        this.client = axios.create({
            timeout: 1200000 // 10 minutes timeout
        });
    }

    async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], id) {
        const cachePath = path.join('./public/images', `${id}.png`);
        try {
            const now = new Date();
            const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
            const prompt = this._buildPrompt(content, existingTags, existingCorrespondentList);

            // Handle thumbnail caching
            try {
                await fs.access(cachePath);
                console.log('[DEBUG] Thumbnail already cached');
            } catch (err) {
                console.log('Thumbnail not cached, fetching from Paperless');
                const thumbnailData = await paperlessService.getThumbnailImage(id);
                if (!thumbnailData) {
                    console.warn('Thumbnail nicht gefunden');
                }
                await fs.mkdir(path.dirname(cachePath), { recursive: true });
                await fs.writeFile(cachePath, thumbnailData);
            }

            await this.writePromptToFile(prompt);

            const response = await this.client.post(`${this.apiUrl}/api/generate`, {
                model: this.model,
                prompt: prompt,
                system: `
                You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
                YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
                YOU MUSTNOT: Return a response without the desired JSON format.
                YOU MUST: Analyze the document content and extract the following information into this structured JSON format and only this format!:         {
                "title": "xxxxx",
                "correspondent": "xxxxxxxx",
                "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
                "document_date": "YYYY-MM-DD",
                "language": "en/de/es/..."
                }
                ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
                `,
                stream: false,
                options: {
                    temperature: 0.7,
                    top_p: 0.9,
                    repeat_penalty: 1.1,
                    top_k: 7,
                    num_predict: 256,
                    num_ctx: prompt.length + 256
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

            const parsedResponse = this._parseResponse(response.data.response);
            //console.log('Ollama response:', parsedResponse);
            if (parsedResponse.tags.length === 0 && parsedResponse.correspondent === null) {
                console.warn('No tags or correspondent found in response from Ollama for Document.\nPlease review your prompt or switch to OpenAI for better results.',);
            }

            // Match the OpenAI service response structure
            return {
                document: parsedResponse,
                metrics: {
                    promptTokens: 0,  // Ollama doesn't provide token metrics
                    completionTokens: 0,
                    totalTokens: 0
                },
                truncated: false
            };

        } catch (error) {
            console.error('Error analyzing document with Ollama:', error);
            return {
                document: { tags: [], correspondent: null },
                metrics: null,
                error: error.message
            };
        }
    }


    async writePromptToFile(systemPrompt) {
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


    async analyzePlayground(content, prompt) {
        try {
            prompt = prompt + "\n\n" + JSON.stringify(content)
            const response = await this.client.post(`${this.apiUrl}/api/generate`, {
                model: this.model,
                prompt: prompt,
                system: `
                You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
                YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
                YOU MUSTNOT: Return a response without the desired JSON format.
                YOU MUST: Analyze the document content and extract the following information into this structured JSON format and only this format!:         {
                "title": "xxxxx",
                "correspondent": "xxxxxxxx",
                "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
                "document_date": "YYYY-MM-DD",
                "language": "en/de/es/..."
                }
                ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
                `,
                stream: false,
                options: {
                    temperature: 0.7,
                    top_p: 0.9,
                    repeat_penalty: 1.1,
                    top_k: 7,
                    num_predict: 256,
                    num_ctx: prompt.length + 256
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

            const parsedResponse = this._parseResponse(response.data.response);
            //console.log('Ollama response:', parsedResponse);
            if (parsedResponse.tags.length === 0 && parsedResponse.correspondent === null) {
                console.warn('No tags or correspondent found in response from Ollama for Document.\nPlease review your prompt or switch to OpenAI for better results.',);
            }

            // Match the OpenAI service response structure
            return {
                document: parsedResponse,
                metrics: {
                    promptTokens: 0,  // Ollama doesn't provide token metrics
                    completionTokens: 0,
                    totalTokens: 0
                },
                truncated: false
            };

        } catch (error) {
            console.error('Error analyzing document with Ollama:', error);
            return {
                document: { tags: [], correspondent: null },
                metrics: null,
                error: error.message
            };
        }
    }

    _buildPrompt(content, existingTags = [], existingCorrespondent = []) {
        let systemPrompt;
        let promptTags = '';

        // Validate that existingCorrespondent is an array and handle if it's not
        const correspondentList = Array.isArray(existingCorrespondent)
            ? existingCorrespondent
            : [];

        if (process.env.USE_PROMPT_TAGS === 'yes') {
            promptTags = process.env.PROMPT_TAGS;
            systemPrompt = config.specialPromptPreDefinedTags;
        } else {
            systemPrompt = process.env.SYSTEM_PROMPT;
        }

        // Format existing tags
        const existingTagsList = Array.isArray(existingTags)
            ? existingTags
                .filter(tag => tag && tag.name)
                .map(tag => tag.name)
                .join(', ')
            : '';

        // Format existing correspondents - handle both array of objects and array of strings
        const existingCorrespondentList = correspondentList
            .filter(Boolean)  // Remove any null/undefined entries
            .map(correspondent => {
                if (typeof correspondent === 'string') return correspondent;
                return correspondent?.name || '';
            })
            .filter(name => name.length > 0)  // Remove empty strings
            .join(', ');

        if (process.env.USE_EXISTING_DATA === 'yes') {
            return `${systemPrompt}
            Existing tags: ${existingTagsList}\n
            Existing Correspondents: ${existingCorrespondentList}\n
            ${JSON.stringify(content)}
            
            `;
        } else {
            return `${systemPrompt}
            ${JSON.stringify(content)}
            `;
        }
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
                    language: result.language || null
                };

            } catch (errorx) {
                console.warn('Error parsing JSON from response:', errorx.message);
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
}

module.exports = new OllamaService();