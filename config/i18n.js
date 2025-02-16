const i18next = require('i18next');
const i18nextMiddleware = require('i18next-http-middleware');
const Backend = require('i18next-fs-backend');
const path = require('path');

i18next
  .use(Backend)
  .use(i18nextMiddleware.LanguageDetector)
  .init({
    backend: {
      loadPath: path.join(__dirname, '../locales/{{lng}}/{{ns}}.json'),
      addPath: path.join(__dirname, '../locales/{{lng}}/{{ns}}.json'),
    },
    fallbackLng: 'en',
    preload: ['en', 'de', 'es'],
    saveMissing: true,
    detection: {
      order: ['querystring', 'cookie', 'header'],
      lookupQuerystring: 'lng',
      lookupCookie: 'i18next',
      lookupHeader: 'accept-language',
      caches: ['cookie']
    }
  });

module.exports = {
  i18next,
  i18nextMiddleware: i18nextMiddleware.handle(i18next)
}; 