// services/paperlessService.js
const axios = require('axios');
const config = require('../config/config');
const fs = require('fs');
const path = require('path');

class PaperlessService {
  constructor() {
    this.client = null;
    this.tagCache = new Map();
    this.lastTagRefresh = 0;
    this.CACHE_LIFETIME = 30000; // 30 Sekunden
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

      if (response.data) {      
        return response.data;
      }
      
      return null;
    } catch (error) {
      console.error(`Error fetching thumbnail for document ${documentId}:`, error.message);
      if (error.response) {
        // Mehr Debug-Info im Fehlerfall
        console.log('Error status:', error.response.status);
        console.log('Error headers:', error.response.headers);
      }
      return null;
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
      console.log('Refreshing tag cache...');
      const response = await this.client.get('/tags/');
      this.tagCache.clear();
      response.data.results.forEach(tag => {
        this.tagCache.set(tag.name.toLowerCase(), tag);
      });
      this.lastTagRefresh = Date.now();
      console.log(`Tag cache refreshed. Found ${this.tagCache.size} tags.`);
    } catch (error) {
      console.error('Error refreshing tag cache:', error.message);
      throw error;
    }
  }

  async findExistingTag(tagName) {
    const normalizedName = tagName.toLowerCase();
    
    // 1. Zuerst im Cache suchen
    const cachedTag = this.tagCache.get(normalizedName);
    if (cachedTag) {
      console.log(`Found tag "${tagName}" in cache with ID ${cachedTag.id}`);
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
        console.log(`Found existing tag "${tagName}" via API with ID ${foundTag.id}`);
        this.tagCache.set(normalizedName, foundTag);
        return foundTag;
      }
    } catch (error) {
      console.warn(`Error searching for tag "${tagName}":`, error.message);
    }

    return null;
  }

  async createTagSafely(tagName) {
    const normalizedName = tagName.toLowerCase();
    
    try {
      // Versuche zuerst, den Tag zu erstellen
      const response = await this.client.post('/tags/', { name: tagName });
      const newTag = response.data;
      console.log(`Successfully created tag "${tagName}" with ID ${newTag.id}`);
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

  async processTags(tagNames) {
    try {
      this.initialize();
      await this.ensureTagCache();
  
      // Input validation
      if (!tagNames) {
        console.warn('No tags provided to processTags');
        return { tagIds: [], errors: [] };
      }

      // Convert to array if string is passed
      const tagsArray = typeof tagNames === 'string' 
        ? [tagNames]
        : Array.isArray(tagNames) 
          ? tagNames 
          : [];

      if (tagsArray.length === 0) {
        console.warn('No valid tags to process');
        return { tagIds: [], errors: [] };
      }
  
      const tagIds = [];
      const errors = [];
      const processedTags = new Set(); // Prevent duplicates
  
      // Process regular tags
      for (const tagName of tagsArray) {
        if (!tagName || typeof tagName !== 'string') {
          console.warn(`Skipping invalid tag name: ${tagName}`);
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
          
          // If no existing tag found, create new one
          if (!tag) {
            tag = await this.createTagSafely(tagName);
          }
  
          if (tag && tag.id) {
            tagIds.push(tag.id);
            processedTags.add(normalizedName);
          }
  
        } catch (error) {
          console.error(`Error processing tag "${tagName}":`, error.message);
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
          console.error(`Error processing AI tag "${process.env.AI_PROCESSED_TAG_NAME}":`, error.message);
          errors.push({ tagName: process.env.AI_PROCESSED_TAG_NAME, error: error.message });
        }
      }
  
      return { 
        tagIds: [...new Set(tagIds)], // Remove any duplicates
        errors 
      };      
    } catch (error) {
      console.error('Error in processTags:', error);
      throw new Error(`Failed to process tags: ${error.message}`);
    }
  }

  async getTags() {
    this.initialize();
    if (!this.client) {
      console.error('Client not initialized');
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
          console.error(`Invalid API response on page ${page}`);
          break;
        }

        tags = tags.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `Fetched page ${page-1}, got ${response.data.results.length} tags. ` +
          `Total so far: ${tags.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`Error fetching tags page ${page}:`, error.message);
        if (error.response) {
          console.error('Response status:', error.response.status);
          console.error('Response data:', error.response.data);
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
      console.error('Error fetching tag count:', error.message);
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
      console.error('Error fetching correspondent count:', error.message);
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
      console.error('Error fetching document count:', error.message);
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
  
      console.log(allCorrespondents);
      return allCorrespondents;
  
    } catch (error) {
      console.error('Error fetching correspondent names:', error.message);
      return [];
    }
  }

  async listTagNames() {
    //list tag names and how many documents are tagged with it
    this.initialize();
    try {
      const response = await this.client.get('/tags/', {
        params: { fields: 'name', count: true }
      });
      return response.data.results.map(tag => ({
        name: tag.name,
        document_count: tag.document_count
      }));
    } catch (error) {
      console.error('Error fetching tag names:', error.message);
      return [];
    }
  }
  
  async getAllDocuments() {
    this.initialize();
    if (!this.client) {
      console.error('Client not initialized');
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
        console.warn('PROCESS_PREDEFINED_DOCUMENTS is set to yes but no TAGS are defined');
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
        console.warn('None of the specified tags were found');
        return [];
      }
      
      console.log('Filtering documents for tag IDs:', tagIds);
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
          console.error(`Invalid API response on page ${page}`);
          break;
        }

        documents = documents.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `Fetched page ${page-1}, got ${response.data.results.length} documents. ` +
          `Total so far: ${documents.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`Error fetching documents page ${page}:`, error.message);
        if (error.response) {
          console.error('Response status:', error.response.status);
        }
        break;
      }
    }

    console.log(`Finished fetching. Found ${documents.length} documents.`);
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
      console.error('Error fetching document IDs:', error.message);
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
      console.error('Client not initialized');
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
        console.warn('PROCESS_PREDEFINED_DOCUMENTS is set to yes but no TAGS are defined');
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
        console.warn('None of the specified tags were found');
        return [];
      }
      
      console.log('Filtering documents for tag IDs:', tagIds);
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
          console.error(`Invalid API response on page ${page}`);
          break;
        }

        documents = documents.concat(response.data.results);
        hasMore = response.data.next !== null;
        page++;

        console.log(
          `Fetched page ${page-1}, got ${response.data.results.length} documents. ` +
          `Total so far: ${documents.length}`
        );

        // Kleine Verzögerung um die API nicht zu überlasten
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`Error fetching documents page ${page}:`, error.message);
        if (error.response) {
          console.error('Response status:', error.response.status);
        }
        break;
      }
    }

    console.log(`Finished fetching. Found ${documents.length} documents.`);
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
      console.error(`Error fetching correspondent ${correspondentId}:`, error.message);
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
      console.error(`Error fetching tag name for ID ${tagId}:`, error.message);
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
      console.error('Error fetching documents with metadata:', error.message);
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
      console.error(`Error fetching document ${documentId}:`, error.message);
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
          console.log(`No correspondent with "${id}" found`);
          return null;
      }
      
      if (results.length > 1) {
          console.log(`Multiple correspondents found:`);
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
      console.error('Error while seraching for existing correspondent:', error.message);
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
            console.log(`No correspondent with name "${correspondent}" found`);
            return null;
        }
        
        if (results.length > 1) {
            console.log(`Multiple correspondents found:`);
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
        console.error('Error while seraching for existing correspondent:', error.message);
        throw error;
    }
  }

  async getOrCreateCorrespondent(name) {
    this.initialize();
    
    // Entferne nur Sonderzeichen, behalte Leerzeichen
    // const sanitizedName = name.replace(/[.,]/g, '').trim();
    // const normalizedName = sanitizedName.toLowerCase();
  
    try {
        // Suche mit dem bereinigten Namen
        const existingCorrespondent = await this.searchForExistingCorrespondent(name);
        console.log("Response Correspondent Search: ", existingCorrespondent);
    
        if (existingCorrespondent) {
            // If only one result is found, return it
            if (!Array.isArray(existingCorrespondent)) {
              console.log(`Found existing correspondent "${name}" with ID ${existingCorrespondent.id}`);
              return existingCorrespondent;
            }
            // If multiple results are found, return the first one
            const firstResult = existingCorrespondent[0];
            console.log(`Found multiple correspondents for "${name}". Returning first one with ID ${firstResult.id}`);
            return firstResult;
        }
    
        // Erstelle neuen Korrespondenten
        try {
            const createResponse = await this.client.post('/correspondents/', { 
                name: name 
            });
            console.log(`Created new correspondent "${name}" with ID ${createResponse.data.id}`);
            return createResponse.data;
        } catch (createError) {
            if (createError.response?.status === 400 && 
                createError.response?.data?.error?.includes('unique constraint')) {
              
                // Race condition check
                const retryResponse = await this.client.get('/correspondents/', {
                    params: { name: name }
                });
              
                const justCreatedCorrespondent = retryResponse.data.results.find(
                    c => c.name.toLowerCase() === normalizedName
                );
              
                if (justCreatedCorrespondent) {
                    console.log(`Retrieved correspondent "${name}" after constraint error with ID ${justCreatedCorrespondent.id}`);
                    return justCreatedCorrespondent;
                }
            }
            throw createError;
        }
    } catch (error) {
        console.error(`Failed to process correspondent "${name}":`, error.message);
        throw error;
    }
}

  async removeUnusedTagsFromDocument(documentId, keepTagIds) {
    this.initialize();
    if (!this.client) return;
  
    try {
      console.log(`Removing unused tags from document ${documentId}, keeping tags:`, keepTagIds);
      
      // Hole aktuelles Dokument
      const currentDoc = await this.getDocument(documentId);
      
      // Finde Tags die entfernt werden sollen (die nicht in keepTagIds sind)
      const tagsToRemove = currentDoc.tags.filter(tagId => !keepTagIds.includes(tagId));
      
      if (tagsToRemove.length === 0) {
        console.log('No tags to remove');
        return currentDoc;
      }
  
      // Update das Dokument mit nur den zu behaltenden Tags
      const updateData = {
        tags: keepTagIds
      };
  
      // Führe das Update durch
      await this.client.patch(`/documents/${documentId}/`, updateData);
      console.log(`Successfully removed ${tagsToRemove.length} tags from document ${documentId}`);
      
      return await this.getDocument(documentId);
    } catch (error) {
      console.error(`Error removing unused tags from document ${documentId}:`, error.message);
      throw error;
    }
  }

  async getTagTextFromId(tagId) {
    this.initialize();
    try {
      const response = await this.client.get(`/tags/${tagId}/`);
      return response.data.name;
    } catch (error) {
      console.error(`Error fetching tag text for ID ${tagId}:`, error.message);
      return null;
    }
  }

  async updateDocument(documentId, updates) {
    this.initialize();
    if (!this.client) return;
    try {
      // Hole aktuelles Dokument mit existierenden Tags
      const currentDoc = await this.getDocument(documentId);
      
      // Wenn das Update Tags enthält, füge sie zu den existierenden hinzu
      if (updates.tags) {
        console.log(`Current tags for document ${documentId}:`, currentDoc.tags);
        console.log(`Adding new tags:`, updates.tags);
        console.log(`Current correspondent:`, currentDoc.correspondent);
        console.log(`New correspondent:`, updates.correspondent);
                
        // Kombiniere existierende und neue Tags
        const combinedTags = [...new Set([...currentDoc.tags, ...updates.tags])];
        updates.tags = combinedTags;
        
        console.log(`Combined tags:`, combinedTags);
      }

      // Entferne den correspondent aus updates wenn bereits einer existiert
      if (currentDoc.correspondent && updates.correspondent) {
        console.log('Document already has a correspondent, keeping existing one:', currentDoc.correspondent);
        delete updates.correspondent;
      }
  
      // Bereite die Update-Daten vor
      const updateData = {
        ...updates,
        // Wenn ein Datum vorhanden ist, formatiere es korrekt für die API
        ...(updates.created && {
          created: new Date(updates.created).toISOString()
        })
      };
  
      // Führe das Update durch
      await this.client.patch(`/documents/${documentId}/`, updateData);
      console.log(`Updated document ${documentId} with:`, updateData);
      
      return await this.getDocument(documentId); // Optional: Gib das aktualisierte Dokument zurück
    } catch (error) {
      console.error(`Error updating document ${documentId}:`, error.message);
      return null; // Oder eine andere geeignete Rückgabe
    }
  }
}


module.exports = new PaperlessService();