/**
 * Service for handling placeholder replacement in prompts
 * Used by all LLM services to ensure consistent placeholder handling
 */
class RestrictionPromptService {
  /**
   * Process placeholders in a prompt by replacing them with actual data
   * @param {string} prompt - The original prompt that may contain placeholders
   * @param {Array} existingTags - Array of existing tags
   * @param {Array|string} existingCorrespondentList - List of existing correspondents
   * @param {Object} config - Configuration object (unused but kept for compatibility)
   * @returns {string} - Prompt with placeholders replaced
   */
  static processRestrictionsInPrompt(prompt, existingTags, existingCorrespondentList, config) {
    // Replace placeholders in the original prompt
    return this._replacePlaceholders(prompt, existingTags, existingCorrespondentList);
  }

  /**
   * Replace placeholders in the prompt with actual data
   * @param {string} prompt - The original prompt
   * @param {Array} existingTags - Array of existing tags
   * @param {Array|string} existingCorrespondentList - List of existing correspondents
   * @returns {string} - Prompt with placeholders replaced
   */
  static _replacePlaceholders(prompt, existingTags, existingCorrespondentList) {
    let processedPrompt = prompt;

    // Replace %RESTRICTED_TAGS% placeholder
    if (processedPrompt.includes('%RESTRICTED_TAGS%')) {
      const tagsList = this._formatTagsList(existingTags);
      processedPrompt = processedPrompt.replace(/%RESTRICTED_TAGS%/g, tagsList);
    }

    // Replace %RESTRICTED_CORRESPONDENTS% placeholder
    if (processedPrompt.includes('%RESTRICTED_CORRESPONDENTS%')) {
      const correspondentsList = this._formatCorrespondentsList(existingCorrespondentList);
      processedPrompt = processedPrompt.replace(/%RESTRICTED_CORRESPONDENTS%/g, correspondentsList);
    }

    return processedPrompt;
  }

  /**
   * Format tags list into a comma-separated string
   * @param {Array} existingTags - Array of existing tags
   * @returns {string} - Comma-separated list of tag names or empty string
   */
  static _formatTagsList(existingTags) {
    if (!Array.isArray(existingTags) || existingTags.length === 0) {
      return '';
    }

    return existingTags
      .filter(tag => tag && tag.name)
      .map(tag => tag.name)
      .join(', ');
  }

  /**
   * Format correspondents list into a comma-separated string
   * @param {Array|string} existingCorrespondentList - List of existing correspondents
   * @returns {string} - Comma-separated list of correspondent names or empty string
   */
  static _formatCorrespondentsList(existingCorrespondentList) {
    if (!existingCorrespondentList) {
      return '';
    }

    if (typeof existingCorrespondentList === 'string') {
      return existingCorrespondentList.trim();
    }

    if (Array.isArray(existingCorrespondentList)) {
      return existingCorrespondentList
        .filter(Boolean)  // Remove any null/undefined entries
        .map(correspondent => {
          if (typeof correspondent === 'string') return correspondent;
          return correspondent?.name || '';
        })
        .filter(name => name.length > 0)  // Remove empty strings
        .join(', ');
    }

    return '';
  }
}

module.exports = RestrictionPromptService;
