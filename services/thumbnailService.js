const path = require("path");
const {promises: fs} = require("fs");
const console = require("node:console");

class ThumbnailService {

  constructor({thumbnailBasedir = null, paperlessService = null}) {
    this.thumbnailBasedir = thumbnailBasedir || path.join(process.cwd(), 'public', 'images');
    this.paperlessService = paperlessService || require("./paperlessService");
  }

  /**
   * Retrieves the file path of a thumbnail image for a given document ID. If the thumbnail is not cached locally,
   * it fetches the thumbnail from the Paperless service, caches it locally, and then returns the file path.
   *
   * @param {string} id - The unique identifier of the document for which the thumbnail is to be retrieved.
   * @return {Promise<string|null>} The file path of the cached or newly created thumbnail image. Returns null if the thumbnail is not available.
   */
  async getThumbnailPath(id) {
    // Handle thumbnail caching
    const cachePath = path.join(this.thumbnailBasedir, `${id}.png`);
    try {
      await fs.access(cachePath);
      console.debug('Thumbnail already cached');
      return cachePath;
    } catch (err) {
      console.log('Thumbnail not cached, fetching from Paperless');
      console.debug('Received error', err)

      const thumbnailData = await this.paperlessService.getThumbnailImage(id);

      if (!thumbnailData) {
        console.warn(`Thumbnail for id ${id} not found`);
        return null;
      }

      await fs.mkdir(path.dirname(cachePath), {recursive: true});
      await fs.writeFile(cachePath, thumbnailData);
    }

    return cachePath;
  }
}

module.exports.ThumbnailService = ThumbnailService;