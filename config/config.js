const path = require('path');
const currentDir = decodeURIComponent(process.cwd());
const envPath = path.join(currentDir, 'data', '.env');
console.log('Loading .env from:', envPath); // Debug log
require('dotenv').config({ path: envPath });

// Helper function to parse boolean-like env vars
const parseEnvBoolean = (value, defaultValue = 'yes') => {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes' ? 'yes' : 'no';
};

// Initialize limit functions with defaults
const limitFunctions = {
  activateTagging: parseEnvBoolean(process.env.ACTIVATE_TAGGING, 'yes'),
  activateCorrespondents: parseEnvBoolean(process.env.ACTIVATE_CORRESPONDENTS, 'yes'),
  activateDocumentType: parseEnvBoolean(process.env.ACTIVATE_DOCUMENT_TYPE, 'yes'),
  activateTitle: parseEnvBoolean(process.env.ACTIVATE_TITLE, 'yes'),
  activateCustomFields: parseEnvBoolean(process.env.ACTIVATE_CUSTOM_FIELDS, 'yes')
};

console.log('Loaded environment variables:', {
  PAPERLESS_API_URL: process.env.PAPERLESS_API_URL,
  PAPERLESS_API_TOKEN: '******',
  LIMIT_FUNCTIONS: limitFunctions
});

module.exports = {
  PAPERLESS_AI_VERSION: '2.6.7',
  CONFIGURED: false,
  disableAutomaticProcessing: process.env.DISABLE_AUTOMATIC_PROCESSING || 'no',
  predefinedMode: process.env.PROCESS_PREDEFINED_DOCUMENTS,
  addAIProcessedTag: process.env.ADD_AI_PROCESSED_TAG || 'no',
  addAIProcessedTags: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
  paperless: {
    apiUrl: process.env.PAPERLESS_API_URL,
    apiToken: process.env.PAPERLESS_API_TOKEN
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY
  },
  ollama: {
    apiUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2',
    structuredOutput: process.env.OLLAMA_STRUCTURED_OUTPUT || 'yes'
  },
  custom: {
    apiUrl: process.env.CUSTOM_BASE_URL || '',
    apiKey: process.env.CUSTOM_API_KEY || '',
    model: process.env.CUSTOM_MODEL || ''
  },
  customFields: process.env.CUSTOM_FIELDS || '',
  aiProvider: process.env.AI_PROVIDER || 'openai',
  scanInterval: process.env.SCAN_INTERVAL || '*/30 * * * *',
  // Add limit functions to config
  limitFunctions: {
    activateTagging: limitFunctions.activateTagging,
    activateCorrespondents: limitFunctions.activateCorrespondents,
    activateDocumentType: limitFunctions.activateDocumentType,
    activateTitle: limitFunctions.activateTitle,
    activateCustomFields: limitFunctions.activateCustomFields
  },

  specialPromptPreDefinedTagsWithoutJson: `You are a document analysis AI. You will analyze the document. 
  You take the main information to associate tags with the document. 
  You will also find the correspondent of the document (Sender not receiver). Also you find a meaningful and short title for the document.
  You are given a list of tags: ${process.env.PROMPT_TAGS}
  Only use the tags from the list and try to find the best fitting tags.
  You do not ask for additional information, you only use the information given in the document.
  
  Return the result EXCLUSIVELY as a JSON object. The Tags and Title MUST be in the language that is used in the document.`,
  get specialPromptPreDefinedTags() { return `${this.specialPromptPreDefinedTagsWithoutJson}\n${this.jsonPrompt}` },
  mustHavePromptWithoutJson: `Return the result EXCLUSIVELY as a JSON object. The Tags, Title and Document_Type MUST be in the language that is used in the document.:
  IMPORTANT: The custom_fields are optional and can be left out if not needed, only try to fill out the values if you find a matching information in the document.
  Do not change the value of field_name, only fill out the values. If the field is about money only add the number without currency and always use a . for decimal places.`,
  get mustHavePrompt() { return `${this.mustHavePromptWithoutJson}\n${this.jsonPrompt}` },
  jsonPrompt: `
  {
    "title": "xxxxx",
    "correspondent": "xxxxxxxx",
    "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
    "document_type": "Invoice/Contract/...",
    "document_date": "YYYY-MM-DD",
    "language": "en/de/es/...",
    %CUSTOMFIELDS%
  }`,
  jsonFormat: {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "description": "The title of the document."
      },
      "correspondent": {
        "type": "string",
        "description": "The name of the correspondent related to the document."
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "A list of tags associated with the document."
      },
      "document_type": {
        "type": "string",
        "description": "The type of document, e.g., 'invoice', 'contract', ..."
      },
      "document_date": {
        "type": "string",
        "format": "date",
        "description": "The date of the document in YYYY-MM-DD format."
      },
      "language": {
        "type": "string",
        "description": "The language of the document in ISO 639-1 format."
      }
    },
    "required": [
      "title",
      "document_type",
      "correspondent",
      "tags",
      "document_date",
      "language"
    ]
  },
  jsonFormatx: {
    "title": "string",
    "correspondent": "string",
    "tags": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "document_type": "string",
    "document_date": "string",
    "language": "string"
  },
};