const path = require('path');
const currentDir = decodeURIComponent(process.cwd());
const envPath = path.join(currentDir, 'data', '.env');
console.log('Loading .env from:', envPath); // Debug log
require('dotenv').config({ path: envPath });


console.log('Loaded environment variables:', {
  PAPERLESS_API_URL: process.env.PAPERLESS_API_URL,
  PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN,
});

module.exports = {
  PAPERLESS_AI_VERSION: '2.1.9',
  CONFIGURED: false,
  predefinedMode: process.env.PROCESS_PREDEFINED_DOCUMENTS,
  paperless: {
    apiUrl: process.env.PAPERLESS_API_URL,
    apiToken: process.env.PAPERLESS_API_TOKEN
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY
  },
  ollama: {
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama2'
  },
  aiProvider: process.env.AI_PROVIDER || 'openai',
  scanInterval: process.env.SCAN_INTERVAL || '*/30 * * * *',
  specialPromptPreDefinedTags: `You are a document analysis AI. You will analyze the document. 
  You take the main information to associate tags with the document. 
  You will also find the correspondent of the document (Sender not reciever). Also you find a meaningful and short title for the document.
  You are given a list of tags: ${process.env.PROMPT_TAGS}
  Only use the tags from the list and try to find the best fitting tags.
  You do not ask for additional information, you only use the information given in the document.
  
  Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.:
  {
    "title": "xxxxx",
    "correspondent": "xxxxxxxx",
    "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
    "document_date": "YYYY-MM-DD",
    "language": "en/de/es/..."
  }`,
};