const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs').promises;
const config = require('./config/config');
const paperlessService = require('./services/paperlessService');
const AIServiceFactory = require('./services/aiServiceFactory');
const documentModel = require('./models/document');
const SetupService = require('./services/setupService');
const setupService = new SetupService();
const setupRoutes = require('./routes/setup');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const Logger = require('./services/loggerService');
const { max } = require('date-fns');

const htmlLogger = new Logger({
  logFile: 'logs.html',
  format: 'html',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

const txtLogger = new Logger({
  logFile: 'logs.txt',
  format: 'txt',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

const app = express();
let runningTask = false;


const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'x-api-key',
    'Access-Control-Allow-Private-Network'
  ],
  credentials: false
};

app.use(cors(corsOptions));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, Access-Control-Allow-Private-Network');
  res.header('Access-Control-Allow-Private-Network', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// //Layout middleware
// app.use((req, res, next) => {
//   const originalRender = res.render;
//   res.render = function (view, locals = {}) {
//     originalRender.call(this, view, locals, (err, html) => {
//       if (err) return next(err);
//       originalRender.call(this, 'layout', { content: html, ...locals });
//     });
//   };
//   next();
// });


// Initialize data directory
async function initializeDataDirectory() {
  const dataDir = path.join(process.cwd(), 'data');
  try {
    await fs.access(dataDir);
  } catch {
    console.log('Creating data directory...');
    await fs.mkdir(dataDir, { recursive: true });
  }
}

// Document processing functions
async function processDocument(doc, existingTags, existingCorrespondentList, ownUserId) {
  const isProcessed = await documentModel.isDocumentProcessed(doc.id);
  if (isProcessed) return null;
  await documentModel.setProcessingStatus(doc.id, doc.title, 'processing');

  //Check if the Document can be edited
  const documentEditable = await paperlessService.getPermissionOfDocument(doc.id);
  if (!documentEditable) {
    console.log(`[DEBUG] Document belongs to: ${documentEditable}, skipping analysis`);
    console.log(`[DEBUG] Document ${doc.id} Not Editable by Paper-Ai User, skipping analysis`);
    return null;
  }else {
    console.log(`[DEBUG] Document ${doc.id} rights for AI User - processed`);
  }

  let [content, originalData] = await Promise.all([
    paperlessService.getDocumentContent(doc.id),
    paperlessService.getDocument(doc.id)
  ]);

  if (!content || !content.length >= 10) {
    console.log(`[DEBUG] Document ${doc.id} has no content, skipping analysis`);
    return null;
  }

  if (content.length > 50000) {
    content = content.substring(0, 50000);
  }

  const aiService = AIServiceFactory.getService();
  const analysis = await aiService.analyzeDocument(content, existingTags, existingCorrespondentList, doc.id);
  console.log('Repsonse from AI service:', analysis);
  if (analysis.error) {
    throw new Error(`[ERROR] Document analysis failed: ${analysis.error}`);
  }
  await documentModel.setProcessingStatus(doc.id, doc.title, 'complete');
  return { analysis, originalData };
}

async function buildUpdateData(analysis, doc) {
  const updateData = {};

  console.log('TEST: ', config.addAIProcessedTag)
  console.log('TEST 2: ', config.addAIProcessedTags)
  // Only process tags if tagging is activated
  if (config.limitFunctions?.activateTagging !== 'no') {
    const { tagIds, errors } = await paperlessService.processTags(analysis.document.tags);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
  } else if (config.limitFunctions?.activateTagging === 'no' && config.addAIProcessedTag === 'yes') {
    // Add AI processed tags to the document (processTags function awaits a tags array)
    // get tags from .env file and split them by comma and make an array
    console.log('[DEBUG] Tagging is deactivated but AI processed tag will be added');
    const tags = config.addAIProcessedTags.split(',');
    const { tagIds, errors } = await paperlessService.processTags(tags);
    if (errors.length > 0) {
      console.warn('[ERROR] Some tags could not be processed:', errors);
    }
    updateData.tags = tagIds;
    console.log('[DEBUG] Tagging is deactivated');
  }

  // Only process title if title generation is activated
  if (config.limitFunctions?.activateTitle !== 'no') {
    updateData.title = analysis.document.title || doc.title;
  }

  // Add created date regardless of settings as it's a core field
  updateData.created = analysis.document.document_date || doc.created;

  // Only process document type if document type classification is activated
  if (config.limitFunctions?.activateDocumentType !== 'no' && analysis.document.document_type) {
    try {
      const documentType = await paperlessService.getOrCreateDocumentType(analysis.document.document_type);
      if (documentType) {
        updateData.document_type = documentType.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing document type:`, error);
    }
  }
  
  // Only process custom fields if custom fields detection is activated
  if (config.limitFunctions?.activateCustomFields !== 'no' && analysis.document.custom_fields) {
    const customFields = analysis.document.custom_fields;
    const processedFields = [];

    // Get existing custom fields
    const existingFields = await paperlessService.getExistingCustomFields(doc.id);
    console.log(`[DEBUG] Found existing fields:`, existingFields);

    // Keep track of which fields we've processed to avoid duplicates
    const processedFieldIds = new Set();

    // First, add any new/updated fields
    for (const key in customFields) {
      const customField = customFields[key];
      
      if (!customField.field_name || !customField.value?.trim()) {
        console.log(`[DEBUG] Skipping empty/invalid custom field`);
        continue;
      }

      const fieldDetails = await paperlessService.findExistingCustomField(customField.field_name);
      if (fieldDetails?.id) {
        processedFields.push({
          field: fieldDetails.id,
          value: customField.value.trim()
        });
        processedFieldIds.add(fieldDetails.id);
      }
    }

    // Then add any existing fields that weren't updated
    for (const existingField of existingFields) {
      if (!processedFieldIds.has(existingField.field)) {
        processedFields.push(existingField);
      }
    }

    if (processedFields.length > 0) {
      updateData.custom_fields = processedFields;
    }
  }

  // Only process correspondent if correspondent detection is activated
  if (config.limitFunctions?.activateCorrespondents !== 'no' && analysis.document.correspondent) {
    try {
      const correspondent = await paperlessService.getOrCreateCorrespondent(analysis.document.correspondent);
      if (correspondent) {
        updateData.correspondent = correspondent.id;
      }
    } catch (error) {
      console.error(`[ERROR] Error processing correspondent:`, error);
    }
  }

  // Always include language if provided as it's a core field
  if (analysis.document.language) {
    updateData.language = analysis.document.language;
  }

  return updateData;
}

async function saveDocumentChanges(docId, updateData, analysis, originalData) {
  const { tags: originalTags, correspondent: originalCorrespondent, title: originalTitle } = originalData;
  
  await Promise.all([
    documentModel.saveOriginalData(docId, originalTags, originalCorrespondent, originalTitle),
    paperlessService.updateDocument(docId, updateData),
    documentModel.addProcessedDocument(docId, updateData.title),
    documentModel.addOpenAIMetrics(
      docId, 
      analysis.metrics.promptTokens,
      analysis.metrics.completionTokens,
      analysis.metrics.totalTokens
    ),
    documentModel.addToHistory(docId, updateData.tags, updateData.title, analysis.document.correspondent)
  ]);
}

// Main scanning functions
async function scanInitial() {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log('[ERROR] Setup not completed. Skipping document scan.');
      return;
    }

    let [existingTags, documents, ownUserId, existingCorrespondentList] = await Promise.all([
      paperlessService.getTags(),
      paperlessService.getAllDocuments(),
      paperlessService.getOwnUserID(),
      paperlessService.listCorrespondentsNames()
    ]);
    //get existing correspondent list
    existingCorrespondentList = existingCorrespondentList.map(correspondent => correspondent.name);

    for (const doc of documents) {
      try {
        const result = await processDocument(doc, existingTags, existingCorrespondentList, ownUserId);
        if (!result) continue;

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
      } catch (error) {
        console.error(`[ERROR] processing document ${doc.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[ERROR] during initial document scan:', error);
  }
}

async function scanDocuments() {
  if (runningTask) {
    console.log('[DEBUG] Task already running');
    return;
  }

  runningTask = true;
  try {
    let [existingTags, documents, ownUserId, existingCorrespondentList] = await Promise.all([
      paperlessService.getTags(),
      paperlessService.getAllDocuments(),
      paperlessService.getOwnUserID(),
      paperlessService.listCorrespondentsNames()
    ]);

    //get existing correspondent list
    existingCorrespondentList = existingCorrespondentList.map(correspondent => correspondent.name);

    for (const doc of documents) {
      try {
        const result = await processDocument(doc, existingTags, existingCorrespondentList, ownUserId);
        if (!result) continue;

        const { analysis, originalData } = result;
        const updateData = await buildUpdateData(analysis, doc);
        await saveDocumentChanges(doc.id, updateData, analysis, originalData);
      } catch (error) {
        console.error(`[ERROR] processing document ${doc.id}:`, error);
      }
    }
  } catch (error) {
    console.error('[ERROR]  during document scan:', error);
  } finally {
    runningTask = false;
    console.log('[INFO] Task completed');
  }
}

// Routes
app.use('/', setupRoutes);

app.get('/', async (req, res) => {
  try {
    res.redirect('/dashboard');
  } catch (error) {
    console.error('[ERROR] in root route:', error);
    res.status(500).send('Error processing request');
  }
});

app.get('/health', async (req, res) => {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      return res.status(503).json({ 
        status: 'not_configured',
        message: 'Application setup not completed'
      });
    }

    await documentModel.isDocumentProcessed(1);
    res.json({ status: 'healthy' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start scanning
async function startScanning() {
  try {
    const isConfigured = await setupService.isConfigured();
    if (!isConfigured) {
      console.log('Setup not completed. Visit http://your-ip-or-host.com:3000/setup to complete setup.');
      return;
    }

    const userId = await paperlessService.getOwnUserID();
    if (!userId) {
      console.error('Failed to get own user ID. Abort scanning.');
      return;
    }

    console.log('Configured scan interval:', config.scanInterval);
    console.log(`Starting initial scan at ${new Date().toISOString()}`);
    if(config.disableAutomaticProcessing != 'yes') {
      await scanInitial();
  
      cron.schedule(config.scanInterval, async () => {
        console.log(`Starting scheduled scan at ${new Date().toISOString()}`);
        await scanDocuments();
      });
    }
  } catch (error) {
    console.error('[ERROR] in startScanning:', error);
  }
}

// Error handlers
// process.on('SIGTERM', async () => {
//   console.log('Received SIGTERM. Starting graceful shutdown...');
//   try {
//     console.log('Closing database...');
//     await documentModel.closeDatabase(); // Jetzt warten wir wirklich auf den Close
//     console.log('Database closed successfully');
//     process.exit(0);
//   } catch (error) {
//     console.error('[ERROR] during shutdown:', error);
//     process.exit(1);
//   }
// });

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

async function gracefulShutdown(signal) {
  console.log(`[DEBUG] Received ${signal} signal. Starting graceful shutdown...`);
  try {
    console.log('[DEBUG] Closing database...');
    await documentModel.closeDatabase();
    console.log('[DEBUG] Database closed successfully');
    process.exit(0);
  } catch (error) {
    console.error(`[ERROR] during ${signal} shutdown:`, error);
    process.exit(1);
  }
}

// Handle both SIGTERM and SIGINT
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
async function startServer() {
  try {
    await initializeDataDirectory();
    app.listen(3000, () => {
      console.log('Server running on port 3000');
      startScanning();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();