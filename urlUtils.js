/**
 * Normalizes a URL by removing any trailing slashes.
 * @param {string} url The URL to normalize.
 * @returns {string} The normalized URL, or an empty string if the input is invalid.
 */
function normalizeUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  return url.replace(/\/$/, '');
}

module.exports = { normalizeUrl };