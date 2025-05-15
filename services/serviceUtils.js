const tiktoken = require('tiktoken');
const fs = require('fs').promises;
const path = require('path');

// Calculate tokens for a given text
async function calculateTokens(text, model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
    const tokenizer = tiktoken.encoding_for_model(model);
    return tokenizer.encode(text).length;
}

// Calculate total tokens for a system prompt and additional prompts
async function calculateTotalPromptTokens(systemPrompt, additionalPrompts = [], model = process.env.OPENAI_MODEL || "gpt-4o-mini") {
    let totalTokens = 0;

    // Count tokens for system prompt
    totalTokens += await calculateTokens(systemPrompt, model);

    // Count tokens for additional prompts
    for (const prompt of additionalPrompts) {
        if (prompt) { // Only count if prompt exists
            totalTokens += await calculateTokens(prompt, model);
        }
    }

    // Add tokens for message formatting (approximately 4 tokens per message)
    const messageCount = 1 + additionalPrompts.filter(p => p).length; // Count system + valid additional prompts
    totalTokens += messageCount * 4;

    return totalTokens;
}

// Truncate text to fit within token limit
async function truncateToTokenLimit(text, maxTokens, model = process.env.OPENAI_MODEL || "gpt-4o-mini") {

    const tokenizer = tiktoken.encoding_for_model(model);
    const tokens = tokenizer.encode(text);
  
    if (tokens.length <= maxTokens) {
      tokenizer.free();
      return text;
    }
  
    const truncatedTokens = tokens.slice(0, maxTokens);
    const truncatedText = tokenizer.decode(truncatedTokens);
    tokenizer.free();
    
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(truncatedText);
}

// Write prompt and content to a file with size management
async function writePromptToFile(systemPrompt, truncatedContent, filePath = './logs/prompt.txt', maxSize = 10 * 1024 * 1024) {
    try {
        const stats = await fs.stat(filePath);
        if (stats.size > maxSize) {
            await fs.unlink(filePath); // Delete the file if it exceeds max size
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[WARNING] Error checking file size:', error);
        }
    }

    try {
        await fs.appendFile(filePath, systemPrompt + truncatedContent + '\n\n');
    } catch (error) {
        console.error('[ERROR] Error writing to file:', error);
    }
}

module.exports = {
    calculateTokens,
    calculateTotalPromptTokens,
    truncateToTokenLimit,
    writePromptToFile
};