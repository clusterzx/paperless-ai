const express = require('express');
const router = express.Router();
const setupService = require('../services/setupService.js');
const paperlessService = require('../services/paperlessService.js');
const AIServiceFactory = require('../services/aiServiceFactory.js');
const documentModel = require('../models/document.js');
const debugService = require('../services/debugService.js');
const configFile = require('../config/config.js');
const ChatService = require('../services/chatService.js');
const documentsService = require('../services/documentsService.js');
const fs = require('fs').promises;
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Routes that don't require authentication
let PUBLIC_ROUTES = [
  '/health',
  '/login',
  '/logout',
  '/setup'
];

// Combined middleware to check authentication and setup
router.use(async (req, res, next) => {
  // Check if route is public
  if (PUBLIC_ROUTES.some(route => req.path.startsWith(route))) {
    return next();
  }

  // First check authentication
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch {
    res.clearCookie('jwt');
    return res.redirect('/login');
  }

  // Then check if setup is completed
  const isConfigured = await setupService.isConfigured();
  if (!isConfigured && !req.path.startsWith('/setup')) {
    return res.redirect('/setup');
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
  const cachePath = path.join('./public/images', `${req.params.documentId}.png`);

  try {
    // Prüfe ob das Bild bereits im Cache existiert
    try {
      await fs.access(cachePath);
      console.log('Serving cached thumbnail');
      
      // Wenn ja, sende direkt das gecachte Bild
      res.setHeader('Content-Type', 'image/png');
      return res.sendFile(path.resolve(cachePath));
      
    } catch (err) {
      // File existiert nicht im Cache, hole es von Paperless
      console.log('Thumbnail not cached, fetching from Paperless');
      
      const thumbnailData = await paperlessService.getThumbnailImage(req.params.documentId);
      
      if (!thumbnailData) {
        return res.status(404).send('Thumbnail nicht gefunden');
      }

      // Speichere im Cache
      await fs.mkdir(path.dirname(cachePath), { recursive: true }); // Erstelle Verzeichnis falls nicht existiert
      await fs.writeFile(cachePath, thumbnailData);

      // Sende das Bild
      res.setHeader('Content-Type', 'image/png');
      res.send(thumbnailData);
    }

  } catch (error) {
    console.error('Fehler beim Abrufen des Thumbnails:', error);
    res.status(500).send('Fehler beim Laden des Thumbnails');
  }
});

// Hauptseite mit Dokumentenliste
router.get('/chat', async (req, res) => {
  try {
      const documents = await paperlessService.getDocuments();
      res.render('chat', { documents });
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
  const { documentId, message } = req.body;
  const response = await ChatService.sendMessage(documentId, message);
  res.json(response);
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
    // Get all documents and tags
    const historyDocuments = await documentModel.getAllHistory();
    const allTags = await paperlessService.getTags();

    // Create a map of tag IDs to tag objects for quick lookup
    const tagMap = new Map(allTags.map(tag => [tag.id, tag]));

    // Format documents with resolved tags
    const actual = historyDocuments.map(doc => {
      // Parse tag IDs and map them to full tag objects
      const tagIds = doc.tags === '[]' ? [] : JSON.parse(doc.tags || '[]');
      const resolvedTags = tagIds.map(id => tagMap.get(parseInt(id))).filter(Boolean);
      const baseURL = process.env.PAPERLESS_API_URL.replace(/\/api$/, '');
      const hotlink = `${baseURL}/documents/${doc.document_id}/`;
      return {
        document_id: doc.document_id,
        title: doc.title || 'Modified: Invalid Date',
        created_at: doc.created_at,
        tags: resolvedTags, // Now contains full tag objects instead of just IDs
        correspondent: doc.correspondent || 'Not assigned',
        link: hotlink
      };
    });

    // Get unique correspondents
    const allCorrespondents = [...new Set(actual.map(doc => doc.correspondent))].filter(Boolean).sort();

    // Calculate pagination values
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const totalDocuments = actual.length;
    const totalPages = Math.ceil(totalDocuments / limit);

    // Get paginated subset of documents
    const paginatedDocuments = actual.slice(offset, offset + limit);

    // Render the page
    res.render('history', {
      version: configFile.PAPERLESS_AI_VERSION,
      actual: paginatedDocuments,
      filters: {
        allTags: allTags,
        allCorrespondents: allCorrespondents
      },
      pagination: {
        current: page,
        pages: totalPages,
        limit: limit,
        total: totalDocuments
      }
    });

  } catch (error) {
    console.error('[ERROR] loading documents:', error);
    res.status(500).send('Error loading documents');
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

  const isConfigured = await setupService.isConfigured();
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
    USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no'
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
    success: isConfigured ? 'The application is already configured. You can update the configuration below.' : undefined
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

    if (process.env.AI_PROVIDER){
      const service = AIServiceFactory.getServiceForProvider(process.env.AI_PROVIDER);
      const analyzeDocument = await service.analyzeDocument(content, existingTags, existingCorrespondentList, id || []);
      if (analyzeDocument?.metrics?.promptTokens){
        await documentModel.addOpenAIMetrics(
          id, 
          analyzeDocument.metrics.promptTokens,
          analyzeDocument.metrics.completionTokens,
          analyzeDocument.metrics.totalTokens
        )
      }
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

    if (process.env.AI_PROVIDER){
      const service = AIServiceFactory.getServiceForProvider(process.env.AI_PROVIDER);
      const analyzeDocument = await service.analyzePlayground(content, prompt);

      if (analyzeDocument?.metrics?.promptTokens){
        await documentModel.addOpenAIMetrics(
          documentId, 
          analyzeDocument.metrics.promptTokens,
          analyzeDocument.metrics.completionTokens,
          analyzeDocument.metrics.totalTokens
        )
      }
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
          geminiKey,
          geminiModel,
          useExistingData
      } = req.body;

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
          USE_EXISTING_DATA: useExistingData || 'no'
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
      } else if (aiProvider === 'gemini') {
          const isGeminiValid = await setupService.validateGeminiConfig(geminiKey);
          if (!isGeminiValid) {
            return res.status(400).json({
                error: 'Gemini Key is not valid. Please check the key.'
            });
          }
          config.GEMINI_API_KEY = geminiKey;
          config.GEMINI_MODEL = geminiModel || 'gemini-1.5-flash';    
      } else if (aiProvider === 'ollama') {
          const isOllamaValid = await setupService.validateOllamaConfig(ollamaUrl, ollamaModel);
          if (!isOllamaValid) {
              return res.status(400).json({ 
                  error: 'Ollama connection failed. Please check URL and Model.'
              });
          }
          config.OLLAMA_API_URL = ollamaUrl || 'http://localhost:11434';
          config.OLLAMA_MODEL = ollamaModel || 'llama3.2';
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
        geminiKey,
        geminiModel,
        useExistingData
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
      USE_EXISTING_DATA: process.env.USE_EXISTING_DATA || 'no'
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
      else if (aiProvider === 'gemini' && geminiKey){
        const isGeminiValid = await setupService.validateGeminiConfig(geminiKey || currentConfig.GEMINI_API_KEY);
        if (!isGeminiValid) {
          return res.status(400).json({
              error: 'Gemini Key is not valid. Please check the key.'
          });
        }
        updatedConfig.GEMINI_API_KEY = geminiKey || currentConfig.GEMINI_API_KEY;
        updatedConfig.GEMINI_MODEL = geminiModel || currentConfig.GEMINI_MODEL;
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
