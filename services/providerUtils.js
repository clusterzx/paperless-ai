const FOUNDRY_LOCAL_PROVIDER = 'foundry-local';
const FOUNDRY_LOCAL_DEFAULT_API_KEY = 'foundry-local';

function isCustomOpenAICompatibleProvider(provider) {
  return provider === 'custom' || provider === FOUNDRY_LOCAL_PROVIDER;
}

function resolveCustomOpenAICompatibleConfig(provider, baseUrl, apiKey, model) {
  return {
    baseUrl: baseUrl || '',
    apiKey: apiKey || (provider === FOUNDRY_LOCAL_PROVIDER ? FOUNDRY_LOCAL_DEFAULT_API_KEY : ''),
    model: model || ''
  };
}

module.exports = {
  FOUNDRY_LOCAL_DEFAULT_API_KEY,
  FOUNDRY_LOCAL_PROVIDER,
  isCustomOpenAICompatibleProvider,
  resolveCustomOpenAICompatibleConfig
};
