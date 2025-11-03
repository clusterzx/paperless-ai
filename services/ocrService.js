const axios = require('axios');
const FormData = require('form-data');
const paperlessService = require('./paperlessService');
const ocrProcessingModel = require('../models/ocrProcessing');
const EventEmitter = require('events');
const Logger = require('./loggerService');

const logger = new Logger({
  logFile: 'ocr-service.log',
  format: 'txt',
  timestamp: true,
  maxFileSize: 1024 * 1024 * 10
});

class OCRService extends EventEmitter {
  constructor() {
    super();
    // Support both development (localhost:8123) and production (ocr-container:8123) environments
    this.ocrBaseUrl = process.env.OCR_SERVICE_URL || 'http://localhost:8123';
    this.processingQueue = new Map();
    this.currentProcessing = null;
    this.isProcessing = false;
    this.totalDocuments = 0;
    this.processedDocuments = 0;
    this.successfulDocuments = 0;
    this.errors = [];
    this.startTime = null;
    this.shouldStop = false;
    this.currentRequest = null; // Track current axios request for cancellation
    
    // OCR Configuration (can be overridden via environment variables)
    this.ocrConfig = {
      cleanText: process.env.OCR_CLEAN_TEXT === 'false' ? 'false' : 'true',
      minConfidence: process.env.OCR_MIN_CONFIDENCE || '0.4',
      preserveLayout: process.env.OCR_PRESERVE_LAYOUT === 'false' ? 'false' : 'true',
      includeConfidence: 'true',
      includeBboxes: 'true',
      forceOcr: 'false'
    };
    
    console.log(`OCR Service initialized with URL: ${this.ocrBaseUrl}`);
    console.log('OCR Configuration:', this.ocrConfig);
  }

  /**
   * Process a single document through OCR
   * @param {number} documentId - The document ID from Paperless-NGX
   * @returns {Promise<Object>} Result object with success status and details
   */
  async processDocument(documentId) {
    const startTime = Date.now();
    
    try {
      console.log(`Starting OCR processing for document ${documentId}`);
      
      // 1. Get document details from Paperless-NGX
      const documentDetails = await paperlessService.getDocumentForOCR(documentId);
      if (!documentDetails) {
        throw new Error(`Document ${documentId} not found in Paperless-NGX`);
      }

      // 2. Record processing start in database
      ocrProcessingModel.recordProcessingStart(documentId, documentDetails.title);

      // 3. Download document file from Paperless-NGX
      const documentBuffer = await paperlessService.downloadOriginalDocument(documentId);
      if (!documentBuffer) {
        throw new Error(`Failed to download document ${documentId}`);
      }

      // 4. Prepare form data for OCR service
      const formData = new FormData();
      const filename = `document_${documentId}.${this.getFileExtension(documentDetails.file_type)}`;
      formData.append('file', documentBuffer, {
        filename: filename,
        contentType: this.getContentType(documentDetails.file_type)
      });
      
      // Add OCR service parameters using configuration
      formData.append('clean_text', this.ocrConfig.cleanText);
      formData.append('min_confidence', this.ocrConfig.minConfidence);
      formData.append('preserve_layout', this.ocrConfig.preserveLayout);
      formData.append('include_confidence', this.ocrConfig.includeConfidence);
      formData.append('include_bboxes', this.ocrConfig.includeBboxes);
      formData.append('force_ocr', this.ocrConfig.forceOcr);

      // 5. Send to OCR service (using correct v2.0.0 endpoint)
      console.log(`Sending document ${documentId} to OCR service`);
      
      // Create cancellation token
      const cancelToken = axios.CancelToken.source();
      this.currentRequest = cancelToken;
      
      // Check if stop was requested before making the request
      if (this.shouldStop) {
        throw new Error('Processing stopped by user request');
      }
      
      const ocrResponse = await axios.post(`${this.ocrBaseUrl}/ocr/extract`, formData, {
        headers: {
          ...formData.getHeaders(),
          'Accept': 'application/json'
        },
        timeout: 300000, // 5 minutes timeout for OCR processing
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        cancelToken: cancelToken.token
      });

      // Clear current request after successful completion
      this.currentRequest = null;
      
      // 6. Log raw OCR response for debugging
      console.log('Raw OCR response:', JSON.stringify(ocrResponse.data, null, 2));
      
      // 6. Extract text from OCR response
      const extractionResult = this.extractTextFromOCR(ocrResponse.data);
      
      if (!extractionResult.text || extractionResult.text.trim().length === 0) {
        throw new Error('No text extracted from OCR response');
      }

      // 7. Update document content in Paperless-NGX
      await paperlessService.updateDocumentContent(documentId, extractionResult.text);

      const processingTime = Date.now() - startTime;
      const originalLength = documentDetails.content ? documentDetails.content.length : 0;

      // 8. Record successful processing in database (including markdown text)
      const enrichedOcrResponse = {
        ...ocrResponse.data,
        processing_info: {
          ...ocrResponse.data.processing_info,
          structured_text: extractionResult.text,
          markdown_text: extractionResult.markdown,
          has_markdown: extractionResult.hasMarkdown
        }
      };
      
      ocrProcessingModel.recordProcessingSuccess(
        documentId,
        documentDetails.title,
        originalLength,
        extractionResult.text.length,
        processingTime,
        enrichedOcrResponse
      );

      console.log(`Successfully processed document ${documentId}, extracted ${extractionResult.text.length} characters`);
      
      return {
        success: true,
        documentId,
        documentTitle: documentDetails.title,
        extractedText: extractionResult.text,
        markdownText: extractionResult.markdown,
        hasMarkdown: extractionResult.hasMarkdown,
        textLength: extractionResult.text.length,
        originalLength,
        processingTime,
        wasAlreadyProcessed: false
      };
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      // Clear current request on error
      this.currentRequest = null;
      
      // Handle axios cancellation gracefully
      if (axios.isCancel(error)) {
        console.log(`Processing document ${documentId} was cancelled`);
        // Don't treat cancellation as a processing error
        return {
          success: false,
          documentId,
          error: 'Processing stopped by user request',
          processingTime,
          wasCancelled: true,
          wasAlreadyProcessed: false
        };
      }
      
      // Enhanced error handling for v2.0.0 API responses
      let errorMessage = error.message;
      if (error.response && error.response.data) {
        const responseData = error.response.data;
        
        // Handle v2.0.0 API error responses
        if (responseData.detail) {
          errorMessage = responseData.detail;
        } else if (responseData.error) {
          errorMessage = responseData.error;
        }
        
        // Log specific HTTP status code errors
        switch (error.response.status) {
          case 400:
            console.error(`Bad request for document ${documentId}: ${errorMessage}`);
            errorMessage = `Unsupported file format or invalid request: ${errorMessage}`;
            break;
          case 500:
            console.error(`OCR server error for document ${documentId}: ${errorMessage}`);
            errorMessage = `OCR processing failed: ${errorMessage}`;
            break;
          default:
            console.error(`HTTP ${error.response.status} error for document ${documentId}: ${errorMessage}`);
        }
      }
      
      console.error(`Error processing document ${documentId}: ${errorMessage}`);
      
      // Get document title for error recording
      let documentTitle = `Document ${documentId}`;
      try {
        const documentDetails = await paperlessService.getDocumentForOCR(documentId);
        documentTitle = documentDetails?.title || documentTitle;
      } catch (titleError) {
        // Ignore title fetch errors
      }

      // Record failed processing in database
      ocrProcessingModel.recordProcessingFailure(
        documentId,
        documentTitle,
        errorMessage,
        processingTime
      );
      
      const errorDetails = {
        documentId,
        error: errorMessage,
        timestamp: new Date(),
        stack: error.stack,
        httpStatus: error.response?.status
      };
      
      this.errors.push(errorDetails);
      
      return {
        success: false,
        documentId,
        documentTitle,
        error: errorMessage,
        timestamp: new Date(),
        processingTime
      };
    }
  }

  /**
   * Filter out already processed documents from a list
   * @param {Array<number>} documentIds - Array of document IDs to filter
   * @returns {Array<number>} Array of document IDs that haven't been processed
   */
  filterUnprocessedDocuments(documentIds) {
    if (!documentIds || documentIds.length === 0) {
      return [];
    }

    const unprocessedIds = documentIds.filter(id => !ocrProcessingModel.isDocumentProcessed(id));
    
    const processedCount = documentIds.length - unprocessedIds.length;
    if (processedCount > 0) {
      console.log(`Filtered out ${processedCount} already processed documents`);
    }

    return unprocessedIds;
  }

  /**
   * Start batch processing of multiple documents
   * @param {Array<number>} documentIds - Array of document IDs to process
   * @param {boolean} skipProcessed - Whether to skip already processed documents (default: true)
   */
  async startBatchProcessing(documentIds, skipProcessed = true) {
    if (this.isProcessing) {
      throw new Error('Processing already in progress');
    }

    if (!documentIds || documentIds.length === 0) {
      throw new Error('No documents provided for processing');
    }

    // Filter out already processed documents if requested
    const originalCount = documentIds.length;
    const docsToProcess = skipProcessed ? this.filterUnprocessedDocuments(documentIds) : documentIds;
    
    if (docsToProcess.length === 0) {
      console.log('All documents have already been processed');
      this.emit('processingCompleted', {
        totalDocuments: originalCount,
        processedDocuments: 0,
        successfulDocuments: 0,
        failedDocuments: 0,
        skippedDocuments: originalCount,
        errors: [],
        startTime: new Date(),
        endTime: new Date(),
        duration: 0
      });
      return;
    }

    console.log(`Starting batch OCR processing for ${docsToProcess.length} documents (${originalCount - docsToProcess.length} already processed)`);
    
    // Generate session ID for tracking
    const sessionId = `ocr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.isProcessing = true;
    this.shouldStop = false;
    this.totalDocuments = docsToProcess.length;
    this.processedDocuments = 0;
    this.successfulDocuments = 0;
    this.errors = [];
    this.startTime = new Date();
    
    // Start processing session in database
    ocrProcessingModel.startProcessingSession(sessionId, this.totalDocuments);
    
    this.emit('processingStarted', {
      totalDocuments: this.totalDocuments,
      skippedDocuments: originalCount - docsToProcess.length,
      sessionId,
      timestamp: this.startTime
    });

    try {
      for (let i = 0; i < docsToProcess.length; i++) {
        if (this.shouldStop) {
          console.log('Processing stopped by user request');
          break;
        }

        const documentId = docsToProcess[i];
        this.currentProcessing = {
          documentId,
          index: i + 1,
          total: docsToProcess.length
        };

        this.emit('documentStarted', {
          documentId,
          documentIndex: i + 1,
          totalDocuments: docsToProcess.length
        });

        const result = await this.processDocument(documentId);
        
        this.processedDocuments++;
        if (result.success) {
          this.successfulDocuments++;
        }
        
        // If document was cancelled, break the loop
        if (result.wasCancelled) {
          console.log('Document processing was cancelled, stopping batch');
          break;
        }

        const progress = (this.processedDocuments / this.totalDocuments) * 100;
        
        // Update session in database
        ocrProcessingModel.updateProcessingSession(
          sessionId,
          this.successfulDocuments,
          this.processedDocuments - this.successfulDocuments,
          'running'
        );
        
        this.emit('documentCompleted', {
          ...result,
          progress,
          processedDocuments: this.processedDocuments,
          totalDocuments: this.totalDocuments,
          successfulDocuments: this.successfulDocuments,
          failedDocuments: this.processedDocuments - this.successfulDocuments
        });

        // Small delay to prevent overwhelming the OCR service
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const completedData = {
        totalDocuments: this.totalDocuments,
        processedDocuments: this.processedDocuments,
        successfulDocuments: this.successfulDocuments,
        failedDocuments: this.processedDocuments - this.successfulDocuments,
        skippedDocuments: originalCount - docsToProcess.length,
        errors: this.errors,
        startTime: this.startTime,
        endTime: new Date(),
        duration: Date.now() - this.startTime.getTime(),
        sessionId
      };

      // Update session as completed
      ocrProcessingModel.updateProcessingSession(
        sessionId,
        this.successfulDocuments,
        this.processedDocuments - this.successfulDocuments,
        this.shouldStop ? 'stopped' : 'completed'
      );

      console.log(`Batch processing completed: ${this.successfulDocuments}/${this.processedDocuments} documents successful`);
      
      this.emit('processingCompleted', completedData);
      
    } catch (error) {
      console.error(`Batch processing failed: ${error.message}`);
      
      // Update session as failed
      ocrProcessingModel.updateProcessingSession(
        sessionId,
        this.successfulDocuments,
        this.processedDocuments - this.successfulDocuments,
        'failed'
      );
      
      this.emit('processingError', {
        error: error.message,
        timestamp: new Date(),
        sessionId
      });
    } finally {
      this.isProcessing = false;
      this.currentProcessing = null;
      this.currentRequest = null;
      this.shouldStop = false;
    }
  }

  /**
   * Stop the current processing
   */
  stopProcessing() {
    if (!this.isProcessing) {
      return false;
    }

    console.log('Stopping OCR processing');
    this.shouldStop = true;
    
    // Cancel current request if it exists
    if (this.currentRequest) {
      console.log('Cancelling current OCR request');
      this.currentRequest.cancel('Processing stopped by user request');
      this.currentRequest = null;
    }
    
    const stoppedData = {
      processedDocuments: this.processedDocuments,
      totalDocuments: this.totalDocuments,
      successfulDocuments: this.successfulDocuments,
      timestamp: new Date()
    };
    
    this.emit('processingStopped', stoppedData);
    
    return true;
  }

  /**
   * Get current processing status
   * @returns {Object} Current status
   */
  getStatus() {
    const now = new Date();
    let estimatedCompletion = null;
    
    if (this.isProcessing && this.processedDocuments > 0) {
      const elapsed = now.getTime() - this.startTime.getTime();
      const avgTimePerDoc = elapsed / this.processedDocuments;
      const remainingDocs = this.totalDocuments - this.processedDocuments;
      estimatedCompletion = new Date(now.getTime() + (remainingDocs * avgTimePerDoc));
    }

    return {
      isProcessing: this.isProcessing,
      currentProcessing: this.currentProcessing,
      totalDocuments: this.totalDocuments,
      processedDocuments: this.processedDocuments,
      successfulDocuments: this.successfulDocuments,
      failedDocuments: this.processedDocuments - this.successfulDocuments,
      progress: this.totalDocuments > 0 ? (this.processedDocuments / this.totalDocuments) * 100 : 0,
      errors: this.errors,
      startTime: this.startTime,
      estimatedCompletion,
      shouldStop: this.shouldStop
    };
  }

  /**
   * Test OCR service availability (Updated for v2.0.0 API)
   * @returns {Promise<boolean>} True if service is available
   */
  async testOCRService() {
    try {
      const response = await axios.get(`${this.ocrBaseUrl}/health`, {
        timeout: 5000
      });
      
      if (response.status === 200 && response.data) {
        // Check v2.0.0 API health response format
        const healthData = response.data;
        console.log('OCR service health check:', {
          status: healthData.status,
          predictors_loaded: healthData.predictors_loaded,
          supported_formats: healthData.supported_formats,
          surya_version: healthData.surya_version
        });
        
        // Service is available if status is healthy and predictors are loaded
        return healthData.status === 'healthy';
      }
      
      return false;
    } catch (error) {
      console.error(`OCR service health check failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Extract text from OCR response (Updated for v2.0.0 API)
   * @param {Object} ocrResponse - OCR service response
   * @returns {Object} Object containing text, markdown, and hasMarkdown properties
   */
  extractTextFromOCR(ocrResponse) {
    if (!ocrResponse) {
      throw new Error('Invalid OCR response - no response data');
    }
    
    // Validate response structure according to v2.0.0 API
    if (!ocrResponse.success) {
      throw new Error('OCR service returned failure response');
    }
    
    let extractedText = '';
    let markdownText = '';
    let hasMarkdown = false;
    
    // Handle v2.0.0 API response format with clean text support
    if (ocrResponse.full_text) {
      extractedText = ocrResponse.full_text;
      
      // Check if we have clean_text (formatted) output
      if (ocrResponse.clean_text) {
        extractedText = ocrResponse.clean_text;
        markdownText = ocrResponse.clean_text; // Clean text is already formatted
        hasMarkdown = true; // Clean text has better formatting
        console.log('Using clean formatted text from OCR response');
      } else {
        markdownText = ocrResponse.full_text;
      }
      
      // Check if we have additional page-level data
      if (ocrResponse.pages && Array.isArray(ocrResponse.pages)) {
        // Log extraction method and quality info for debugging
        console.log(`OCR extraction method: ${ocrResponse.extraction_method || 'unknown'}`);
        console.log(`Total pages processed: ${ocrResponse.total_pages || ocrResponse.pages.length}`);
        
        if (ocrResponse.processing_info) {
          console.log('OCR processing info:', {
            confidence_threshold: ocrResponse.processing_info.confidence_threshold,
            layout_preserved: ocrResponse.processing_info.layout_preserved,
            clean_text_enabled: ocrResponse.processing_info.clean_text_enabled
          });
        }
      }
    }
    // Handle pages array if full_text is not available (fallback)
    else if (ocrResponse.pages && Array.isArray(ocrResponse.pages)) {
      extractedText = ocrResponse.pages
        .map(page => page.text)
        .filter(text => text && text.trim())
        .join('\n\n');
      markdownText = extractedText;
      
      console.log(`Extracted text from ${ocrResponse.pages.length} pages using pages array`);
    }
    // Legacy format support (keep for backward compatibility)
    else if (ocrResponse.structured_text) {
      extractedText = ocrResponse.structured_text;
      markdownText = ocrResponse.markdown_text || ocrResponse.structured_text;
      hasMarkdown = !!ocrResponse.markdown_text;
    }
    // Additional legacy support
    else if (ocrResponse.full_document_text) {
      extractedText = ocrResponse.full_document_text;
      markdownText = extractedText;
    }
    else {
      throw new Error('Invalid OCR response format - missing text content. Expected v2.0.0 API format with success=true and full_text or pages array.');
    }
    
    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error('No text extracted from OCR response');
    }
    
    return {
      text: extractedText.trim(),
      markdown: markdownText.trim(),
      hasMarkdown: hasMarkdown
    };
  }

  /**
   * Get file extension based on file type
   * @param {string} fileType - File type from Paperless-NGX
   * @returns {string} File extension
   */
  getFileExtension(fileType) {
    const extensions = {
      'application/pdf': 'pdf',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/tiff': 'tiff',
      'image/bmp': 'bmp',
      'image/gif': 'gif'
    };
    
    return extensions[fileType] || 'pdf';
  }

  /**
   * Get content type based on file type
   * @param {string} fileType - File type from Paperless-NGX
   * @returns {string} Content type
   */
  getContentType(fileType) {
    return fileType || 'application/pdf';
  }

  /**
   * Get processing statistics
   * @returns {Object} Processing statistics
   */
  getStatistics() {
    const dbStats = ocrProcessingModel.getProcessingStatistics();
    
    return {
      // Current session stats
      currentSession: {
        totalProcessed: this.processedDocuments,
        successful: this.successfulDocuments,
        failed: this.errors.length,
        successRate: this.processedDocuments > 0 ? (this.successfulDocuments / this.processedDocuments) * 100 : 0,
        errors: this.errors.map(error => ({
          documentId: error.documentId,
          error: error.error,
          timestamp: error.timestamp
        }))
      },
      // Overall database stats
      overall: dbStats
    };
  }

  /**
   * Get documents that have been successfully processed
   * @returns {number[]} Array of processed document IDs
   */
  getProcessedDocumentIds() {
    return ocrProcessingModel.getProcessedDocumentIds();
  }

  /**
   * Get processed document text and metadata
   * @param {number} documentId - Document ID
   * @returns {Object|null} Processing data or null if not found
   */
  getProcessedDocumentText(documentId) {
    const history = ocrProcessingModel.getDocumentProcessingHistory(documentId);
    
    // Find the most recent successful processing
    const successfulProcessing = history.find(record => record.status === 'success');
    if (!successfulProcessing) {
      return null;
    }
    
    // Try to parse the OCR service response to get both text types
    let extractedText = 'No text available';
    let markdownText = null;
    
    try {
      if (successfulProcessing.ocr_service_response) {
        const ocrResponse = JSON.parse(successfulProcessing.ocr_service_response);
        
        // Check if it's stored as processing info from our new format
        if (ocrResponse.processing_info && ocrResponse.processing_info.structured_text) {
          extractedText = ocrResponse.processing_info.structured_text;
          markdownText = ocrResponse.processing_info.markdown_text;
        }
        // Handle Python server response format
        else if (ocrResponse.full_text) {
          extractedText = ocrResponse.full_text;
          markdownText = ocrResponse.full_text;
        }
        // Handle pages array format
        else if (ocrResponse.pages && Array.isArray(ocrResponse.pages)) {
          extractedText = ocrResponse.pages
            .map(page => page.text)
            .filter(text => text && text.trim())
            .join('\n\n');
          markdownText = extractedText;
        }
        // Fallback to original OCR response format
        else if (ocrResponse.structured_text) {
          extractedText = ocrResponse.structured_text;
          markdownText = ocrResponse.markdown_text;
        }
        // Legacy format fallback
        else if (ocrResponse.full_document_text) {
          extractedText = ocrResponse.full_document_text;
        }
        // If we still don't have text, show a placeholder that indicates text is available but not cached
        if (extractedText === 'No text available' && successfulProcessing.extracted_content_length > 0) {
          console.log('No text found in OCR response, showing placeholder for document', documentId);
          extractedText = `[Text available - ${successfulProcessing.extracted_content_length} characters extracted]

This document was processed with an older version of the OCR system that didn't store the full text.
To see the extracted text, please reprocess this document with the updated OCR service.`;
        }
      }
    } catch (error) {
      console.error('Error parsing OCR response for text:', error);
    }
    
    return {
      document_id: documentId,
      document_title: successfulProcessing.document_title,
      extracted_text: extractedText,
      markdown_text: markdownText,
      processing_date: successfulProcessing.processing_date,
      processing_time_ms: successfulProcessing.processing_time_ms,
      original_content_length: successfulProcessing.original_content_length,
      extracted_content_length: successfulProcessing.extracted_content_length
    };
  }

  /**
   * Check if a document has been processed
   * @param {number} documentId - Document ID to check
   * @returns {boolean} True if document has been processed
   */
  isDocumentProcessed(documentId) {
    return ocrProcessingModel.isDocumentProcessed(documentId);
  }

  /**
   * Get processing history for a document
   * @param {number} documentId - Document ID
   * @returns {Object[]} Processing history
   */
  getDocumentProcessingHistory(documentId) {
    return ocrProcessingModel.getDocumentProcessingHistory(documentId);
  }

  /**
   * Get recent processing history
   * @param {number} limit - Number of records to retrieve
   * @returns {Object[]} Recent processing history
   */
  getRecentProcessingHistory(limit = 50) {
    return ocrProcessingModel.getRecentProcessingHistory(limit);
  }

  /**
   * Reset processing status for a document
   * @param {number} documentId - Document ID to reset
   */
  resetDocumentProcessing(documentId) {
    ocrProcessingModel.resetDocumentProcessing(documentId);
  }

  /**
   * Reset all processing history
   */
  resetAllProcessing() {
    ocrProcessingModel.resetAllProcessing();
  }
}

module.exports = new OCRService();