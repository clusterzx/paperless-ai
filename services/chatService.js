// services/chatService.js
const OpenAIService = require('./openaiService');
const PaperlessService = require('./paperlessService');
const config = require('../config/config');
const fs = require('fs');
const path = require('path');
const os = require('os');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const { OpenAI } = require('openai');

class ChatService {
  constructor() {
    this.chats = new Map(); // Stores chat histories: documentId -> messages[]
    this.tempDir = path.join(os.tmpdir(), 'paperless-chat');
    
    // Create temporary directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Downloads the original file from Paperless
   * @param {string} documentId - The ID of the document
   * @returns {Promise<{filePath: string, filename: string, mimeType: string}>}
   */
  async downloadDocument(documentId) {
    try {
      const document = await PaperlessService.getDocument(documentId);
      const tempFilePath = path.join(this.tempDir, `${documentId}_${document.original_filename}`);
      
      // Create download stream
      const response = await PaperlessService.client.get(`/documents/${documentId}/download/`, {
        responseType: 'stream'
      });

      // Save file temporarily
      await pipeline(
        response.data,
        fs.createWriteStream(tempFilePath)
      );

      return {
        filePath: tempFilePath,
        filename: document.original_filename,
        mimeType: document.mime_type
      };
    } catch (error) {
      console.error(`Error downloading document ${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Initializes a new chat for a document
   * @param {string} documentId - The ID of the document
   */
  async initializeChat(documentId) {
    try {
      // Get document information
      const document = await PaperlessService.getDocument(documentId);
      let documentContent;

      try {
        documentContent = await PaperlessService.getDocumentContent(documentId);
      } catch (error) {
        console.warn('Could not get direct document content, trying file download...', error);
        const { filePath } = await this.downloadDocument(documentId);
        documentContent = await fs.promises.readFile(filePath, 'utf8');
      }

      // Create initial system prompt
      const messages = [
        {
          role: "system",
          content: `You are a helpful assistant for the document "${document.title}". 
                   Use the following document content as context for your responses. 
                   If you don't know something or it's not in the document, please say so honestly.
                   
                   Document content:
                   ${documentContent}`
        }
      ];
      
      this.chats.set(documentId, {
        messages,
        documentTitle: document.title
      });
      
      return {
        documentTitle: document.title,
        initialized: true
      };
    } catch (error) {
      console.error(`Error initializing chat for document ${documentId}:`, error);
      throw error;
    }
  }

  async sendMessageStream(documentId, userMessage, res) {
    try {
      if (!this.chats.has(documentId)) {
        await this.initializeChat(documentId);
      }

      const chatData = this.chats.get(documentId);
      chatData.messages.push({
        role: "user",
        content: userMessage
      });

      // Set headers for SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let fullResponse = '';
      const aiProvider = process.env.AI_PROVIDER;

      if (aiProvider === 'openai') {
        // Make sure OpenAIService is initialized
        OpenAIService.initialize();
        
        // Always create a new client instance for this request to ensure it works
        const openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        });
        
        const stream = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4',
          messages: chatData.messages,
          stream: true,
        });
        
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            fullResponse += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }
      } else if (aiProvider === 'custom') {
        // Use OpenAI SDK with custom base URL
        const customOpenAI = new OpenAI({
          baseURL: process.env.CUSTOM_BASE_URL,
          apiKey: process.env.CUSTOM_API_KEY,
        });

        const stream = await customOpenAI.chat.completions.create({
          model: process.env.CUSTOM_MODEL,
          messages: chatData.messages,
          stream: true,
        });
        
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            fullResponse += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }
      } else if (aiProvider === 'azure') {
        // Use OpenAI SDK with Azure configuration
        const azureOpenAI = new OpenAI({
          apiKey: process.env.AZURE_API_KEY,
          baseURL: `${process.env.AZURE_ENDPOINT}/openai/deployments/${process.env.AZURE_DEPLOYMENT_NAME}`,
          defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
        });

        const stream = await azureOpenAI.chat.completions.create({
          model: process.env.AZURE_DEPLOYMENT_NAME,
          messages: chatData.messages,
          stream: true,
        });
        
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            fullResponse += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }
      } else if (aiProvider === 'ollama') {
        // Use OpenAI SDK for Ollama with OpenAI API compatibility
        const ollamaOpenAI = new OpenAI({
          baseURL: `${process.env.OLLAMA_API_URL}/v1`,
          apiKey: 'ollama', // Ollama doesn't require a real API key but the SDK requires some value
        });

        const stream = await ollamaOpenAI.chat.completions.create({
          model: process.env.OLLAMA_MODEL,
          messages: chatData.messages,
          stream: true,
        });
        
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            fullResponse += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }
      } else if (aiProvider === 'ionos') {
        // Use OpenAI SDK for IONOS with OpenAI API compatibility
        const ionosOpenAI = new OpenAI({
          baseURL: 'https://openai.inference.de-txl.ionos.com/v1',
          apiKey: process.env.IONOS_API_KEY,
        });

        const stream = await ionosOpenAI.chat.completions.create({
          model: process.env.IONOS_MODEL || 'meta-llama/Meta-Llama-3.1-8B-Instruct',
          messages: chatData.messages,
          stream: true,
        });
        
        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          if (content) {
            fullResponse += content;
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }
      } else {
        throw new Error('AI Provider not configured');
      }

      // Add the complete response to chat history
      chatData.messages.push({
        role: "assistant",
        content: fullResponse
      });
      this.chats.set(documentId, chatData);

      // End the stream
      res.write('data: [DONE]\n\n');
      res.end();

    } catch (error) {
      console.error(`Error in sendMessageStream:`, error);
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }

  getChatHistory(documentId) {
    const chatData = this.chats.get(documentId);
    return chatData ? chatData.messages : [];
  }

  chatExists(documentId) {
    return this.chats.has(documentId);
  }

  async cleanup() {
    try {
      for (const documentId of this.chats.keys()) {
        await this.deleteChat(documentId);
      }
      if (fs.existsSync(this.tempDir)) {
        await fs.promises.rmdir(this.tempDir, { recursive: true });
      }
    } catch (error) {
      console.error('Error cleaning up ChatService:', error);
    }
  }
}

module.exports = new ChatService();
