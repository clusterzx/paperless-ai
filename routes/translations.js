const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;

router.get('/api/translations', async (req, res) => {
    try {
        const lang = req.language || 'en';
        const translationPath = path.join(__dirname, '..', 'locales', lang, 'translation.json');
        const translationContent = await fs.readFile(translationPath, 'utf8');
        const translations = JSON.parse(translationContent);
        res.json(translations);
    } catch (error) {
        console.error('Error loading translations:', error);
        res.status(500).json({ error: 'Failed to load translations' });
    }
});

router.post('/translations/change-language', async (req, res) => {
    try {
        const { language } = req.body;
        if (!language || !['en', 'de', 'es'].includes(language)) {
            return res.status(400).json({ error: 'Invalid language' });
        }

        // Set the language cookie
        res.cookie('i18next', language, {
            maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
            httpOnly: false, // Allow JavaScript access to the cookie
            path: '/'
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error changing language:', error);
        res.status(500).json({ error: 'Failed to change language' });
    }
});

module.exports = router; 