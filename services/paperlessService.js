// services/paperlessService.js
const axios = require('axios');
const config = require('../config/config');
const fs = require('fs');
const path = require('path');
const { parse, isValid, parseISO, format } = require('date-fns');

class PaperlessService {
  constructor() {
    this.client = null;
    this.tagCache = new Map();
    this.customFieldCache = new Map();
    this.lastTagRefresh = 0;
    this.CACHE_LIFETIME = 3000; // 3 Sekunden
  }

  initialize() {
    if (!this.client && config.paperless.apiUrl && config.paperless.apiToken) {
      this.client = axios.create({
        baseURL: config.paperless.apiUrl,
        headers: {
          'Authorization': `Token ${config.paperless.apiToken}`,
          'Content-Type': 'application/json'
        }
      });
    }
  }

  async getThumbnailImage(documentId) {
    this.initialize();
    try { 
      const response = await this.client.get(`/documents/${documentId}/thumb/`, {
        responseType: 'arraybuffer'
      });

      if (response.data && response.data.byteLength > 0) {      
        return Buffer.from(response.data);
      }
      
      console.warn(`[DEBUG] No thumbnail data for document ${documentId}`);
      return null;
    } catch (error) {
      console.error(`[ERROR] fetching thumbnail for document ${documentId}:`, error.message);
      if (error.response) {
        console.log('[ERROR] status:', error.response.status);
        console.log('[ERROR] headers:', error.response.headers);
      }
      return null; // Behalten Sie das return null bei, damit der Prozess weiterlaufen kann
    }
  }


  // Aktualisiert den Tag-Cache, wenn er älter als CACHE_LIFETIME ist
  async ensureTagCache() {
    const now = Date.now();
    if (this.tagCache.size === 0 || (now - this.lastTagRefresh) > this.CACHE_LIFETIME) {
      await this.refreshTagCache();
    }
  }

  // Lädt alle existierenden Tags
  async refreshTagCache() {
    try {
      console.log('[DEBUG] Refreshing tag cache...');
      this.tagCache.clear();
      let nextUrl = '/tags/';
      while (nextUrl) {
        const response = await this.client.get(nextUrl);
        response.data.results.forEach(tag => {
          this.tagCache.set(tag.name.toLowerCase(), tag);
        });
        nextUrl = response.data.next;
      }
      this.lastTagRefresh = Date.now();
      console.log(`[DEBUG] Tag cache refreshed. Found ${this.tagCache.size} tags.`);
    } catch (error) {
      console.error('[ERROR] refreshing tag cache:', error.message);
      throw error;
    }
  }

  async initializeWithCredentials(apiUrl, apiToken) {
    this.client = axios.create({
      baseURL: apiUrl,
      headers: {
        'Authorization': `Token ${apiToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    // Test the connection
    try {
      await this.client.get('/');
      return true;
    } catch (error) {
      console.error('[ERROR] Failed to initialize with credentials:', error.message);
      this.client = null;
      return false;
    }
  }

  async createCustomFieldSafely(fieldName, fieldType, default_currency) {
    try {
      // Try to create the field first
      const response = await this.client.post('/custom_fields/', { 
        name: fieldName,
        data_type: fieldType,
        extra_data: {
          default_currency: default_currency || null
        }
      });
      const newField = response.data;
      console.log(`[DEBUG] Successfully created custom field "${fieldName}" with ID ${newField.id}`);
      this.customFieldCache.set(fieldName.toLowerCase(), newField);
      return newField;
    } catch (error) { 
      if (error.response?.status === 400) {
        await this.refreshCustomFieldCache();
        const existingField = await this.findExistingCustomField(fieldName);
        if (existingField) {
          return existingField;
        }
      }
      throw error; // When couldn't find the field, rethrow the error
    }
  }

  async getExistingCustomFields(documentId) {
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      console.log('[DEBUG] Document response custom fields:', response.data.custom_fields);
      return response.data.custom_fields || [];
    } catch (error) {
      console.error(`[ERROR] fetching document ${documentId}:`, error.message);
      return [];
    }
  }
  
  async findExistingCustomField(fieldName) {
    const normalizedName = fieldName.toLowerCase();
    
    const cachedField = this.customFieldCache.get(normalizedName);
    if (cachedField) {
      console.log(`[DEBUG] Found custom field "${fieldName}" in cache with ID ${cachedField.id}`);
      return cachedField;
    }

    try {
      const response = await this.client.get('/custom_fields/', {
        params: {
          name__iexact: normalizedName  // Case-insensitive exact match
        }
      });

      if (response.data.results.length > 0) {
        const foundField = response.data.results[0];
        console.log(`[DEBUG] Found existing custom field "${fieldName}" via API with ID ${foundField.id}`);
        this.customFieldCache.set(normalizedName, foundField);
        return foundField;
      }
    } catch (error) {
      console.warn(`[ERROR] searching for custom field "${fieldName}":`, error.message);
    }

    return null;
  }

  async refreshCustomFieldCache() {
    try {
      console.log('[DEBUG] Refreshing custom field cache...');
      this.customFieldCache.clear();
      let nextUrl = '/custom_fields/';
      while (nextUrl) {
        const response = await this.client.get(nextUrl);
        response.data.results.forEach(field => {
          this.customFieldCache.set(field.name.toLowerCase(), field);
        });
        nextUrl = response.data.next;
      }
      this.lastCustomFieldRefresh = Date.now();
      console.log(`[DEBUG] Custom field cache refreshed. Found ${this.customFieldCache.size} fields.`);
    } catch (error) {
      console.error('[ERROR] refreshing custom field cache:', error.message);
      throw error;
    }
  }


  async findExistingTag(tagName) {
    const normalizedName = tagName.toLowerCase();
    
    // 1. Zuerst im Cache suchen
    const cachedTag = this.tagCache.get(normalizedName);
    if (cachedTag) {
      console.log(`[DEBUG] Found tag "${tagName}" in cache with ID ${cachedTag.id}`);
      return cachedTag;
    }

    // 2. Direkte API-Suche
    try {
      const response = await this.client.get('/tags/', {
        params: {
          name__iexact: normalizedName  // Case-insensitive exact match
        }
      });

      if (response.data.results.length > 0) {
        const foundTag = response.data.results[0];
        console.log(`[DEBUG] Found existing tag "${tagName}" via API with ID ${foundTag.id}`);
        this.tagCache.set(normalizedName, foundTag);
        return foundTag;
      }
    } catch (error) {
      console.warn(`[ERROR] searching for tag "${tagName}":`, error.message);
    }

    return null;
  }

  async createTagSafely(tagName) {
    const normalizedName = tagName.toLowerCase();
    
    try {
      // Versuche zuerst, den Tag zu erstellen
      const response = await this.client.post('/tags/', { name: tagName });
      const newTag = response.data;
      console.log(`[DEBUG] Successfully created tag "${tagName}" with ID ${newTag.id}`);
      this.tagCache.set(normalizedName, newTag);
      return newTag;
    } catch (error) {
      if (error.response?.status === 400) {
        // Bei einem 400er Fehler könnte der Tag bereits existieren
        // Aktualisiere den Cache und suche erneut
        await this.refreshTagCache();
        
        // Suche nochmal nach dem Tag
        const existingTag = await this.findExistingTag(tagName);
        if (existingTag) {
          return existingTag;
        }
      }
      throw error; // Wenn wir den Tag nicht finden konnten, werfen wir den Fehler weiter
    }
  }

  async processTags(tagNames, options = {}) {
    try {
      this.initialize();
      await this.ensureTagCache();
      
      // Check if we should restrict to existing tags
      // Explicitly check options first, then env var
      const restrictToExistingTags = options.restrictToExistingTags === true || 
                                   (options.restrictToExistingTags === undefined && 
                                    process.env.RESTRICT_TO_EXISTING_TAGS === 'yes');
      
      // Input validation
      if (!tagNames) {
        console.warn('[DEBUG] No tags provided to processTags');
        return { tagIds: [], errors: [] };
      }

      // Convert to array if string is passed
      const tagsArray = typeof tagNames === 'string' 
        ? [tagNames]
        : Array.isArray(tagNames) 
          ? tagNames 
          : [];

      if (tagsArray.length === 0) {
        console.warn('[DEBUG] No valid tags to process');
        return { tagIds: [], errors: [] };
      }
  
      const tagIds = [];
      const errors = [];
      const processedTags = new Set(); // Prevent duplicates
      
      console.log(`[DEBUG] Processing tags with restrictToExistingTags=${restrictToExistingTags}`);
  
      // Process regular tags
      for (const tagName of tagsArray) {
        if (!tagName || typeof tagName !== 'string') {
          console.warn(`[DEBUG] Skipping invalid tag name: ${tagName}`);
          errors.push({ tagName, error: 'Invalid tag name' });
          continue;
        }
  
        const normalizedName = tagName.toLowerCase().trim();
        
        // Skip empty or already processed tags
        if (!normalizedName || processedTags.has(normalizedName)) {
          continue;
        }
  
        try {
          // Search for existing tag first
          let tag = await this.findExistingTag(tagName);
          
          // If no existing tag found and restrictions are not enabled, create new one
          if (!tag && !restrictToExistingTags) {
            tag = await this.createTagSafely(tagName);
          } else if (!tag && restrictToExistingTags) {
            console.log(`[DEBUG] Tag "${tagName}" does not exist and restrictions are enabled, skipping`);
            errors.push({ tagName, error: 'Tag does not exist and restrictions are enabled' });
            continue;
          }
  
          if (tag && tag.id) {
            tagIds.push(tag.id);
            processedTags.add(normalizedName);
          }
  
        } catch (error) {
          console.error(`[ERROR] processing tag "${tagName}":`, error.message);
          errors.push({ tagName, error: error.message });
        }
      }
  
      // Add AI-Processed tag if enabled
      if (process.env.ADD_AI_PROCESSED_TAG === 'yes' && process.env.AI_PROCESSED_TAG_NAME) {
        try {
          const aiTagName = process.env.AI_PROCESSED_TAG_NAME;
          let aiTag = await this.findExistingTag(aiTagName);
          
          if (!aiTag) {
            aiTag = await this.createTagSafely(aiTagName);
          }
  
          if (aiTag && aiTag.id) {
            tagIds.push(aiTag.id);
          }
        } catch (error) {
          console.error(`[ERROR] processing AI tag "${process.env.AI_PROCESSED_TAG_NAME}":`, error.message);
          errors.push({ tagName: process.env.AI_PROCESSED_TAG_NAME, error: error.message });
        }
      }
  
      return { 
        tagIds: [...new Set(tagIds)], // Remove any duplicates
        errors 
      };      
    } catch (error) {
      console.error('[ERROR] in processTags:', error);
      throw new Error(`[ERROR] Failed to process tags: ${error.message}`);
    }
  }

  async getTags() {
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    let tags = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const params = {
          page,
          page_size: 100,  // Maximale Seitengröße für effizientes Laden
          ordering: 'name'  // Optional: Sortierung nach Namen
        };

        const response = await this.client.get('/tags/', { params });
        
        if (!response?.data?.results || !Array.isArray(response.data.results)) {
          console.error(`[DEBUG] Invalid API response on page ${page}`);
          break;
        }

        tags = tags.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `[DEBUG] Fetched page ${page-1}, got ${response.data.results.length} tags. ` +
          `[DEBUG] Total so far: ${tags.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`[ERRRO] fetching tags page ${page}:`, error.message);
        if (error.response) {
          console.error('[DEBUG] Response status:', error.response.status);
          console.error('[DEBUG] Response data:', error.response.data);
        }
        break;
      }
    }

    return tags;
  }

  async getTagCount() {
    this.initialize();
    try {
      const response = await this.client.get('/tags/', {
        params: { count: true }
      });
      return response.data.count;
    } catch (error) {
      console.error('[ERROR] fetching tag count:', error.message);
      return 0;
    }
  }

  async getCorrespondentCount() {
    this.initialize();
    try {
      const response = await this.client.get('/correspondents/', {
        params: { count: true }
      });
      return response.data.count;
    } catch (error) {
      console.error('[ERROR] fetching correspondent count:', error.message);
      return 0;
    }
  }

  async getDocumentCount() {
    this.initialize();
    try {
      const response = await this.client.get('/documents/', {
        params: { count: true }
      });
      return response.data.count;
    } catch (error) {
      console.error('[ERROR] fetching document count:', error.message);
      return 0;
    }
  }

  async listCorrespondentsNames() {
    this.initialize();
    let allCorrespondents = [];
    let page = 1;
    let hasNextPage = true;
  
    try {
      while (hasNextPage) {
        const response = await this.client.get('/correspondents/', {
          params: {
            fields: 'id,name',
            count: true,
            page: page
          }
        });
  
        const { results, next } = response.data;
        
        // Füge die Ergebnisse der aktuellen Seite hinzu
        allCorrespondents = allCorrespondents.concat(
          results.map(correspondent => ({
            name: correspondent.name,
            id: correspondent.id,
            document_count: correspondent.document_count
          }))
        );
  
        // Prüfe, ob es eine nächste Seite gibt
        hasNextPage = next !== null;
        page++;
  
        // Optional: Füge eine kleine Verzögerung hinzu, um die API nicht zu überlasten
        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
  
      return allCorrespondents;
  
    } catch (error) {
      console.error('[ERROR] fetching correspondent names:', error.message);
      return [];
    }
  }

  async listDocumentTypesNames() {
    this.initialize();
    let allDocumentTypes = [];
    let page = 1;
    let hasNextPage = true;
  
    try {
      while (hasNextPage) {
        const response = await this.client.get('/document_types/', {
          params: {
            fields: 'id,name',
            count: true,
            page: page
          }
        });
  
        const { results, next } = response.data;
        
        allDocumentTypes = allDocumentTypes.concat(
          results.map(docType => ({
            name: docType.name,
            id: docType.id
          }))
        );
  
        hasNextPage = next !== null;
        page++;
  
        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
  
      return allDocumentTypes;
  
    } catch (error) {
      console.error('[ERROR] fetching document type names:', error.message);
      return [];
    }
  }

  async listTagNames() {
    this.initialize();
    let allTags = [];
    let currentPage = 1;
    let hasMorePages = true;
  
    try {
      while (hasMorePages) {
        const response = await this.client.get('/tags/', {
          params: {
            fields: 'name',
            count: true,
            page: currentPage,
            page_size: 100 // Sie können die Seitengröße nach Bedarf anpassen
          }
        });
  
        // Füge die Tags dieser Seite zum Gesamtergebnis hinzu
        allTags = allTags.concat(
          response.data.results.map(tag => ({
            name: tag.name,
            document_count: tag.document_count
          }))
        );
  
        // Prüfe, ob es weitere Seiten gibt
        hasMorePages = response.data.next !== null;
        currentPage++;
      }
  
      return allTags;
    } catch (error) {
      console.error('[DEBUG] Error fetching tag names:', error.message);
      return [];
    }
  }
  
  async getAllDocuments() {
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    let documents = [];
    let page = 1;
    let hasMore = true;
    const shouldFilterByTags = process.env.PROCESS_PREDEFINED_DOCUMENTS === 'yes';
    let tagIds = [];

    // Vorverarbeitung der Tags, wenn Filter aktiv ist
    if (shouldFilterByTags) {
      if (!process.env.TAGS) {
        console.warn('[DEBUG] PROCESS_PREDEFINED_DOCUMENTS is set to yes but no TAGS are defined');
        return [];
      }
      
      // Hole die Tag-IDs für die definierten Tags
      const tagNames = process.env.TAGS.split(',').map(tag => tag.trim());
      await this.ensureTagCache();
      
      for (const tagName of tagNames) {
        const tag = await this.findExistingTag(tagName);
        if (tag) {
          tagIds.push(tag.id);
        }
      }
      
      if (tagIds.length === 0) {
        console.warn('[DEBUG] None of the specified tags were found');
        return [];
      }
      
      console.log('[DEBUG] Filtering documents for tag IDs:', tagIds);
    }

    while (hasMore) {
      try {
        const params = {
          page,
          page_size: 100,
          fields: 'id,title,created,created_date,added,tags,correspondent'
        };

        // Füge Tag-Filter hinzu, wenn Tags definiert sind
        if (shouldFilterByTags && tagIds.length > 0) {
          // Füge jeden Tag-ID als separaten Parameter hinzu
          tagIds.forEach(id => {
            // Verwende tags__id__in für multiple Tag-Filterung
            params.tags__id__in = tagIds.join(',');
          });
        }

        const response = await this.client.get('/documents/', { params });
        
        if (!response?.data?.results || !Array.isArray(response.data.results)) {
          console.error(`[DEBUG] Invalid API response on page ${page}`);
          break;
        }

        documents = documents.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `[DEBUG] Fetched page ${page-1}, got ${response.data.results.length} documents. ` +
          `[DEBUG] Total so far: ${documents.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`[ERROR]  fetching documents page ${page}:`, error.message);
        if (error.response) {
          console.error('[ERROR] Response status:', error.response.status);
        }
        break;
      }
    }

    console.log(`[DEBUG] Finished fetching. Found ${documents.length} documents.`);
    return documents;
}

  async getAllDocumentIds() {
    /**
     * Get all Document IDs from the Paperless API.
     * 
     * @returns    An array of all Document IDs.
     * @throws     An error if the request fails.
     * @note       This method is used to get all Document IDs for further processing.
     */
    this.initialize();
    try {
      const response = await this.client.get('/documents/', {
        params: { 
          page,
          page_size: 100,
          fields: 'id',
        }
      });
      return response.data.results.map(doc => doc.id);
    } catch (error) {
      console.error('[ERROR] fetching document IDs:', error.message);
      return [];
    }
  }

  async getAllDocumentIdsScan() {
    /**
     * Get all Document IDs from the Paperless API.
     * 
     * @returns    An array of all Document IDs.
     * @throws     An error if the request fails.
     * @note       This method is used to get all Document IDs for further processing.
     */
    this.initialize();
    if (!this.client) {
      console.error('[DEBUG] Client not initialized');
      return [];
    }

    let documents = [];
    let page = 1;
    let hasMore = true;
    const shouldFilterByTags = process.env.PROCESS_PREDEFINED_DOCUMENTS === 'yes';
    let tagIds = [];

    // Vorverarbeitung der Tags, wenn Filter aktiv ist
    if (shouldFilterByTags) {
      if (!process.env.TAGS) {
        console.warn('[DEBUG] PROCESS_PREDEFINED_DOCUMENTS is set to yes but no TAGS are defined');
        return [];
      }
      
      // Hole die Tag-IDs für die definierten Tags
      const tagNames = process.env.TAGS.split(',').map(tag => tag.trim());
      await this.ensureTagCache();
      
      for (const tagName of tagNames) {
        const tag = await this.findExistingTag(tagName);
        if (tag) {
          tagIds.push(tag.id);
        }
      }
      
      if (tagIds.length === 0) {
        console.warn('[DEBUG] None of the specified tags were found');
        return [];
      }
      
      console.log('[DEBUG] Filtering documents for tag IDs:', tagIds);
    }

    while (hasMore) {
      try {
        const params = {
          page,
          page_size: 100,
          fields: 'id'
        };

        const response = await this.client.get('/documents/', { params });
        
        if (!response?.data?.results || !Array.isArray(response.data.results)) {
          console.error(`[ERROR] Invalid API response on page ${page}`);
          break;
        }

        documents = documents.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `[DEBUG] Fetched page ${page-1}, got ${response.data.results.length} documents. ` +
          `[DEBUG] Total so far: ${documents.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`[ERROR] fetching documents page ${page}:`, error.message);
        if (error.response) {
          console.error('[DEBUG] Response status:', error.response.status);
        }
        break;
      }
    }

    console.log(`[DEBUG] Finished fetching. Found ${documents.length} documents.`);
    return documents;
  }

  async getCorrespondentNameById(correspondentId) {
    /**
     * Get the Name of a Correspondent by its ID.
     * 
     * @param   id  The id of the correspondent.
     * @returns    The name of the correspondent.
     */
    this.initialize();
    try {
      const response = await this.client.get(`/correspondents/${correspondentId}/`);
      return response.data;
    } catch (error) {
      console.error(`[ERROR] fetching correspondent ${correspondentId}:`, error.message);
      return null;
    }
  }
  
  async getTagNameById(tagId) {
    /**
     * Get the Name of a Tag by its ID.
     *
     * @param   id  The id of the tag.
     * @returns    The name of the tag.
     */
    this.initialize();
    try {
      const response = await this.client.get(`/tags/${tagId}/`);
      return response.data.name;
    } catch (error) {
      console.error(`[ERROR] fetching tag name for ID ${tagId}:`, error.message);
      return null;
    }
  }

  async getDocumentsWithTitleTagsCorrespondentCreated () {
    /**
     * Get all documents with metadata (title, tags, correspondent, created date).
     * 
     * @returns    An array of documents with metadata.
     * @throws     An error if the request fails.
     * @note       This method is used to get all documents with metadata for further processing 
     */
    
    this.initialize();
    try {
      const response = await this.client.get('/documents/', {
        params: {
          fields: 'id,title,tags,correspondent,created'
        }
      });
      return response.data.results;
    } catch (error) {
      console.error('[ERROR] fetching documents with metadata:', error.message);
      return [];
    }
  }

  async getDocumentsForRAGService () {
    /**
     * Get all documents with metadata (title, tags, correspondent, created date and content).
     * 
     * @returns    An array of documents with metadata.
     * @throws     An error if the request fails.
     * @note       This method is used to get all documents with metadata for further processing 
     */
    
    this.initialize();
    try {
      let response;
      let page = 1;
      let hasMore = true;
  
      while (hasMore) {
        try {
          const params = {
            params: { fields: 'id,title,tags,correspondent,created,content' },
            page,
            page_size: 100,  // Maximale Seitengröße für effizientes Laden
            ordering: 'name'  // Optional: Sortierung nach Namen
          };

          response = await this.client.get('/documents/', { params });

          if (!response?.data?.results || !Array.isArray(response.data.results)) {
            console.error(`[DEBUG] Invalid API response on page ${page}`);
            break;
          }

          hasMore = response.data.next !== null;
          page++;
        
        } catch (error) {
          console.error(`[ERROR] fetching documents page ${page}:`, error.message);
          if (error.response) {
            console.error('[ERROR] Response status:', error.response.status);
          }
          break;
        }
      }  
      return response.data.results;
    } catch (error) {
      console.error('[ERROR] fetching documents with metadata:', error.message);
      return [];
    }
  }


  // Aktualisierte getDocuments Methode
  async getDocuments() {
    return this.getAllDocuments();
  }

  async getDocumentContent(documentId) {
    this.initialize();
    const response = await this.client.get(`/documents/${documentId}/`);
    return response.data.content;
  }

  async getDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data;
    } catch (error) {
      console.error(`[ERROR] fetching document ${documentId}:`, error.message);
      throw error;
    }
  }

  async searchForCorrespondentById(id) {
    try {
      const response = await this.client.get('/correspondents/', {
          params: {
              id: id
          }
      });

      const results = response.data.results;
      
      if (results.length === 0) {
          console.log(`[DEBUG] No correspondent with "${id}" found`);
          return null;
      }
      
      if (results.length > 1) {
          console.log(`[DEBUG] Multiple correspondents found:`);
          results.forEach(c => {
              console.log(`- ID: ${c.id}, Name: ${c.name}`);
          });
          return results;
      }

      // Genau ein Ergebnis gefunden
      return {
          id: results[0].id,
          name: results[0].name
      };

  } catch (error) {
      console.error('[ERROR] while seraching for existing correspondent:', error.message);
      throw error;
  }
}

async searchForExistingCorrespondent(correspondent) {
  try {
      const response = await this.client.get('/correspondents/', {
          params: {
              name__icontains: correspondent
          }
      });

      const results = response.data.results;
      
      if (results.length === 0) {
          console.log(`[DEBUG] No correspondent with name "${correspondent}" found`);
          return null;
      }
      
      // Check for exact match in the results - thanks to @skius for the hint!
      const exactMatch = results.find(c => c.name.toLowerCase() === correspondent.toLowerCase());
      if (exactMatch) {
          console.log(`[DEBUG] Found exact match for correspondent "${correspondent}" with ID ${exactMatch.id}`);
          return {
              id: exactMatch.id,
              name: exactMatch.name
          };
      }

      // No exact match found, return null
      console.log(`[DEBUG] No exact match found for "${correspondent}"`);
      return null;

  } catch (error) {
      console.error('[ERROR] while searching for existing correspondent:', error.message);
      throw error;
  }
}

  async getOrCreateCorrespondent(name, options = {}) {
    this.initialize();
    
    // Check if we should restrict to existing correspondents
    // Explicitly check options first, then env var
    const restrictToExistingCorrespondents = options.restrictToExistingCorrespondents === true || 
                                           (options.restrictToExistingCorrespondents === undefined && 
                                            process.env.RESTRICT_TO_EXISTING_CORRESPONDENTS === 'yes');
    
    console.log(`[DEBUG] Processing correspondent with restrictToExistingCorrespondents=${restrictToExistingCorrespondents}`);
  
    try {
        // Search for the correspondent
        const existingCorrespondent = await this.searchForExistingCorrespondent(name);
        console.log("[DEBUG] Response Correspondent Search: ", existingCorrespondent);
    
        if (existingCorrespondent) {
            console.log(`[DEBUG] Found existing correspondent "${name}" with ID ${existingCorrespondent.id}`);
            return existingCorrespondent;
        }
        
        // If we're restricting to existing correspondents and none was found, return null
        if (restrictToExistingCorrespondents) {
            console.log(`[DEBUG] Correspondent "${name}" does not exist and restrictions are enabled, returning null`);
            return null;
        }
    
        // Create new correspondent only if restrictions are not enabled
        try {
            const createResponse = await this.client.post('/correspondents/', { 
                name: name 
            });
            console.log(`[DEBUG] Created new correspondent "${name}" with ID ${createResponse.data.id}`);
            return createResponse.data;
        } catch (createError) {
            if (createError.response?.status === 400 && 
                createError.response?.data?.error?.includes('unique constraint')) {
              
                // Race condition check - another process might have created it
                const retryResponse = await this.client.get('/correspondents/', {
                    params: { name: name }
                });
              
                const justCreatedCorrespondent = retryResponse.data.results.find(
                    c => c.name.toLowerCase() === name.toLowerCase()
                );
              
                if (justCreatedCorrespondent) {
                    console.log(`[DEBUG] Retrieved correspondent "${name}" after constraint error with ID ${justCreatedCorrespondent.id}`);
                    return justCreatedCorrespondent;
                }
            }
            throw createError;
        }
    } catch (error) {
        console.error(`[ERROR] Failed to process correspondent "${name}":`, error.message);
        throw error;
    }
}

async searchForExistingDocumentType(documentType) {
  try {
      const response = await this.client.get('/document_types/', {
          params: {
              name__icontains: documentType
          }
      });

      const results = response.data.results;
      
      if (results.length === 0) {
          console.log(`[DEBUG] No document type with name "${documentType}" found`);
          return null;
      }
      
      // Check for exact match in the results
      const exactMatch = results.find(dt => dt.name.toLowerCase() === documentType.toLowerCase());
      if (exactMatch) {
          console.log(`[DEBUG] Found exact match for document type "${documentType}" with ID ${exactMatch.id}`);
          return {
              id: exactMatch.id,
              name: exactMatch.name
          };
      }

      // No exact match found, return null
      console.log(`[DEBUG] No exact match found for "${documentType}"`);
      return null;

  } catch (error) {
      console.error('[ERROR] while searching for existing document type:', error.message);
      throw error;
  }
}

async getOrCreateDocumentType(name) {
  this.initialize();
  
  try {
      // Suche nach existierendem document_type
      const existingDocType = await this.searchForExistingDocumentType(name);
      console.log("[DEBUG] Response Document Type Search: ", existingDocType);
  
      if (existingDocType) {
          console.log(`[DEBUG] Found existing document type "${name}" with ID ${existingDocType.id}`);
          return existingDocType;
      }
  
      // Erstelle neuen document_type
      try {
          const createResponse = await this.client.post('/document_types/', { 
              name: name,
              matching_algorithm: 1, // 1 = ANY
              match: "",  // Optional: Kann später angepasst werden
              is_insensitive: true
          });
          console.log(`[DEBUG] Created new document type "${name}" with ID ${createResponse.data.id}`);
          return createResponse.data;
      } catch (createError) {
          if (createError.response?.status === 400 && 
              createError.response?.data?.error?.includes('unique constraint')) {
            
              // Race condition check
              const retryResponse = await this.client.get('/document_types/', {
                  params: { name: name }
              });
            
              const justCreatedDocType = retryResponse.data.results.find(
                  dt => dt.name.toLowerCase() === name.toLowerCase()
              );
            
              if (justCreatedDocType) {
                  console.log(`[DEBUG] Retrieved document type "${name}" after constraint error with ID ${justCreatedDocType.id}`);
                  return justCreatedDocType;
              }
          }
          throw createError;
      }
  } catch (error) {
      console.error(`[ERROR] Failed to process document type "${name}":`, error.message);
      throw error;
  }
}

  async removeUnusedTagsFromDocument(documentId, keepTagIds) {
    this.initialize();
    if (!this.client) return;
  
    try {
      console.log(`[DEBUG] Removing unused tags from document ${documentId}, keeping tags:`, keepTagIds);
      
      // Hole aktuelles Dokument
      const currentDoc = await this.getDocument(documentId);
      
      // Finde Tags die entfernt werden sollen (die nicht in keepTagIds sind)
      const tagsToRemove = currentDoc.tags.filter(tagId => !keepTagIds.includes(tagId));
      
      if (tagsToRemove.length === 0) {
        console.log('[DEBUG] No tags to remove');
        return currentDoc;
      }
  
      // Update das Dokument mit nur den zu behaltenden Tags
      const updateData = {
        tags: keepTagIds
      };
  
      // Führe das Update durch
      await this.client.patch(`/documents/${documentId}/`, updateData);
      console.log(`[DEBUG] Successfully removed ${tagsToRemove.length} tags from document ${documentId}`);
      
      return await this.getDocument(documentId);
    } catch (error) {
      console.error(`[ERROR] Error removing unused tags from document ${documentId}:`, error.message);
      throw error;
    }
  }

  async getTagTextFromId(tagId) {
    this.initialize();
    try {
      const response = await this.client.get(`/tags/${tagId}/`);
      return response.data.name;
    } catch (error) {
      console.error(`[ERROR] fetching tag text for ID ${tagId}:`, error.message);
      return null;
    }
  }

  async getOwnUserID() {
    this.initialize();
    try {
        const response = await this.client.get('/users/', {
            params: {
                current_user: true,
                full_perms: true
            }
        });
        
        if (response.data.results && response.data.results.length > 0) {
            const userInfo = response.data.results;
            //filter for username by process.env.PAPERLESS_USERNAME
            const user = userInfo.find(user => user.username === process.env.PAPERLESS_USERNAME);
            if (user) {
                console.log(`[DEBUG] Found own user ID: ${user.id}`);
                return user.id;
            }
        }
        return null;
    } catch (error) {
        console.error('[ERROR] fetching own user ID:', error.message);
        return null;
    }
}
  //Remove if not needed?
  async getOwnerOfDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data.owner;
    } catch (error) {
      console.error(`[ERROR] fetching owner of document ${documentId}:`, error.message);
      return null;
    }
  }

  // Checks if the document is accessable by the current user
  async getPermissionOfDocument(documentId) {
    this.initialize();
    try {
      const response = await this.client.get(`/documents/${documentId}/`);
      return response.data.user_can_change;
    } catch (error) {
      console.error(`[ERROR] No Permission to edit document ${documentId}:`, error.message);
      return null;
    }
  }


  async updateDocument(documentId, updates) {
    this.initialize();
    if (!this.client) return;
    try {
      const currentDoc = await this.getDocument(documentId);
      
      if (updates.tags) {
        console.log(`[DEBUG] Current tags for document ${documentId}:`, currentDoc.tags);
        console.log(`[DEBUG] Adding new tags:`, updates.tags);
        console.log(`[DEBUG] Current correspondent:`, currentDoc.correspondent);
        console.log(`[DEBUG] New correspondent:`, updates.correspondent);
                
        const combinedTags = [...new Set([...currentDoc.tags, ...updates.tags])];
        updates.tags = combinedTags;
        
        console.log(`[DEBUG] Combined tags:`, combinedTags);
      }

      // Always preserve existing correspondent to satisfy required field validation
      // This maintains backward compatibility where existing correspondents are not overwritten
      if (currentDoc.correspondent) {
        if (updates.correspondent) {
          console.log('[DEBUG] Document already has a correspondent, keeping existing one:', currentDoc.correspondent);
        } else {
          console.log('[DEBUG] Preserving existing correspondent in PATCH payload:', currentDoc.correspondent);
        }
        updates.correspondent = currentDoc.correspondent;
      }

      // Always include storage_path in the PATCH payload to satisfy required field validation
      if (currentDoc.storage_path && !updates.storage_path) {
        console.log('[DEBUG] Preserving existing storage_path in PATCH payload:', currentDoc.storage_path);
        updates.storage_path = currentDoc.storage_path;
      }

      let updateData;
      try {
        if (updates.created) {
          let dateObject;
          
          dateObject = parseISO(updates.created);
          
          if (!isValid(dateObject)) {
            dateObject = parse(updates.created, 'dd.MM.yyyy', new Date());
            if (!isValid(dateObject)) {
              dateObject = parse(updates.created, 'dd-MM-yyyy', new Date());
            }
          }
          
          if (!isValid(dateObject)) {
            console.warn(`[WARN] Invalid date format: ${updates.created}, using fallback date: 01.01.1990`);
            dateObject = new Date(1990, 0, 1);
          }
      
          updateData = {
            ...updates,
            created: format(dateObject, 'yyyy-MM-dd'),
          };
        } else {
          updateData = { ...updates };
        }
      } catch (error) {
        console.warn('[WARN] Error parsing date:', error.message);
        console.warn('[DEBUG] Received Date:', updates);
        updateData = {
          ...updates,
          created: format(new Date(1990, 0, 1), 'yyyy-MM-dd'),
        };
      }

      // Truncate custom field STRING values to 128 characters max
      if (updateData.custom_fields && Array.isArray(updateData.custom_fields)) {
        console.log('[DEBUG] Validating custom fields length');
        for (const customField of updateData.custom_fields) {
          if (customField.value && typeof customField.value === 'string' && customField.value.length > 128) {
            const originalLength = customField.value.length;
            customField.value = customField.value.substring(0, 128);
            console.warn(`[WARN] Custom field value truncated from ${originalLength} to 128 characters for document ${documentId}`);
          }
        }
      }
      
      // Validate title length before sending to API
      if (updateData.title && updateData.title.length > 128) {
        updateData.title = updateData.title.substring(0, 124) + '…';
        console.warn(`[WARN] Title truncated to 128 characters for document ${documentId}`);
      }
      
      console.log('[DEBUG] Final update data:', updateData);
      await this.client.patch(`/documents/${documentId}/`, updateData);
      console.log(`[SUCCESS] Updated document ${documentId} with:`, updateData);
      return await this.getDocument(documentId);
    } catch (error) {
      console.log(error);
      console.error(`[ERROR] updating document ${documentId}:`, error.message);
      return null;
    }
  }
}


module.exports = new PaperlessService();
