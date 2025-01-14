// services/chatService.js
const AIServiceFactory = require('./aiServiceFactory');
const PaperlessService = require('./paperlessService');
const fs = require('fs');
const path = require('path');
const os = require('os');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

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

      // Check if AI client is initialized
      if (process.env.AI_PROVIDER){
        const service = AIServiceFactory.getServiceForProvider(process.env.AI_PROVIDER);
        service.initialize();
        if (!service.hasClient()){
          throw new Error('OpenAI client not initialized');
        }
      }

      // Get document information
      const document = await PaperlessService.getDocument(documentId);
      let documentContent;

      try {
        // First try to load document content directly
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
      
      // Store chat history
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

  /**
   * Sends a message to the chat and receives a response
   * @param {string} documentId - The ID of the document
   * @param {string} userMessage - The user's message
   */
  async sendMessage(documentId, userMessage) {
    try {
      // Check if chat exists
      if (!this.chats.has(documentId)) {
        await this.initializeChat(documentId);
      }

      const chatData = this.chats.get(documentId);
      
      // Add user message
      chatData.messages.push({
        role: "user",
        content: userMessage
      });

      if (process.env.AI_PROVIDER){
        const service = AIServiceFactory.getServiceForProvider(process.env.AI_PROVIDER);
        const {message, metrics} = await service.sendMessage(chatData.messages);

        // Add assistant's response to history
        chatData.messages.push(message);

        // Update chat history
        this.chats.set(documentId, chatData);

        return {
          reply: message.content,
          metrics: metrics
        };
      }else{
        throw new Error('AI Provider not found');
      }
    } catch (error) {
      console.error(`Error sending message for document ${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Deletes a chat and cleans up temporary files
   * @param {string} documentId - The ID of the document
   */
  async deleteChat(documentId) {
    try {
      const chatData = this.chats.get(documentId);
      if (chatData && chatData.tempFilePath) {
        if (fs.existsSync(chatData.tempFilePath)) {
          await fs.promises.unlink(chatData.tempFilePath);
        }
      }
      return this.chats.delete(documentId);
    } catch (error) {
      console.error(`Error deleting chat for document ${documentId}:`, error);
      throw error;
    }
  }

  /**
   * Returns the current chat history
   * @param {string} documentId - The ID of the document
   */
  getChatHistory(documentId) {
    const chatData = this.chats.get(documentId);
    return chatData ? chatData.messages : [];
  }

  /**
   * Checks if a chat exists for a document
   * @param {string} documentId - The ID of the document
   */
  chatExists(documentId) {
    return this.chats.has(documentId);
  }

  /**
   * Cleanup method for the service
   * Should be called when shutting down the application
   */
  async cleanup() {
    try {
      // Delete all active chats
      for (const documentId of this.chats.keys()) {
        await this.deleteChat(documentId);
      }

      // Delete temporary directory
      if (fs.existsSync(this.tempDir)) {
        await fs.promises.rmdir(this.tempDir, { recursive: true });
      }
    } catch (error) {
      console.error('Error cleaning up ChatService:', error);
    }
  }
}

module.exports = new ChatService();