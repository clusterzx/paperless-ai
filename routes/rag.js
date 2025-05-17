// routes/rag.js
const express = require('express');
const router = express.Router();
const ragService = require('../services/ragService');
const { isAuthenticated } = require('./auth');

/**
 * GET /rag
 * Render RAG view
 */
router.get('/', isAuthenticated, (req, res) => {
    res.render('rag', {
        title: 'RAG Assistant',
        version: require('../package.json').version
    });
});

/**
 * POST /rag/ask
 * Process a question using RAG and return answer with sources
 */
router.post('/ask', isAuthenticated, async (req, res) => {
    try {
        const { question, filters } = req.body;
        
        if (!question || typeof question !== 'string') {
            return res.status(400).json({ error: 'Question is required' });
        }
        
        // Pass detected language to the prompt if available
        const questionLanguage = filters && filters.language ? filters.language : null;
        
        // Set up SSE 
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        // Prepare loading message based on language
        let loadingMessage = "Searching relevant documents...";
        if (questionLanguage === 'de') {
            loadingMessage = "Suche relevante Dokumente...";
        } else if (questionLanguage === 'fr') {
            loadingMessage = "Recherche de documents pertinents...";
        } else if (questionLanguage === 'es') {
            loadingMessage = "Buscando documentos relevantes...";
        }
        
        // Tell client we're starting to search with appropriate language
        res.write(`data: ${JSON.stringify({ content: loadingMessage + "\n\n" })}\n\n`);
        
        // Search for documents using RAG service
        let result;
        try {
            result = await ragService.askQuestion(question, filters);
        } catch (error) {
            // Send error message
            res.write(`data: ${JSON.stringify({ 
                content: `Error searching documents: ${error.message}` 
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        
        // If no documents found or no answer
        if (!result || !result.answer) {
            res.write(`data: ${JSON.stringify({ 
                content: "I couldn't find any relevant documents to answer your question." 
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            return res.end();
        }
        
        // Stream the answer
        const answer = result.answer;
        const sources = result.sources;
        
        // If the answer is short, send it all at once
        if (answer.length < 1000) {
            res.write(`data: ${JSON.stringify({ 
                content: answer,
                sources: sources
            })}\n\n`);
        } else {
            // For longer answers, simulate streaming by sending chunks
            const chunkSize = 30;
            const words = answer.split(' ');
            
            for (let i = 0; i < words.length; i += chunkSize) {
                const chunk = words.slice(i, i + chunkSize).join(' ');
                res.write(`data: ${JSON.stringify({ content: chunk + ' ' })}\n\n`);
                
                // Small delay to simulate typing and prevent browser buffering
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            // At the end, also send the sources
            res.write(`data: ${JSON.stringify({ sources: sources })}\n\n`);
        }
        
        // Signal that we're done
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('Error in RAG processing:', error);
        
        // Try to respond if headers haven't been sent
        if (!res.headersSent) {
            return res.status(500).json({ error: 'Failed to process question' });
        } else {
            // Send error through SSE
            res.write(`data: ${JSON.stringify({ 
                content: `An error occurred: ${error.message}` 
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }
});

module.exports = router;
