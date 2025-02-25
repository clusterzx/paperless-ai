// services/documentsService.js
const paperlessService = require('./paperlessService');

class DocumentsService {
  constructor() {
    this.tagCache = new Map();
    this.correspondentCache = new Map();
    this.documentTypeCache = new Map();
  }

  async getTagNames() {
    if (this.tagCache.size === 0) {
      const tags = await paperlessService.getTags();
      tags.forEach(tag => {
        this.tagCache.set(tag.id, tag.name);
      });
    }
    return Object.fromEntries(this.tagCache);
  }

  async getCorrespondentNames() {
    if (this.correspondentCache.size === 0) {
      const correspondents = await paperlessService.listCorrespondentsNames();
      correspondents.forEach(corr => {
        this.correspondentCache.set(corr.id, corr.name);
      });
    }
    return Object.fromEntries(this.correspondentCache);
  }

  async getDocumentTypes() {
    if (this.documentTypeCache.size === 0) {
      const documentTypes = await paperlessService.listDocumentTypes();
      documentTypes.forEach(documentType => {
        this.documentTypeCache.set(documentType.id, documentType.name);
      })
    }
    return Object.fromEntries(this.documentTypeCache);
  }

  async getDocumentsWithMetadata(numberOfDocuments = -1) {
    const [documents, tagNames, correspondentNames, documentTypes] = await Promise.all([
      paperlessService.getDocuments(numberOfDocuments),
      this.getTagNames(),
      this.getCorrespondentNames(),
      this.getDocumentTypes()
    ]);

    // Sort documents by created date (newest first)
    documents.sort((a, b) => new Date(b.created) - new Date(a.created));

    return {
      documents,
      tagNames,
      correspondentNames,
      documentTypes,
      paperlessUrl: process.env.PAPERLESS_API_URL.replace('/api', '')
    };
  }
}

module.exports = new DocumentsService();