const express = require('express');
const router = express.Router();
const SetupService = require('../services/setupService.js');
const setupService = new SetupService();
const paperlessService = require('../services/paperlessService.js');
const openaiService = require('../services/openaiService.js');
const ollamaService = require('../services/ollamaService.js');
const documentModel = require('../models/document.js');
const debugService = require('../services/debugService.js');
const configFile = require('../config/config.js');
const ChatService = require('../services/chatService.js');
const documentsService = require('../services/documentsService.js');
const fs = require('fs').promises;
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { authenticateJWT, isAuthenticated } = require('./auth.js');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const customService = require('../services/customService.js');
const {ThumbnailService} = require("../services/thumbnailService");
require('dotenv').config({ path: '../data/.env' });


// API endpoints that should not redirect
const API_ENDPOINTS = ['/health'];
// Routes that don't require authentication
let PUBLIC_ROUTES = [
  '/health',
  '/login',
  '/logout',
  '/setup'
];

// Combined middleware to check authentication and setup
router.use(async (req, res, next) => {
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  const apiKey = req.headers['x-api-key'];

  // Public route check
  if (PUBLIC_ROUTES.some(route => req.path.startsWith(route))) {
    return next();
  }

  // API key authentication
  if (apiKey && apiKey === process.env.API_KEY) {
    req.user = { apiKey: true };
  } else {
    // Fallback to JWT authentication
    if (!token) {
      return res.redirect('/login');
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (error) {
      res.clearCookie('jwt');
      return res.redirect('/login');
    }
  }

  // Setup check
  try {
    const isConfigured = await setupService.isConfigured();
    console.log('env:', process.env.PAPERLESS_AI_INITIAL_SETUP);
  
    if (!isConfigured && (!process.env.PAPERLESS_AI_INITIAL_SETUP || process.env.PAPERLESS_AI_INITIAL_SETUP === 'no') && !req.path.startsWith('/setup')) {
      return res.redirect('/setup');
    } else if (!isConfigured && process.env.PAPERLESS_AI_INITIAL_SETUP === 'yes' && !req.path.startsWith('/settings')) {
      return res.redirect('/settings');
    }
  } catch (error) {
    console.error('Error checking setup configuration:', error);
    return res.status(500).send('Internal Server Error');
  }
  
  next();
});

// Protected route middleware for API endpoints
const protectApiRoute = (req, res, next) => {
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

router.get('/login', (req, res) => {
  //check if a user exists beforehand
  documentModel.getUsers().then((users) => {
    if(users.length === 0) {
      res.redirect('setup');
    } else {
      res.render('login', { error: null });
    }
  });
});

// Login page route
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    console.log('Login attempt for user:', username);   
    // Get user data - returns a single user object
    const user = await documentModel.getUser(username);
    
    // Check if user was found and has required fields
    if (!user || !user.password) {
      console.log('[FAILED LOGIN] User not found or invalid data:', username);
      return res.render('login', { error: 'Invalid credentials' });
    }

    // Compare passwords
    const isValidPassword = await bcrypt.compare(password, user.password);
    console.log('Password validation result:', isValidPassword);

    if (isValidPassword) {
      const token = jwt.sign(
        { 
          id: user.id, 
          username: user.username 
        },
        JWT_SECRET,
        { expiresIn: '24h' }
      );
      res.cookie('jwt', token, {
        httpOnly: true,
        secure: false,  
        sameSite: 'lax', 
        path: '/',
        maxAge: 24 * 60 * 60 * 1000 
      });

      return res.redirect('/dashboard');
    }else{
      return res.render('login', { error: 'Invalid credentials' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { error: 'An error occurred during login' });
  }
});


// Logout route
router.get('/logout', (req, res) => {
  res.clearCookie('jwt');
  res.redirect('/login');
});

router.get('/sampleData/:id', async (req, res) => {
  try {
    //get all correspondents from one document by id
    const document = await paperlessService.getDocument(req.params.id);
    const correspondents = await paperlessService.getCorrespondentsFromDocument(document.id);

  } catch (error) {
    console.error('[ERRO] loading sample data:', error);
    res.status(500).json({ error: 'Error loading sample data' });
  }
});

// Documents view route
router.get('/playground', protectApiRoute, async (req, res) => {
  try {
    const {
      documents,
      tagNames,
      correspondentNames,
      paperlessUrl
    } = await documentsService.getDocumentsWithMetadata();

    //limit documents to 16 items
    documents.length = 16;

    res.render('playground', {
      documents,
      tagNames,
      correspondentNames,
      paperlessUrl,
      version: configFile.PAPERLESS_AI_VERSION || ' '
    });
  } catch (error) {
    console.error('[ERRO] loading documents view:', error);
    res.status(500).send('Error loading documents');
  }
});

router.get('/thumb/:documentId', async (req, res) => {
  const thumbnailService = new ThumbnailService();
  const cachePath = thumbnailService.getThumbnailPath(req.params.documentId)

  if (cachePath !== undefined) {
    res.setHeader('Content-Type', 'image/png');
    res.sendFile(path.resolve(cachePath));
  } else {
    // cachePath being either undefined or null indicates that the thumbnail
    // could either not be found or there was an error retrieving it.
    // In that case indicate 404 (not found)
    res.status(404).send('Fehler beim Laden des Thumbnails');
  }
});

// Hauptseite mit Dokumentenliste
router.get('/chat', async (req, res) => {
  try {
      const {open} = req.query;
      const documents = await paperlessService.getDocuments();
      const version = configFile.PAPERLESS_AI_VERSION || ' ';
      res.render('chat', { documents, open, version });
  } catch (error) {
    console.error('[ERRO] loading documents:', error);
    res.status(500).send('Error loading documents');
  }
});

// Chat initialisieren
router.get('/chat/init', async (req, res) => {
  const documentId = req.query.documentId;
  const result = await ChatService.initializeChat(documentId);
  res.json(result);
});

// Nachricht senden
router.post('/chat/message', async (req, res) => {
  try {
    const { documentId, message } = req.body;
    if (!documentId || !message) {
      return res.status(400).json({ error: 'Document ID and message are required' });
    }
    
    // Use the new streaming method
    await ChatService.sendMessageStream(documentId, message, res);
  } catch (error) {
    console.error('Chat message error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/chat/init/:documentId', async (req, res) => {
  try {
      const { documentId } = req.params;
      if (!documentId) {
          return res.status(400).json({ error: 'Document ID is required' });
      }
      const result = await ChatService.initializeChat(documentId);
      res.json(result);
  } catch (error) {
      console.error('[ERRO] initializing chat:', error);
      res.status(500).json({ error: 'Failed to initialize chat' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const allTags = await paperlessService.getTags();
    const tagMap = new Map(allTags.map(tag => [tag.id, tag]));

    // Get all correspondents for filter dropdown
    const historyDocuments = await documentModel.getAllHistory();
    const allCorrespondents = [...new Set(historyDocuments.map(doc => doc.correspondent))]
      .filter(Boolean).sort();

    res.render('history', {
      version: configFile.PAPERLESS_AI_VERSION,
      filters: {
        allTags: allTags,
        allCorrespondents: allCorrespondents
      }
    });
  } catch (error) {
    console.error('[ERROR] loading history page:', error);
    res.status(500).send('Error loading history page');
  }
});

router.get('/api/history', async (req, res) => {
  try {
    const draw = parseInt(req.query.draw);
    const start = parseInt(req.query.start) || 0;
    const length = parseInt(req.query.length) || 10;
    const search = req.query.search?.value || '';
    const tagFilter = req.query.tag || '';
    const correspondentFilter = req.query.correspondent || '';

    // Get all documents
    const allDocs = await documentModel.getAllHistory();
    const allTags = await paperlessService.getTags();
    const tagMap = new Map(allTags.map(tag => [tag.id, tag]));

    // Format and filter documents
    let filteredDocs = allDocs.map(doc => {
      const tagIds = doc.tags === '[]' ? [] : JSON.parse(doc.tags || '[]');
      const resolvedTags = tagIds.map(id => tagMap.get(parseInt(id))).filter(Boolean);
      const baseURL = process.env.PAPERLESS_API_URL.replace(/\/api$/, '');

      return {
        document_id: doc.document_id,
        title: doc.title || 'Modified: Invalid Date',
        created_at: doc.created_at,
        tags: resolvedTags,
        correspondent: doc.correspondent || 'Not assigned',
        link: `${baseURL}/documents/${doc.document_id}/`
      };
    }).filter(doc => {
      const matchesSearch = !search || 
        doc.title.toLowerCase().includes(search.toLowerCase()) ||
        doc.correspondent.toLowerCase().includes(search.toLowerCase()) ||
        doc.tags.some(tag => tag.name.toLowerCase().includes(search.toLowerCase()));

      const matchesTag = !tagFilter || doc.tags.some(tag => tag.id === parseInt(tagFilter));
      const matchesCorrespondent = !correspondentFilter || doc.correspondent === correspondentFilter;

      return matchesSearch && matchesTag && matchesCorrespondent;
    });

    // Sort documents if requested
    if (req.query.order) {
      const order = req.query.order[0];
      const column = req.query.columns[order.column].data;
      const dir = order.dir === 'asc' ? 1 : -1;

      filteredDocs.sort((a, b) => {
        if (column === 'created_at') {
          return dir * (new Date(a[column]) - new Date(b[column]));
        }
        return dir * a[column].localeCompare(b[column]);
      });
    }

    res.json({
      draw: draw,
      recordsTotal: allDocs.length,
      recordsFiltered: filteredDocs.length,
      data: filteredDocs.slice(start, start + length)
    });
  } catch (error) {
    console.error('[ERROR] loading history data:', error);
    res.status(500).json({ error: 'Error loading history data' });
  }
});

router.post('/api/reset-all-documents', async (req, res) => {
  try {
    await documentModel.deleteAllDocuments();
    res.json({ success: true });
  }
  catch (error) {
    console.error('[ERROR] resetting documents:', error);
    res.status(500).json({ error: 'Error resetting documents' });
  }
});

router.post('/api/reset-documents', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: 'Invalid document IDs' });
    }

    await documentModel.deleteDocumentsIdList(ids);
    res.json({ success: true });
  }
  catch (error) {
    console.error('[ERROR] resetting documents:', error);
    res.status(500).json({ error: 'Error resetting documents' });
  }
});

router.post('/api/key-regenerate', async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const dotenv = require('dotenv');
    const crypto = require('crypto');    
    const envPath = path.join(__dirname, '../data/', '.env');
    const envConfig = dotenv.parse(fs.readFileSync(envPath));
    // Generiere ein neues API-Token
    const apiKey = crypto.randomBytes(32).toString('hex');
    envConfig.API_KEY = apiKey;

    // Schreibe die aktualisierte .env-Datei
    const envContent = Object.entries(envConfig)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    fs.writeFileSync(envPath, envContent);

    // Setze die Umgebungsvariable für den aktuellen Prozess
    process.env.API_KEY = apiKey;

    // Sende die Antwort zurück
    res.json({ success: apiKey });
    console.log('API key regenerated:', apiKey);
  } catch (error) {
    console.error('API key regeneration error:', error);
    res.status(500).json({ error: 'Error regenerating API key' });
  }
});


const normalizeArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
};

router.get('/setup', async (req, res) => {
  try {
    // Base configuration object - load this FIRST, before any checks
    let config = {
      PAPERLESS_API_URL: (process.env.PAPERLESS_API_URL || 'http://localhost:8000').replace(/\/api$/, ''),
      PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
      PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
      AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      OLLAMA_API_URL: process.env.OLLAMA_API_URL || 'http://localhost:11434',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2',
      SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
      SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
      PROCESS_PREDEFINED_DOCUMENTS: process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
      TAGS: normalizeArray(process.env.TAGS),
      ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
      AI_PROCESSED_TAG_NAME: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
      USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
      PROMPT_TAGS: normalizeArray(process.env.PROMPT_TAGS),
      PAPERLESS_AI_VERSION: configFile.PAPERLESS_AI_VERSION || ' ',
      PROCESS_ONLY_NEW_DOCUMENTS: process.env.PROCESS_ONLY_NEW_DOCUMENTS || 'yes',
      USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no'
    };

    // Check both configuration and users
    const [isEnvConfigured, users] = await Promise.all([
      setupService.isConfigured(),
      documentModel.getUsers()
    ]);

    // Load saved config if it exists
    if (isEnvConfigured) {
      const savedConfig = await setupService.loadConfig();
      if (savedConfig.PAPERLESS_API_URL) {
        savedConfig.PAPERLESS_API_URL = savedConfig.PAPERLESS_API_URL.replace(/\/api$/, '');
      }

      savedConfig.TAGS = normalizeArray(savedConfig.TAGS);
      savedConfig.PROMPT_TAGS = normalizeArray(savedConfig.PROMPT_TAGS);

      config = { ...config, ...savedConfig };
    }

    // Debug output
    console.log('Current config TAGS:', config.TAGS);
    console.log('Current config PROMPT_TAGS:', config.PROMPT_TAGS);

    // Check if system is fully configured
    const hasUsers = Array.isArray(users) && users.length > 0;
    const isFullyConfigured = isEnvConfigured && hasUsers;

    // Generate appropriate success message
    let successMessage;
    if (isEnvConfigured && !hasUsers) {
      successMessage = 'Environment is configured, but no users exist. Please create at least one user.';
    } else if (isEnvConfigured) {
      successMessage = 'The application is already configured. You can update the configuration below.';
    }

    // If everything is configured and we have users, redirect to dashboard
    // BUT only after we've loaded all the config
    if (isFullyConfigured) {
      return res.redirect('/dashboard');
    }

    // Render setup page with config and appropriate message
    res.render('setup', {
      config,
      success: successMessage
    });
  } catch (error) {
    console.error('Setup route error:', error);
    res.status(500).render('setup', {
      config: {},
      error: 'An error occurred while loading the setup page.'
    });
  }
});

router.get('/manual/preview/:id', async (req, res) => {
  try {
    const documentId = req.params.id;
    console.log('Fetching content for document:', documentId);
    
    const response = await fetch(
      `${process.env.PAPERLESS_API_URL}/documents/${documentId}/`,
      {
        headers: {
          'Authorization': `Token ${process.env.PAPERLESS_API_TOKEN}`
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch document content: ${response.status} ${response.statusText}`);
    }

    const document = await response.json();
    //map the tags to their names
    document.tags = await Promise.all(document.tags.map(async tag => {
      const tagName = await paperlessService.getTagTextFromId(tag);
      return tagName;
    }
    ));
    console.log('Document Data:', document);
    res.json({ content: document.content, title: document.title, id: document.id, tags: document.tags });
  } catch (error) {
    console.error('Content fetch error:', error);
    res.status(500).json({ error: `Error fetching document content: ${error.message}` });
  }
});


router.get('/manual', async (req, res) => {
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  res.render('manual', {
    title: 'Document Review',
    error: null,
    success: null,
    version,
    paperlessUrl: process.env.PAPERLESS_API_URL,
    paperlessToken: process.env.PAPERLESS_API_TOKEN,
    config: {}
  });
});

router.get('/manual/tags', async (req, res) => {
  const getTags = await paperlessService.getTags();
  res.json(getTags);
});

router.get('/manual/documents', async (req, res) => {
  const getDocuments = await paperlessService.getDocuments();
  res.json(getDocuments);
});

router.get('/api/correspondentsCount', async (req, res) => {
  const correspondents = await paperlessService.listCorrespondentsNames();
  res.json(correspondents);
});

router.get('/api/tagsCount', async (req, res) => {
  const tags = await paperlessService.listTagNames();
  res.json(tags);
});

router.get('/dashboard', async (req, res) => {
  const tagCount = await paperlessService.getTagCount();
  const correspondentCount = await paperlessService.getCorrespondentCount();
  const documentCount = await paperlessService.getDocumentCount();
  const processedDocumentCount = await documentModel.getProcessedDocumentsCount();
  const metrics = await documentModel.getMetrics();
  const averagePromptTokens = metrics.length > 0 ? Math.round(metrics.reduce((acc, cur) => acc + cur.promptTokens, 0) / metrics.length) : 0;
  const averageCompletionTokens = metrics.length > 0 ? Math.round(metrics.reduce((acc, cur) => acc + cur.completionTokens, 0) / metrics.length) : 0;
  const averageTotalTokens = metrics.length > 0 ? Math.round(metrics.reduce((acc, cur) => acc + cur.totalTokens, 0) / metrics.length) : 0;
  const tokensOverall = metrics.length > 0 ? metrics.reduce((acc, cur) => acc + cur.totalTokens, 0) : 0;
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  res.render('dashboard', { paperless_data: { tagCount, correspondentCount, documentCount, processedDocumentCount }, openai_data: { averagePromptTokens, averageCompletionTokens, averageTotalTokens, tokensOverall }, version });
});

router.get('/settings', async (req, res) => {
  const processSystemPrompt = (prompt) => {
    if (!prompt) return '';
    return prompt.replace(/\\n/g, '\n');
  };

  const normalizeArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').filter(Boolean).map(item => item.trim());
    return [];
  };

  let showErrorCheckSettings = false;
  const isConfigured = await setupService.isConfigured();
  if(!isConfigured && process.env.PAPERLESS_AI_INITIAL_SETUP === 'yes') {
    showErrorCheckSettings = true;
  }
  let config = {
    PAPERLESS_API_URL: (process.env.PAPERLESS_API_URL || 'http://localhost:8000').replace(/\/api$/, ''),
    PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
    PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
    AI_PROVIDER: process.env.AI_PROVIDER || 'openai',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    OLLAMA_API_URL: process.env.OLLAMA_API_URL || 'http://localhost:11434',
    OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2',
    SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
    SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
    PROCESS_PREDEFINED_DOCUMENTS: process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
    TAGS: normalizeArray(process.env.TAGS),
    ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
    AI_PROCESSED_TAG_NAME: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
    USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
    PROMPT_TAGS: normalizeArray(process.env.PROMPT_TAGS),
    PAPERLESS_AI_VERSION: configFile.PAPERLESS_AI_VERSION || ' ',
    PROCESS_ONLY_NEW_DOCUMENTS: process.env.PROCESS_ONLY_NEW_DOCUMENTS || ' ',
    USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
    CUSTOM_API_KEY: process.env.CUSTOM_API_KEY || '',
    CUSTOM_BASE_URL: process.env.CUSTOM_BASE_URL || '',
    CUSTOM_MODEL: process.env.CUSTOM_MODEL || ''
  };
  
  if (isConfigured) {
    const savedConfig = await setupService.loadConfig();
    if (savedConfig.PAPERLESS_API_URL) {
      savedConfig.PAPERLESS_API_URL = savedConfig.PAPERLESS_API_URL.replace(/\/api$/, '');
    }

    savedConfig.TAGS = normalizeArray(savedConfig.TAGS);
    savedConfig.PROMPT_TAGS = normalizeArray(savedConfig.PROMPT_TAGS);

    config = { ...config, ...savedConfig };
  }

  // Debug-output
  console.log('Current config TAGS:', config.TAGS);
  console.log('Current config PROMPT_TAGS:', config.PROMPT_TAGS);
  const version = configFile.PAPERLESS_AI_VERSION || ' ';
  res.render('settings', { 
    version,
    config,
    success: isConfigured ? 'The application is already configured. You can update the configuration below.' : undefined,
    settingsError: showErrorCheckSettings ? 'Please check your settings. Something is not working correctly.' : undefined
  });
});

router.get('/debug', async (req, res) => {
  //const isConfigured = await setupService.isConfigured();
  //if (!isConfigured) {
  //   return res.status(503).json({ 
  //     status: 'not_configured',
  //     message: 'Application setup not completed'
  //   });
  // }
  res.render('debug');
});

// router.get('/test/:correspondent', async (req, res) => {
//   //create a const for the correspondent that is base64 encoded and decode it
//   const correspondentx = Buffer.from(req.params.correspondent, 'base64').toString('ascii');
//   const correspondent = await paperlessService.searchForExistingCorrespondent(correspondentx);
//   res.send(correspondent);
// });

router.get('/debug/tags', async (req, res) => {
  const tags = await debugService.getTags();
  res.json(tags);
});

router.get('/debug/documents', async (req, res) => {
  const documents = await debugService.getDocuments();
  res.json(documents);
});

router.get('/debug/correspondents', async (req, res) => {
  const correspondents = await debugService.getCorrespondents();
  res.json(correspondents);
});

router.post('/manual/analyze', express.json(), async (req, res) => {
  try {
    const { content, existingTags, id } = req.body;
    let existingCorrespondentList = await paperlessService.listCorrespondentsNames();
    existingCorrespondentList = existingCorrespondentList.map(correspondent => correspondent.name);
    if (!content || typeof content !== 'string') {
      console.log('Invalid content received:', content);
      return res.status(400).json({ error: 'Valid content string is required' });
    }

    if (process.env.AI_PROVIDER === 'openai') {
      const analyzeDocument = await openaiService.analyzeDocument(content, existingTags, existingCorrespondentList, id || []);
      await documentModel.addOpenAIMetrics(
            id, 
            analyzeDocument.metrics.promptTokens,
            analyzeDocument.metrics.completionTokens,
            analyzeDocument.metrics.totalTokens
          )
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'ollama') {
      const analyzeDocument = await ollamaService.analyzeDocument(content, existingTags, existingCorrespondentList, id || []);
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'custom') {
      const analyzeDocument = await customService.analyzeDocument(content, existingTags, existingCorrespondentList, id || []);
      return res.json(analyzeDocument);
    } else {
      return res.status(500).json({ error: 'AI provider not configured' });
    }
  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.post('/manual/playground', express.json(), async (req, res) => {
  try {
    const { content, existingTags, prompt, documentId } = req.body;
    
    if (!content || typeof content !== 'string') {
      console.log('Invalid content received:', content);
      return res.status(400).json({ error: 'Valid content string is required' });
    }

    if (process.env.AI_PROVIDER === 'openai') {
      const analyzeDocument = await openaiService.analyzePlayground(content, prompt);
      await documentModel.addOpenAIMetrics(
        documentId, 
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      )
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'ollama') {
      const analyzeDocument = await ollamaService.analyzePlayground(content, prompt);
      return res.json(analyzeDocument);
    } else if (process.env.AI_PROVIDER === 'custom') {
      const analyzeDocument = await customService.analyzePlayground(content, prompt);
      await documentModel.addOpenAIMetrics(
        documentId, 
        analyzeDocument.metrics.promptTokens,
        analyzeDocument.metrics.completionTokens,
        analyzeDocument.metrics.totalTokens
      )
      return res.json(analyzeDocument);
    } else {
      return res.status(500).json({ error: 'AI provider not configured' });
    }
  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.post('/manual/updateDocument', express.json(), async (req, res) => {
  try {
    var { documentId, tags, correspondent, title } = req.body;
    console.log("TITLE: ", title);
    // Convert all tags to names if they are IDs
    tags = await Promise.all(tags.map(async tag => {
      console.log('Processing tag:', tag);
      if (!isNaN(tag)) {
        const tagName = await paperlessService.getTagTextFromId(Number(tag));
        console.log('Converted tag ID:', tag, 'to name:', tagName);
        return tagName;
      }
      return tag;
    }));

    // Filter out any null or undefined tags
    tags = tags.filter(tag => tag != null);

    // Process new tags to get their IDs
    const { tagIds, errors } = await paperlessService.processTags(tags);
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    // Process correspondent if provided
    const correspondentData = correspondent ? await paperlessService.getOrCreateCorrespondent(correspondent) : null;


    await paperlessService.removeUnusedTagsFromDocument(documentId, tagIds);
    
    // Then update with new tags (this will only add new ones since we already removed unused ones)
    const updateData = {
      tags: tagIds,
      correspondent: correspondentData ? correspondentData.id : null,
      title: title ? title : null
    };

    if(updateData.tags === null && updateData.correspondent === null && updateData.title === null) {
      return res.status(400).json({ error: 'No changes provided' });
    }
    const updateDocument = await paperlessService.updateDocument(documentId, updateData);
    
    // Mark document as processed
    await documentModel.addProcessedDocument(documentId, updateData.title);

    res.json(updateDocument);
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/health', async (req, res) => {
  try {
    // const isConfigured = await setupService.isConfigured();
    // if (!isConfigured) {
    //   return res.status(503).json({ 
    //     status: 'not_configured',
    //     message: 'Application setup not completed'
    //   });
    // }
    try {
      await documentModel.isDocumentProcessed(1);
    } catch (error) {
      return res.status(503).json({ 
        status: 'database_error',
        message: 'Database check failed'
      });
    }

    res.json({ status: 'healthy' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

router.post('/setup', express.json(), async (req, res) => {
  try {
      const { 
          paperlessUrl, 
          paperlessToken, 
          aiProvider,
          openaiKey,
          openaiModel,
          ollamaUrl,
          ollamaModel,
          scanInterval,
          systemPrompt,
          showTags,
          tags,
          aiProcessedTag,
          aiTagName,
          usePromptTags,
          promptTags,
          username,
          password,
          paperlessUsername,
          useExistingData,
          customApiKey,
          customBaseUrl,
          customModel
      } = req.body;

      console.log('Setup request received:', req.body);

      const normalizeArray = (value) => {
          if (!value) return [];
          if (Array.isArray(value)) return value;
          if (typeof value === 'string') return value.split(',').filter(Boolean).map(item => item.trim());
          return [];
      };

      const processedPrompt = systemPrompt 
          ? systemPrompt.replace(/\r\n/g, '\n').replace(/\n/g, '\\n')
          : '';

      // Validate Paperless config
      const isPaperlessValid = await setupService.validatePaperlessConfig(paperlessUrl, paperlessToken);
      if (!isPaperlessValid) {
          return res.status(400).json({ 
              error: 'Paperless-ngx connection failed. Please check URL and Token.'
          });
      }

      let apiToken = '';
      //generate a random secure api token
      if(process.env.API_KEY === undefined || process.env.API_KEY === null || process.env.API_KEY === '') {
        apiToken = require('crypto').randomBytes(64).toString('hex');
      }else{
        apiToken = process.env.API_KEY;
      }

      let jwtToken = '';
      //generate a random secure jwt token
      if(process.env.JWT_SECRET === undefined || process.env.JWT_SECRET === null || process.env.JWT_SECRET === '') {
        jwtToken = require('crypto').randomBytes(64).toString('hex');
      }else{
        jwtToken = process.env.JWT_SECRET;
      }      

      // Prepare base config
      const config = {
          PAPERLESS_API_URL: paperlessUrl + '/api',
          PAPERLESS_API_TOKEN: paperlessToken,
          PAPERLESS_USERNAME: paperlessUsername,
          AI_PROVIDER: aiProvider,
          SCAN_INTERVAL: scanInterval || '*/30 * * * *',
          SYSTEM_PROMPT: processedPrompt,
          PROCESS_PREDEFINED_DOCUMENTS: showTags || 'no',
          TAGS: normalizeArray(tags),
          ADD_AI_PROCESSED_TAG: aiProcessedTag || 'no',
          AI_PROCESSED_TAG_NAME: aiTagName || 'ai-processed',
          USE_PROMPT_TAGS: usePromptTags || 'no',
          PROMPT_TAGS: normalizeArray(promptTags),
          USE_EXISTING_DATA: useExistingData || 'no',
          API_KEY: apiToken,
          JWT_SECRET: jwtToken,
          CUSTOM_API_KEY: customApiKey || '',
          CUSTOM_BASE_URL: customBaseUrl || '',
          CUSTOM_MODEL: customModel || '',
          PAPERLESS_AI_INITIAL_SETUP: 'yes'
      };

      // Validate AI provider config
      if (aiProvider === 'openai') {
          const isOpenAIValid = await setupService.validateOpenAIConfig(openaiKey);
          if (!isOpenAIValid) {
              return res.status(400).json({ 
                  error: 'OpenAI API Key is not valid. Please check the key.'
              });
          }
          config.OPENAI_API_KEY = openaiKey;
          config.OPENAI_MODEL = openaiModel || 'gpt-4o-mini';
      } else if (aiProvider === 'ollama') {
          const isOllamaValid = await setupService.validateOllamaConfig(ollamaUrl, ollamaModel);
          if (!isOllamaValid) {
              return res.status(400).json({ 
                  error: 'Ollama connection failed. Please check URL and Model.'
              });
          }
          config.OLLAMA_API_URL = ollamaUrl || 'http://localhost:11434';
          config.OLLAMA_MODEL = ollamaModel || 'llama3.2';
      }else if (aiProvider === 'custom') {
        console.log('Custom AI provider selected');
          const isCustomValid = await setupService.validateCustomConfig(customBaseUrl, customApiKey, customModel);
          if (!isCustomValid) {
              return res.status(400).json({
                  error: 'Custom connection failed. Please check URL, API Key and Model.'
              });
          }
          config.CUSTOM_BASE_URL = customBaseUrl;
          config.CUSTOM_API_KEY = customApiKey;
          config.CUSTOM_MODEL = customModel;
      }
      
      // Save configuration
      await setupService.saveConfig(config);
      const hashedPassword = await bcrypt.hash(password, 15);
      await documentModel.addUser(username, hashedPassword);
      // Send success response
      res.json({ 
          success: true,
          message: 'Configuration saved successfully.',
          restart: true
      });

      // Trigger application restart
      setTimeout(() => {
          process.exit(0);
      }, 5000);

  } catch (error) {
      console.error('Setup error:', error);
      res.status(500).json({ 
          error: 'An error occurred: ' + error.message
      });
  }
});

router.post('/settings', express.json(), async (req, res) => {
  try {
    const { 
      paperlessUrl, 
      paperlessToken, 
      aiProvider,
      openaiKey,
      openaiModel,
      ollamaUrl,
      ollamaModel,
      scanInterval,
      systemPrompt,
      showTags,
      tags,
      aiProcessedTag,
      aiTagName,
      usePromptTags,
      promptTags,
      paperlessUsername,
      useExistingData,
      customApiKey,
      customBaseUrl,
      customModel
    } = req.body;

    const currentConfig = {
      PAPERLESS_API_URL: process.env.PAPERLESS_API_URL || '',
      PAPERLESS_API_TOKEN: process.env.PAPERLESS_API_TOKEN || '',
      PAPERLESS_USERNAME: process.env.PAPERLESS_USERNAME || '',
      AI_PROVIDER: process.env.AI_PROVIDER || '',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      OPENAI_MODEL: process.env.OPENAI_MODEL || '',
      OLLAMA_API_URL: process.env.OLLAMA_API_URL || '',
      OLLAMA_MODEL: process.env.OLLAMA_MODEL || '',
      SCAN_INTERVAL: process.env.SCAN_INTERVAL || '*/30 * * * *',
      SYSTEM_PROMPT: process.env.SYSTEM_PROMPT || '',
      PROCESS_PREDEFINED_DOCUMENTS: process.env.PROCESS_PREDEFINED_DOCUMENTS || 'no',
      TAGS: process.env.TAGS || '',
      ADD_AI_PROCESSED_TAG: process.env.ADD_AI_PROCESSED_TAG || 'no',
      AI_PROCESSED_TAG_NAME: process.env.AI_PROCESSED_TAG_NAME || 'ai-processed',
      USE_PROMPT_TAGS: process.env.USE_PROMPT_TAGS || 'no',
      PROMPT_TAGS: process.env.PROMPT_TAGS || '',
      USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no',
      API_KEY: process.env.API_KEY || '',
      CUSTOM_API_KEY: process.env.CUSTOM_API_KEY || '',
      CUSTOM_BASE_URL: process.env.CUSTOM_BASE_URL || '',
      CUSTOM_MODEL: process.env.CUSTOM_MODEL || ''
    };

    const normalizeArray = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') return value.split(',').filter(Boolean).map(item => item.trim());
      return [];
    };

    if (paperlessUrl !== currentConfig.PAPERLESS_API_URL?.replace('/api', '') || 
        paperlessToken !== currentConfig.PAPERLESS_API_TOKEN) {
      const isPaperlessValid = await setupService.validatePaperlessConfig(paperlessUrl, paperlessToken);
      if (!isPaperlessValid) {
        return res.status(400).json({ 
          error: 'Paperless-ngx connection failed. Please check URL and Token.'
        });
      }
    }

    const updatedConfig = {};

    if (paperlessUrl) updatedConfig.PAPERLESS_API_URL = paperlessUrl + '/api';
    if (paperlessToken) updatedConfig.PAPERLESS_API_TOKEN = paperlessToken;
    if (paperlessUsername) updatedConfig.PAPERLESS_USERNAME = paperlessUsername;

    if (aiProvider) {
      updatedConfig.AI_PROVIDER = aiProvider;
      
      if (aiProvider === 'openai' && openaiKey) {
        const isOpenAIValid = await setupService.validateOpenAIConfig(openaiKey);
        if (!isOpenAIValid) {
          return res.status(400).json({ 
            error: 'OpenAI API Key is not valid. Please check the key.'
          });
        }
        updatedConfig.OPENAI_API_KEY = openaiKey;
        if (openaiModel) updatedConfig.OPENAI_MODEL = openaiModel;
      } 
      else if (aiProvider === 'ollama' && (ollamaUrl || ollamaModel)) {
        const isOllamaValid = await setupService.validateOllamaConfig(
          ollamaUrl || currentConfig.OLLAMA_API_URL,
          ollamaModel || currentConfig.OLLAMA_MODEL
        );
        if (!isOllamaValid) {
          return res.status(400).json({ 
            error: 'Ollama connection failed. Please check URL and Model.'
          });
        }
        if (ollamaUrl) updatedConfig.OLLAMA_API_URL = ollamaUrl;
        if (ollamaModel) updatedConfig.OLLAMA_MODEL = ollamaModel;
      }
    }

    if (scanInterval) updatedConfig.SCAN_INTERVAL = scanInterval;
    if (systemPrompt) updatedConfig.SYSTEM_PROMPT = systemPrompt.replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
    if (showTags) updatedConfig.PROCESS_PREDEFINED_DOCUMENTS = showTags;
    if(tags !== undefined || tags !== null || tags !== ''){
      updatedConfig.TAGS = normalizeArray(tags);
    }else{ 
      updatedConfig.TAGS = '';
    }
    if (aiProcessedTag) updatedConfig.ADD_AI_PROCESSED_TAG = aiProcessedTag;
    if (aiTagName) updatedConfig.AI_PROCESSED_TAG_NAME = aiTagName;
    if (usePromptTags) updatedConfig.USE_PROMPT_TAGS = usePromptTags;
    if (promptTags) updatedConfig.PROMPT_TAGS = normalizeArray(promptTags);
    if (useExistingData) updatedConfig.USE_EXISTING_DATA = useExistingData;
    if (customApiKey) updatedConfig.CUSTOM_API_KEY = customApiKey;
    if (customBaseUrl) updatedConfig.CUSTOM_BASE_URL = customBaseUrl;
    if (customModel) updatedConfig.CUSTOM_MODEL = customModel;

    let apiToken = '';
    //generate a random secure api token
    if(process.env.API_KEY === undefined || process.env.API_KEY === null) {
      console.log('Generating new API key');
      apiToken = Promise.resolve(require('crypto').randomBytes(64).toString('hex'));
    }else{
      updatedConfig.API_KEY = process.env.API_KEY;
    }

    const mergedConfig = {
      ...currentConfig,
      ...updatedConfig
    };

    await setupService.saveConfig(mergedConfig);
    
    res.json({ 
      success: true,
      message: 'Configuration saved successfully.',
      restart: true
    });

    // Trigger application restart
    setTimeout(() => {
      process.exit(0);
    }, 5000);

  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ 
      error: 'An error occurred: ' + error.message
    });
  }
});

module.exports = router;
