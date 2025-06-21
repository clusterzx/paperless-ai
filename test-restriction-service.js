/**
 * Test script to demonstrate the new restriction prompt service functionality
 */
const RestrictionPromptService = require('./services/restrictionPromptService');

// Mock data for testing
const existingTags = [
  { name: 'invoice' },
  { name: 'receipt' },
  { name: 'contract' },
  { name: 'urgent' }
];

const existingCorrespondents = ['John Doe', 'ACME Corp', 'Tax Office'];

const config = {
  useExistingData: 'yes',
  restrictToExistingTags: 'yes',
  restrictToExistingCorrespondents: 'yes'
};

console.log('=== Restriction Prompt Service Test ===\n');

// Test 1: Prompt with placeholders
console.log('Test 1: Prompt with placeholders');
const promptWithPlaceholders = `You are a document analysis AI. 
Available tags: %RESTRICTED_TAGS%
Available correspondents: %RESTRICTED_CORRESPONDENTS%
Please analyze the document accordingly.`;

const result1 = RestrictionPromptService.processRestrictionsInPrompt(
  promptWithPlaceholders,
  existingTags,
  existingCorrespondents,
  config
);

console.log('Original prompt:');
console.log(promptWithPlaceholders);
console.log('\nProcessed prompt:');
console.log(result1.processedPrompt);
console.log('\nRestriction prompts:');
console.log(result1.restrictionPrompts);

console.log('\n' + '='.repeat(50) + '\n');

// Test 2: Prompt without placeholders
console.log('Test 2: Prompt without placeholders');
const promptWithoutPlaceholders = `You are a document analysis AI. Please analyze the document.`;

const result2 = RestrictionPromptService.processRestrictionsInPrompt(
  promptWithoutPlaceholders,
  existingTags,
  existingCorrespondents,
  config
);

console.log('Original prompt:');
console.log(promptWithoutPlaceholders);
console.log('\nProcessed prompt:');
console.log(result2.processedPrompt);
console.log('\nRestriction prompts:');
console.log(result2.restrictionPrompts);

console.log('\n' + '='.repeat(50) + '\n');

// Test 3: Empty data with placeholders
console.log('Test 3: Empty data with placeholders');
const result3 = RestrictionPromptService.processRestrictionsInPrompt(
  promptWithPlaceholders,
  [],
  [],
  config
);

console.log('Original prompt:');
console.log(promptWithPlaceholders);
console.log('\nProcessed prompt (with empty data):');
console.log(result3.processedPrompt);
console.log('\nRestriction prompts:');
console.log(result3.restrictionPrompts);

console.log('\n=== Test Complete ===');
