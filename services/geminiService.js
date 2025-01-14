const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config/config');
const paperlessService = require('./paperlessService');
const fs = require('fs').promises;
const path = require('path');

const generationConfig = {
    temperature: 0.3,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain"
};

class GeminiService {
    constructor() {
        this.client = null;
        this.model = null;
    }

    initialize() {
        this.client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model = this.client.getGenerativeModel({
            model: this.getModel(),
        });
    }

    hasClient() {
        return this.client != null;
    }

    getModel() {
        return process.env.GEMINI_API_MODEL || "gemini-1.5-flash";
    }

    // Calculate tokens for a given text
    async calculateTokens(text) {
        const req = {
            contents: [{ role: 'user', parts: [{ text }] }],
        };
        const { totalTokens } = await this.model.countTokens(req);
        return totalTokens;
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
        // Format existing tags
        const existingTagsList = existingTags
            .map(tag => tag.name)
            .join(', ');

        const cachePath = path.join('./public/images', `${id}.png`);
        try {
            this.initialize();
            const now = new Date();
            const timestamp = now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

            if (!this.client) {
                throw new Error('Gemini client not initialized - missing API key');
            }

            // Handle thumbnail caching
            try {
                await fs.access(cachePath);
                console.log('[DEBUG] Thumbnail already cached');
            } catch {
                console.log('Thumbnail not cached, fetching from Paperless');

                const thumbnailData = await paperlessService.getThumbnailImage(id);

                if (!thumbnailData) {
                    console.warn('Thumbnail nicht gefunden');
                }

                await fs.mkdir(path.dirname(cachePath), { recursive: true });
                await fs.writeFile(cachePath, thumbnailData);
            }

            // Get system prompt and model
            let systemPrompt = process.env.SYSTEM_PROMPT;
            const model = process.env.OPENAI_MODEL;
            let promptTags = '';

            // Get system prompt and model
            if (process.env.USE_EXISTING_DATA === 'yes') {
                systemPrompt = `
            Prexisting tags: ${existingTagsList}\n\n
            Prexisiting correspondent: ${existingCorrespondentList}\n\n
            ` + process.env.SYSTEM_PROMPT;
                promptTags = '';
            } else {
                systemPrompt = process.env.SYSTEM_PROMPT;
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
            const history = [
                {
                    role: "user",
                    parts: [{ "text": systemPrompt }]
                }
            ]
            const chatSession = await this.model.startChat({ history, generationConfig });
            const result = await chatSession.sendMessage(truncatedContent);

            // Handle response
            if (!result?.response.text()) {
                throw new Error('Invalid API response structure');
            }

            let jsonContent = result?.response.text();
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

            if (!this.client) {
                throw new Error('Gemini client not initialized - missing API key');
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
            const history = [
                {
                    role: "user",
                    parts: [{ "text": prompt + musthavePrompt }]
                }
            ]
            const chatSession = await this.model.startChat({ history, generationConfig });
            const result = await chatSession.sendMessage(truncatedContent);

            // Handle response
            if (!result?.response.text()) {
                throw new Error('Invalid API response structure');
            }


            let jsonContent = result?.response.text();
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

    async sendMessage(messages) {
        //We need to convert the message from openai to gemini - for each
        const history = messages.map(({ role, content }) => ({ role, parts: [{ text: content }] }));
        history[0].role = "user";

        const message = history.pop().parts[0].text;

        const chatSession = await this.model.startChat({ history, generationConfig });
        const result = await chatSession.sendMessage(message);

        return {
            "role": "system",
            "content": result.response.text()
        }
    }
}

module.exports = new GeminiService();