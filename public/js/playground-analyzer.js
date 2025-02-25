// Prompt Rating System and Analyzer combined in one file
class PromptRatingSystem {
    constructor() {
        this.localStorageKey = 'savedPrompts';
        this.savedPrompts = this.loadSavedPrompts();
        this.currentPrompt = '';
        
        // Erst Modal erstellen, dann UI Setup
        this.createRatingModal();
        this.setupUI();
        this.setupEventListeners();
    }

    loadSavedPrompts() {
        try {
            const saved = localStorage.getItem(this.localStorageKey);
            return saved ? JSON.parse(saved) : [];
        } catch (error) {
            console.error('Error loading saved prompts:', error);
            return [];
        }
    }

    setupUI() {
        try {
            // Rate Button hinzufügen
            const analyzeButton = document.getElementById('analyzeButton');
            if (!analyzeButton) {
                console.error('Analyze button not found');
                return;
            }

            const rateButton = document.createElement('button');
            rateButton.id = 'rateButton';
            rateButton.className = 'hidden ml-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-all duration-200';
            rateButton.innerHTML = '<i class="fas fa-star mr-2"></i>Rate Prompt';
            analyzeButton.parentNode.appendChild(rateButton);

            // Saved Prompts Section erstellen
            this.createSavedPromptsSection();
            this.addStyles();
        } catch (error) {
            console.error('Error setting up UI:', error);
        }
    }

    setupEventListeners() {
        try {
            // Rate Button Click
            const rateButton = document.getElementById('rateButton');
            if (rateButton) {
                rateButton.addEventListener('click', () => this.showRatingModal());
            }

            // Modal Event Listeners
            const modal = document.getElementById('ratingModal');
            if (modal) {
                const stars = modal.querySelectorAll('.star-rating button');
                const saveButton = modal.querySelector('#saveRating');
                const closeButton = modal.querySelector('.modal-close');
                let selectedRating = 0;

                stars.forEach(star => {
                    star.addEventListener('click', (e) => {
                        const rating = parseInt(e.currentTarget.dataset.rating);
                        selectedRating = rating;
                        stars.forEach(s => {
                            s.classList.toggle('active', parseInt(s.dataset.rating) <= rating);
                        });
                    });
                });

                if (saveButton) {
                    saveButton.addEventListener('click', () => {
                        if (selectedRating === 0) {
                            alert('Please select a rating');
                            return;
                        }

                        const comment = modal.querySelector('#ratingComment')?.value || '';
                        this.savePromptRating(selectedRating, comment);
                        this.hideRatingModal();
                        this.refreshSavedPrompts();
                        selectedRating = 0; // Reset rating
                    });
                }

                if (closeButton) {
                    closeButton.addEventListener('click', () => this.hideRatingModal());
                }

                // Click outside to close
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) {
                        this.hideRatingModal();
                    }
                });
            }

            // Clear All Button
            const clearButton = document.getElementById('clearPrompts');
            if (clearButton) {
                clearButton.addEventListener('click', () => {
                    if (confirm('Are you sure you want to delete all saved prompts?')) {
                        this.clearAllPrompts();
                    }
                });
            }
        } catch (error) {
            console.error('Error setting up event listeners:', error);
        }
    }

    createRatingModal() {
        if (document.getElementById('ratingModal')) {
            return; // Modal already exists
        }

        const modalHtml = `
            <div id="ratingModal" class="fixed inset-0 z-50 hidden">
                <div class="fixed inset-0 bg-black bg-opacity-50 backdrop-blur-sm"></div>
                <div class="fixed inset-0 flex items-center justify-center p-4">
                    <div class="bg-white rounded-lg shadow-xl max-w-md w-full relative" style="background: var(--bg-primary); color: var(--text-primary)">
                        <div class="p-4 flex justify-between items-center border-b" style="border-color: var(--border-color)">
                            <h3 class="text-lg font-semibold">Rate this Prompt</h3>
                            <button class="modal-close hover:opacity-70">
                                <i class="fas fa-times"></i>
                            </button>
                        </div>
                        <div class="p-4">
                            <div class="prompt-preview mb-4 p-2 rounded" style="background: var(--bg-secondary)">
                                <code class="text-sm break-all whitespace-pre-wrap"></code>
                            </div>
                            <div class="star-rating flex justify-center gap-2" id="starRating">
                                ${Array.from({length: 10}, (_, i) => `
                                    <button data-rating="${i + 1}" class="text-2xl focus:outline-none hover:scale-110 transition-transform">
                                        <i class="fas fa-star"></i>
                                    </button>
                                `).join('')}
                            </div>
                            <textarea
                                id="ratingComment"
                                placeholder="Add your comments about this prompt..."
                                class="w-full p-2 mt-4 rounded"
                                style="background: var(--bg-primary); border: 1px solid var(--border-color);"
                                rows="3"
                            ></textarea>
                            <button id="saveRating" class="w-full mt-4 px-4 py-2 text-white rounded hover:opacity-90 transition-opacity" style="background: var(--accent-primary)">
                                Save Rating
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
    }

    createSavedPromptsSection() {
        const existingSection = document.querySelector('.saved-prompts-section');
        if (existingSection) {
            existingSection.remove();
        }

        const promptsSection = document.createElement('div');
        promptsSection.className = 'material-card mb-8 saved-prompts-section';
        promptsSection.innerHTML = `
            <h2 class="card-title flex justify-between items-center">
                Saved Prompts
                <button id="clearPrompts" class="text-sm px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700">
                    Clear All
                </button>
            </h2>
            <div id="savedPromptsList"></div>
        `;

        // Nach der Analyse-Sektion einfügen
        const analysisSection = document.querySelector('.material-card');
        if (analysisSection) {
            analysisSection.parentNode.insertBefore(promptsSection, analysisSection.nextSibling);
        }

        this.refreshSavedPrompts();
    }

    addStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #ratingModal {
                transition: opacity 0.2s ease-in-out;
            }
            
            #ratingModal.hidden {
                opacity: 0;
                pointer-events: none;
            }
            
            #ratingModal:not(.hidden) {
                opacity: 1;
                pointer-events: auto;
            }

            #ratingModal .prompt-preview {
                max-height: 40vh;
                overflow-y: auto;
                margin-right: -0.5rem;
                padding-right: 0.5rem;
            }

            #ratingModal .prompt-preview code {
                display: block;
                word-break: break-word;
            }

            @media (max-height: 700px) {
                #ratingModal .prompt-preview {
                    max-height: 30vh;
                }
            }

            .star-rating button {
                color: #cbd5e1;
                transition: all 0.2s ease;
            }

            .star-rating button.active,
            .star-rating button:hover {
                color: #eab308;
            }

            .star-rating button:hover ~ button {
                color: #cbd5e1;
            }

            .saved-prompt-card {
                position: relative;
                background: var(--card-bg);
                border: 1px solid var(--border-color);
                border-radius: 0.5rem;
                padding: 1rem;
                margin-bottom: 1rem;
                transition: all 0.2s ease;
            }

            .saved-prompt-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            }

            .saved-prompt-card .rating {
                color: #eab308;
            }

            .saved-prompt-card .prompt-text {
                font-family: monospace;
                background: var(--bg-secondary);
                padding: 0.5rem;
                border-radius: 0.25rem;
                margin: 0.5rem 0;
                white-space: pre-wrap;
                word-break: break-all;
            }
        `;
        document.head.appendChild(style);
    }

    showRatingModal() {
        const modal = document.getElementById('ratingModal');
        if (!modal) {
            console.error('Rating modal not found');
            return;
        }
        
        // Debug-Ausgabe
        console.log('Current prompt:', this.currentPrompt);
        
        // Setze den Prompt-Text
        const codeElement = modal.querySelector('.prompt-preview code');
        if (codeElement) {
            codeElement.textContent = this.currentPrompt;
        }
        
        // Reset state
        modal.querySelectorAll('.star-rating button').forEach(star => star.classList.remove('active'));
        const commentField = modal.querySelector('#ratingComment');
        if (commentField) {
            commentField.value = '';
        }
        
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    hideRatingModal() {
        const modal = document.getElementById('ratingModal');
        if (modal) {
            modal.classList.add('hidden');
            document.body.style.overflow = '';
        }
    }

    savePromptRating(rating, comment) {
        // Debug-Ausgabe
        console.log('Saving prompt:', this.currentPrompt);
        
        // Sicherstellen, dass wir einen Prompt haben
        if (!this.currentPrompt) {
            console.error('No prompt to save');
            return;
        }
    
        const promptData = {
            prompt: this.currentPrompt,
            rating: rating,
            comment: comment,
            date: new Date().toISOString(),
            id: Date.now()
        };
    
        // Debug-Ausgabe
        console.log('Saving prompt data:', promptData);
    
        this.savedPrompts.unshift(promptData);
        try {
            localStorage.setItem(this.localStorageKey, JSON.stringify(this.savedPrompts));
        } catch (error) {
            console.error('Error saving to localStorage:', error);
        }
    }

    refreshSavedPrompts() {
        const container = document.getElementById('savedPromptsList');
        if (!container) return;

        container.innerHTML = this.savedPrompts.map(prompt => `
            <div class="saved-prompt-card" data-id="${prompt.id}">
                <div class="rating text-lg mb-2">
                    ${Array.from({length: prompt.rating}, () => '<i class="fas fa-star"></i>').join('')}
                    <span class="ml-2 text-sm">${prompt.rating}/10</span>
                </div>
                <div class="prompt-text text-sm">${prompt.prompt}</div>
                ${prompt.comment ? `<div class="mt-2 text-sm italic text-gray-600">${prompt.comment}</div>` : ''}
                <div class="mt-2 text-xs text-gray-500">${new Date(prompt.date).toLocaleString()}</div>
                <div class="absolute top-2 right-2 flex gap-2">
                    <button onclick="window.promptRating.usePrompt(${prompt.id})" 
                            class="px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
                            title="Use this prompt">
                        <i class="fas fa-play"></i>
                    </button>
                    <button onclick="window.promptRating.deletePrompt(${prompt.id})"
                            class="px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700"
                            title="Delete this prompt">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('') || '<p class="text-gray-500 italic p-4">No saved prompts yet</p>';
    }

    usePrompt(id) {
        const prompt = this.savedPrompts.find(p => p.id === id);
        if (prompt) {
            const textarea = document.getElementById('analysisPrompt');
            if (textarea) {
                textarea.value = prompt.prompt;
                // Scroll zum Textarea
                textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
                // Optional: Fokussiere das Textarea
                textarea.focus();
            }
        }
    }

    deletePrompt(id) {
        if (confirm('Are you sure you want to delete this prompt?')) {
            this.savedPrompts = this.savedPrompts.filter(p => p.id !== id);
            localStorage.setItem(this.localStorageKey, JSON.stringify(this.savedPrompts));
            this.refreshSavedPrompts();
        }
    }

    clearAllPrompts() {
        this.savedPrompts = [];
        localStorage.removeItem(this.localStorageKey);
        this.refreshSavedPrompts();
    }

    setCurrentPrompt(prompt) {
        this.currentPrompt = prompt;
        const rateButton = document.getElementById('rateButton');
        if (rateButton) {
            rateButton.classList.remove('hidden');
        }
    }
}

// Playground Document Analyzer
class PlaygroundAnalyzer {
    constructor() {
        this.analysisPrompt = document.getElementById('analysisPrompt');
        this.analyzeButton = document.getElementById('analyzeButton');
        this.documentsGrid = document.getElementById('documentsGrid');
        this.isAnalyzing = false;
        this.promptRating = new PromptRatingSystem(); // Initialize rating system here

        this.initialize();
    }

    initialize() {
        this.analyzeButton.addEventListener('click', () => this.startAnalysis());
        this.setupStyles();
    }

    setupStyles() {
        const style = document.createElement('style');
        style.textContent = `
            /* Kartendesign */
            .document-card {
                display: flex;
                flex-direction: column;
            }

            .document-info {
                flex-grow: 1;
                min-height: 8rem;
                padding: 0.75rem;
            }

            /* Container für Text-Informationen */
            .info-container {
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
                margin-top: 0.5rem;
            }

            .info-item {
                display: flex;
                flex-direction: column;
                gap: 0.25rem;
            }

            /* Highlighting */
            .document-card.updated {
                animation: highlight 2s ease-in-out;
            }
            
            @keyframes highlight {
                0% { box-shadow: 0 0 0 2px var(--accent-primary); }
                100% { box-shadow: none; }
            }
            
            /* Tag-Stile */
            .tag.new-tag {
                background: #22c55e !important;
                animation: fadeIn 0.5s ease-in-out;
            }

            .tag.updated-tag {
                background: #eab308 !important;
                animation: fadeIn 0.5s ease-in-out;
            }

            /* Text-Updates */
            .updated-text {
                color: var(--accent-primary);
                font-weight: 600;
            }

            .updated-text::after {
                content: '(updated)';
                font-size: 0.75rem;
                color: #22c55e;
                font-weight: normal;
                margin-left: 0.5rem;
            }

            .old-value {
                text-decoration: line-through;
                color: #94a3b8;
                font-size: 0.75rem;
                margin-top: 0.25rem;
                display: block;
            }

            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(-5px); }
                to { opacity: 1; transform: translateY(0); }
            }

            /* Verbesserte Tag-Container */
            .tags-container {
                display: flex;
                flex-wrap: wrap;
                gap: 0.25rem;
                padding: 0.5rem;
                min-height: 2.5rem;
            }

            /* Responsives Layout */
            @media (max-width: 1536px) {
                .document-info {
                    min-height: 10rem;
                }
            }

            /* Highlighting für das aktuelle Dokument */
            .document-card.processing {
                box-shadow: 0 0 0 2px #60a5fa;
                transform: scale(1.02);
                transition: all 0.3s ease-in-out;
                position: relative;
            }

            .document-card.processing::after {
                content: 'Processing...';
                position: absolute;
                top: 0.5rem;
                right: 0.5rem;
                background: #60a5fa;
                color: white;
                padding: 0.25rem 0.5rem;
                border-radius: 0.25rem;
                font-size: 0.75rem;
                animation: pulse 1.5s infinite;
            }

            @keyframes pulse {
                0% { opacity: 0.6; }
                50% { opacity: 1; }
                100% { opacity: 0.6; }
            }
        `;
        document.head.appendChild(style);
    }

    async startAnalysis() {
        if (this.isAnalyzing) return;
        
        const prompt = this.analysisPrompt.value.trim();
        if (!prompt) {
            this.showMessage('Please enter an analysis prompt', 'error');
            return;
        }
    
        this.isAnalyzing = true;
        this.analyzeButton.disabled = true;
        this.showMessage('Starting document analysis...', 'info');
    
        try {
            const documents = Array.from(this.documentsGrid.children);
            for (const [index, docCard] of documents.entries()) {
                this.showMessage(`Analyzing document ${index + 1} of ${documents.length}...`, 'info');
                
                docCard.scrollIntoView({ 
                    behavior: 'smooth', 
                    block: 'center' 
                });
                
                docCard.classList.add('processing');
                await this.analyzeDocument(docCard, prompt);
                docCard.classList.remove('processing');
                
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            window.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
            
            // Hier ist die wichtige Änderung - speichere den Prompt direkt
            window.promptRating.currentPrompt = prompt;  // Direkter Zugriff
            window.promptRating.setCurrentPrompt(prompt);  // Aktiviere den Rate Button
            
            this.showMessage('Analysis completed successfully', 'success');
        } catch (error) {
            console.error('Analysis error:', error);
            this.showMessage('Error during analysis: ' + error.message, 'error');
        } finally {
            this.isAnalyzing = false;
            this.analyzeButton.disabled = false;
        }
    }

    async analyzeDocument(docCard, prompt) {
        const docId = docCard.dataset.documentId;
        if (!docId) return;

        try {
            // Dokument-Content abrufen
            const contentResponse = await fetch(`/manual/preview/${docId}`);
            if (!contentResponse.ok) throw new Error('Failed to fetch document content');
            const contentData = await contentResponse.json();

            // Bestehende Tags und Correspondent erfassen
            const existingTags = Array.from(docCard.querySelectorAll('.tag'))
                .map(tag => ({
                    id: tag.dataset.tagId,
                    name: tag.textContent.trim()
                }));
            
            const existingCorrespondent = docCard.querySelector('[data-correspondent]')?.dataset.correspondent;
            const existingDocumentType = docCard.querySelector('[data-document_type]')?.dataset.document_type;
            const existingTitle = docCard.querySelector('h3').textContent;
            const existingDocumentDate = docCard.querySelector('[data-document_date]')?.dataset.document_date;

            // Analyse durchführen
            const analysisResponse = await fetch('/manual/playground', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    content: contentData.content,
                    prompt: prompt,
                    documentId: docId
                })
            });

            if (!analysisResponse.ok) {
                const errorData = await analysisResponse.json();
                throw new Error(errorData.error || 'Analysis failed');
            }

            const result = await analysisResponse.json();
            
            // Karte aktualisieren
            await this.updateDocumentCard(docCard, result.document, {
                existingTags,
                existingCorrespondent,
                existingDocumentType,
                existingTitle,
                existingDocumentDate
            });

        } catch (error) {
            console.error(`Error analyzing document ${docId}:`, error);
            this.showMessage(`Error analyzing document ${docId}: ${error.message}`, 'warning');
        }
    }

    async updateDocumentCard(docCard, analysisResult, existing) {
        // Tags aktualisieren
        console.log('Existing Data:', existing);
        if (analysisResult.tags && analysisResult.tags.length > 0) {
            const tagsContainer = docCard.querySelector('.tags-container, div[class*="flex flex-wrap gap"]');
            if (tagsContainer) {
                const existingTagIds = existing.existingTags.map(t => t.id);
                
                // Neue Tags hinzufügen
                analysisResult.tags.forEach(tagId => {
                    if (!existingTagIds.includes(tagId)) {
                        const tagSpan = document.createElement('span');
                        tagSpan.className = 'tag new-tag text-xs px-2 py-1 rounded-full text-white';
                        tagSpan.dataset.tagId = tagId;
                        tagSpan.textContent = tagId;
                        tagsContainer.appendChild(tagSpan);
                    }
                });
            }
        }

        // Update document date
        let documentDate = new Date(analysisResult.document_date);
        if (!isNaN(documentDate) && analysisResult.document_date.valueOf() !== existing.existingDocumentDate) {
            const dateElem = docCard.querySelector('[data-document_date]');
            if (dateElem) {
                const oldDocumentDate = dateElem.textContent.trim();
                const infoContainer = document.createElement('div');
                infoContainer.className = 'info-item';

                const newValue = document.createElement('span');
                newValue.className = 'updated-text text-sm truncate';
                newValue.textContent = documentDate.toLocaleDateString();

                const oldValue = document.createElement('span');
                oldValue.className = 'old-value';
                oldValue.textContent = oldDocumentDate;

                infoContainer.appendChild(newValue);
                infoContainer.appendChild(oldValue);

                dateElem.parentNode.replaceChild(infoContainer, dateElem);
            }
        }

        // Correspondent aktualisieren
        if (analysisResult.correspondent && analysisResult.correspondent !== existing.existingCorrespondent) {
            const correspondentElem = docCard.querySelector('[data-correspondent]');
            if (correspondentElem) {
                // Speichere den ursprünglichen Namen statt der ID
                const oldCorrespondentName = correspondentElem.textContent.trim();
                const infoContainer = document.createElement('div');
                infoContainer.className = 'info-item';
                
                const newValue = document.createElement('span');
                newValue.className = 'updated-text text-sm truncate';
                // Hier müssen wir den neuen Namen aus correspondentNames holen
                newValue.textContent = window.correspondentNames?.[analysisResult.correspondent] || analysisResult.correspondent;
                
                const oldValue = document.createElement('span');
                oldValue.className = 'old-value';
                // Verwende den gespeicherten Namen
                oldValue.textContent = oldCorrespondentName;
                
                infoContainer.appendChild(newValue);
                infoContainer.appendChild(oldValue);
                
                correspondentElem.parentNode.replaceChild(infoContainer, correspondentElem);
                infoContainer.dataset.correspondent = analysisResult.correspondent;
            }
        }

        // Update document type
        if (analysisResult.document_type && analysisResult.document_type !== existing.existingDocumentType) {
            const documentTypeElem = docCard.querySelector('[data-document_type]');
            if (documentTypeElem) {
                // Save name instead of id
                const oldDocumentTypeName = documentTypeElem.textContent.trim();
                const infoContainer = document.createElement('div');
                infoContainer.className = 'info-item';

                const newValue = document.createElement('span');
                newValue.className = 'updated-text text-sm truncate';
                // get new  name from document types list
                newValue.textContent = window.documentTypes?.[analysisResult.document_type] || analysisResult.document_type;

                const oldValue = document.createElement('span');
                oldValue.className = 'old-value';
                // Use saved name
                oldValue.textContent = oldDocumentTypeName;

                infoContainer.appendChild(newValue);
                infoContainer.appendChild(oldValue);

                documentTypeElem.parentNode.replaceChild(infoContainer, documentTypeElem);
                infoContainer.dataset.document_type = analysisResult.document_type;
            }
        }
    
        // Titel aktualisieren
        if (analysisResult.title && analysisResult.title !== existing.existingTitle) {
            const titleElem = docCard.querySelector('h3');
            if (titleElem) {
                const infoContainer = document.createElement('div');
                infoContainer.className = 'info-item';
                
                const newValue = document.createElement('span');
                newValue.className = 'updated-text text-sm font-medium truncate';
                newValue.textContent = analysisResult.title;
                
                const oldValue = document.createElement('span');
                oldValue.className = 'old-value';
                oldValue.textContent = existing.existingTitle;
                
                infoContainer.appendChild(newValue);
                infoContainer.appendChild(oldValue);
                
                titleElem.parentNode.replaceChild(infoContainer, titleElem);
            }
        }

        // Show custom fields
        if (analysisResult.custom_fields) {
            const infoContainer = docCard.querySelector('.info-item-meta');
            for (const key in analysisResult.custom_fields) {
                const newField = document.createElement('span');
                newField.className = 'updated-text text-sm truncate';
                newField.textContent = `${analysisResult.custom_fields[key].field_name}: ${analysisResult.custom_fields[key].value}`;
                infoContainer.appendChild(newField);
            }
        }

        // Highlight-Effekt
        docCard.classList.add('updated');
        setTimeout(() => {
            docCard.classList.remove('updated');
        }, 2000);
    }

    showMessage(message, type = 'info') {
        let messageArea = document.getElementById('messageArea');
        if (!messageArea) {
            messageArea = document.createElement('div');
            messageArea.id = 'messageArea';
            const analysisSection = document.querySelector('.material-card');
            analysisSection.parentNode.insertBefore(messageArea, analysisSection);
        }

        const colors = {
            error: 'red',
            success: 'green',
            info: 'blue',
            warning: 'yellow'
        };

        const color = colors[type] || colors.info;

        messageArea.className = `mb-4 p-4 rounded-md bg-${color}-50 border border-${color}-200 text-${color}-700`;
        messageArea.innerHTML = `
            <div class="flex">
                <div class="flex-shrink-0">
                    <i class="fas fa-${type === 'error' ? 'exclamation-circle' : 
                                    type === 'success' ? 'check-circle' : 
                                    type === 'warning' ? 'exclamation-triangle' : 
                                    'info-circle'} text-${color}-400"></i>
                </div>
                <div class="ml-3">
                    <p class="text-sm">${message}</p>
                </div>
            </div>
        `;

        if (type === 'success') {
            setTimeout(() => {
                messageArea.remove();
            }, 5000);
        }
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.playgroundAnalyzer = new PlaygroundAnalyzer();
    window.promptRating = new PromptRatingSystem();
});