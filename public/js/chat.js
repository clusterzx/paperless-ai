let currentDocumentId = null;

// Initialize marked with options for code highlighting
marked.setOptions({
    highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true
});

// Load saved theme on page load
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    setupTextareaAutoResize();
});

async function initializeChat(documentId) {
    try {
        const response = await fetch(`/chat/init/${documentId}`);
        if (!response.ok) throw new Error('Failed to initialize chat');
        const data = await response.json();
        
        document.getElementById('initialState').classList.add('hidden');
        document.getElementById('chatHistory').classList.remove('hidden');
        document.getElementById('messageForm').classList.remove('hidden');
        document.getElementById('documentId').value = documentId;
        document.getElementById('chatHistory').innerHTML = '';
        
        currentDocumentId = documentId;
        
        addMessage('Chat initialized for document: ' + data.documentTitle, false);
    } catch (error) {
        console.error('Error initializing chat:', error);
        showError('Failed to initialize chat');
    }
}

async function sendMessage(message) {
    try {
        const response = await fetch('/chat/message', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                documentId: currentDocumentId,
                message: message
            })
        });
        
        if (!response.ok) throw new Error('Failed to send message');
        
        // Create message container for streaming response
        const containerDiv = document.createElement('div');
        containerDiv.className = 'message-container assistant';
        
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant';
        containerDiv.appendChild(messageDiv);
        
        document.getElementById('chatHistory').appendChild(containerDiv);
        
        let markdown = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value);
            const lines = text.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.content) {
                            markdown += parsed.content;
                            messageDiv.innerHTML = marked.parse(markdown);
                            
                            // Apply syntax highlighting to any code blocks
                            messageDiv.querySelectorAll('pre code').forEach((block) => {
                                hljs.highlightBlock(block);
                            });
                            
                            // Scroll to bottom
                            const chatHistory = document.getElementById('chatHistory');
                            chatHistory.scrollTop = chatHistory.scrollHeight;
                        }
                    } catch (e) {
                        console.error('Error parsing SSE data:', e);
                    }
                }
            }
        }

        return null; // No need to return response as it's handled in streaming
    } catch (error) {
        console.error('Error sending message:', error);
        throw error;
    }
}

function addMessage(message, isUser = true) {
    const containerDiv = document.createElement('div');
    containerDiv.className = `message-container ${isUser ? 'user' : 'assistant'}`;
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isUser ? 'user' : 'assistant'}`;
    
    if (isUser) {
        messageDiv.innerHTML = `<p>${escapeHtml(message)}</p>`;
    } else {
        let messageContent = message;
        try {
            if (typeof message === 'string' && message.trim().startsWith('{')) {
                const jsonResponse = JSON.parse(message);
                messageContent = jsonResponse.reply || jsonResponse.message || message;
            }
        } catch (e) {
            console.log('Message is not JSON, using as is');
        }
        
        messageDiv.innerHTML = marked.parse(messageContent);
        messageDiv.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightBlock(block);
        });
    }
    
    containerDiv.appendChild(messageDiv);
    const chatHistory = document.getElementById('chatHistory');
    chatHistory.appendChild(containerDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'message-container assistant';
    errorDiv.innerHTML = `
        <div class="message assistant error">
            <p>Error: ${escapeHtml(message)}</p>
        </div>
    `;
    document.getElementById('chatHistory').appendChild(errorDiv);
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function toggleTheme() {
    const currentTheme = document.body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
}

function setTheme(theme) {
    const body = document.body;
    const lightIcon = document.getElementById('lightIcon');
    const darkIcon = document.getElementById('darkIcon');
    
    body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    
    if (theme === 'dark') {
        lightIcon.classList.add('hidden');
        darkIcon.classList.remove('hidden');
    } else {
        lightIcon.classList.remove('hidden');
        darkIcon.classList.add('hidden');
    }
}

function setupTextareaAutoResize() {
    const textarea = document.getElementById('messageInput');
    
    function adjustHeight() {
        textarea.style.height = 'auto';
        textarea.style.height = (textarea.scrollHeight) + 'px';
    }
    
    textarea.addEventListener('input', adjustHeight);
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            document.getElementById('messageForm').dispatchEvent(new Event('submit'));
        }
    });
}

document.getElementById('documentSelect').addEventListener('change', function() {
    const documentId = this.value;
    if (documentId) {
        initializeChat(documentId);
    }
});

document.addEventListener("DOMContentLoaded", function () {
    const documentSelect = document.getElementById('documentSelect');
    const documentId = documentSelect.value;

    if (documentId) {
        initializeChat(documentId);
    }
});

document.getElementById('messageForm').querySelector('.send-button').addEventListener('click', async (e) => {
    await submitForm();
})

document.getElementById('messageInput').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        await submitForm();
    }
});

async function submitForm() {
    const messageInput = document.getElementById('messageInput');
    const message = messageInput.value.trim();
    
    if (!message) return;
    
    try {
        // Show user message immediately
        addMessage(message, true);
        
        // Clear input and reset height
        messageInput.value = '';
        messageInput.style.height = 'auto';
        
        // Send message and handle streaming response
        await sendMessage(message);
    } catch {
        showError('Failed to send message');
    }
}