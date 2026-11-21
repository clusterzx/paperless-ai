/**
 * Compatibility re-exports: the metadata cache moved to backend/metadata.ts and works on any
 * MetadataSource (the Paperless client is one).
 */
export {
  MetadataCache,
  MetadataCache as PaperlessMetadata,
  cleanName,
  normalizeName,
  type Kind,
  type MetadataExtras,
  type MetadataOptions,
  type MetadataSnapshot,
  type ResolveResult,
} from '../backend/metadata.js';
