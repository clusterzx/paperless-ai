function getTextFromMessageContent(messageContent) {
  if (typeof messageContent === 'string') {
    return messageContent;
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (part && typeof part.text === 'string') {
          return part.text;
        }

        if (part && typeof part.content === 'string') {
          return part.content;
        }

        return '';
      })
      .join('');
  }

  if (messageContent && typeof messageContent === 'object') {
    if (typeof messageContent.text === 'string') {
      return messageContent.text;
    }

    return JSON.stringify(messageContent);
  }

  return String(messageContent || '');
}

const MIN_EXTRACTED_JSON_RATIO = 0.6;

function extractLikelyJsonObject(content) {
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return content;
  }

  const extracted = content.slice(firstBrace, lastBrace + 1);

  if (content.length === 0 || extracted.length / content.length < MIN_EXTRACTED_JSON_RATIO) {
    return content;
  }

  return extracted;
}

function parseJsonCompletionContent(messageContent) {
  const rawContent = getTextFromMessageContent(messageContent).trim();

  if (!rawContent) {
    throw new Error('Invalid API response structure');
  }

  const cleanedContent = rawContent
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    return JSON.parse(cleanedContent);
  } catch (error) {
    const extractedJson = extractLikelyJsonObject(cleanedContent);

    if (extractedJson !== cleanedContent) {
      try {
        return JSON.parse(extractedJson);
      } catch {
        // Preserve the original parse error because it better reflects the raw response.
      }
    }

    throw error;
  }
}

function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return value;
  }

  const convertedValue = Number(value);
  return Number.isFinite(convertedValue) ? convertedValue : undefined;
}

function mapUsageMetrics(providerName, usage, timestamp) {
  if (!usage) {
    console.warn(`[WARNING] ${providerName} did not return usage metrics`);
    return null;
  }

  const promptTokens = toFiniteNumber(usage.prompt_tokens);
  const completionTokens = toFiniteNumber(usage.completion_tokens);
  const totalTokens = toFiniteNumber(usage.total_tokens)
    ?? (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
      ? promptTokens + completionTokens
      : undefined);

  if (
    Number.isFinite(promptTokens)
    && Number.isFinite(completionTokens)
    && Number.isFinite(totalTokens)
  ) {
    console.log(`[DEBUG] [${timestamp}] Total tokens: ${totalTokens}`);

    return {
      promptTokens,
      completionTokens,
      totalTokens
    };
  }

  console.warn(`[WARNING] ${providerName} returned incomplete usage metrics`);
  return null;
}

module.exports = {
  getTextFromMessageContent,
  mapUsageMetrics,
  parseJsonCompletionContent
};
