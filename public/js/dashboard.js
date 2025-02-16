// Add translation function if not defined
const t = window.t || ((key, params) => {
    // Simple fallback if translation function is not available
    if (params) {
        return `${key} (${Object.entries(params).map(([k,v]) => `${k}:${v}`).join(',')})`;
    }
    return key;
});

// Theme Management
class ThemeManager {
    constructor() {
        this.themeToggle = document.getElementById('themeToggle');
        this.initialize();
    }

    initialize() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        this.setTheme(savedTheme);
        console.log('Theme initialized');
        this.themeToggle.addEventListener('click', () => this.toggleTheme());
    }

    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        
        const icon = this.themeToggle.querySelector('i');
        icon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        this.setTheme(newTheme);
        console.log('Theme toggled to: ' + newTheme);
    }
}

// Chart Initialization
class ChartManager {
    constructor() {
        this.initializeDocumentChart();
    }

    initializeDocumentChart() {
        const { documentCount, processedCount } = window.dashboardData;
        const unprocessedCount = documentCount - processedCount;

        const ctx = document.getElementById('documentChart').getContext('2d');
        new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['AI Processed', 'Unprocessed'],
                datasets: [{
                    data: [processedCount, unprocessedCount],
                    backgroundColor: [
                        '#3b82f6',  // blue-500
                        '#e2e8f0'   // gray-200
                    ],
                    borderWidth: 0,
                    spacing: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const value = context.raw;
                                const total = processedCount + unprocessedCount;
                                const percentage = ((value / total) * 100).toFixed(1);
                                return `${value} (${percentage}%)`;
                            }
                        }
                    }
                }
            }
        });
    }
}

// Modal Management
class ModalManager {
    constructor() {
        this.modal = document.getElementById('detailsModal');
        this.modalTitle = this.modal.querySelector('.modal-title');
        this.modalContent = this.modal.querySelector('.modal-data');
        this.modalLoader = this.modal.querySelector('.modal-loader');
        this.initializeEventListeners();
    }

    initializeEventListeners() {
        // Close button click
        this.modal.querySelector('.modal-close').addEventListener('click', () => this.hideModal());
        
        // Overlay click
        this.modal.querySelector('.modal-overlay').addEventListener('click', () => this.hideModal());
        
        // Escape key press
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modal.classList.contains('show')) {
                this.hideModal();
            }
        });
    }

    showModal(title) {
        this.modalTitle.textContent = title;
        this.modalContent.innerHTML = '';
        this.modal.classList.remove('hidden'); // Fix: Remove 'hidden' class
        this.modal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    hideModal() {
        this.modal.classList.remove('show');
        this.modal.classList.add('hidden'); // Fix: Add 'hidden' class back
        document.body.style.overflow = '';
    }

    showLoader() {
        this.modalLoader.classList.remove('hidden');
        this.modalContent.classList.add('hidden');
    }

    hideLoader() {
        this.modalLoader.classList.add('hidden');
        this.modalContent.classList.remove('hidden');
    }

    setContent(content) {
        this.modalContent.innerHTML = content;
    }
}

// Make showTagDetails and showCorrespondentDetails globally available
window.showTagDetails = async function() {
    window.modalManager.showModal('Tag Overview');
    window.modalManager.showLoader();

    try {
        const response = await fetch('/api/tagsCount');
        const tags = await response.json();

        let content = '<div class="detail-list">';
        tags.forEach(tag => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${tag.name}</span>
                    <span class="detail-item-info">${tag.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        window.modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading tags:', error);
        window.modalManager.setContent('<div class="text-red-500 p-4">Error loading tags. Please try again later.</div>');
    } finally {
        window.modalManager.hideLoader();
    }
}

window.showCorrespondentDetails = async function() {
    window.modalManager.showModal('Correspondent Overview');
    window.modalManager.showLoader();

    try {
        const response = await fetch('/api/correspondentsCount');
        const correspondents = await response.json();

        let content = '<div class="detail-list">';
        correspondents.forEach(correspondent => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${correspondent.name}</span>
                    <span class="detail-item-info">${correspondent.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        window.modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading correspondents:', error);
        window.modalManager.setContent('<div class="text-red-500 p-4">Error loading correspondents. Please try again later.</div>');
    } finally {
        window.modalManager.hideLoader();
    }
}

// Navigation Management
class NavigationManager {
    constructor() {
        this.sidebarLinks = document.querySelectorAll('.sidebar-link');
        this.initialize();
    }

    initialize() {
        this.sidebarLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                // Nur für Links ohne echtes Ziel preventDefault aufrufen
                if (link.getAttribute('href') === '#') {
                    e.preventDefault();
                }
                this.setActiveLink(link);
            });
        });
    }

    setActiveLink(activeLink) {
        this.sidebarLinks.forEach(link => {
            link.classList.remove('active');
        });
        activeLink.classList.add('active');
    }
}

// API Functions
async function showTagDetails() {
    modalManager.showModal('Tag Overview');
    modalManager.showLoader();

    try {
        const response = await fetch('/api/tags');
        const tags = await response.json();

        let content = '<div class="detail-list">';
        tags.forEach(tag => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${tag.name}</span>
                    <span class="detail-item-info">${tag.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading tags:', error);
        modalManager.setContent('<div class="text-red-500 p-4">Error loading tags. Please try again later.</div>');
    } finally {
        modalManager.hideLoader();
    }
}

async function showCorrespondentDetails() {
    modalManager.showModal('Correspondent Overview');
    modalManager.showLoader();

    try {
        const response = await fetch('/api/correspondents');
        const correspondents = await response.json();

        let content = '<div class="detail-list">';
        correspondents.forEach(correspondent => {
            content += `
                <div class="detail-item">
                    <span class="detail-item-name">${correspondent.name}</span>
                    <span class="detail-item-info">${correspondent.document_count || 0} documents</span>
                </div>
            `;
        });
        content += '</div>';

        modalManager.setContent(content);
    } catch (error) {
        console.error('Error loading correspondents:', error);
        modalManager.setContent('<div class="text-red-500 p-4">Error loading correspondents. Please try again later.</div>');
    } finally {
        modalManager.hideLoader();
    }
}

// Update the status last updated text
function updateLastUpdated() {
    const statusLastUpdated = document.getElementById('statusLastUpdated');
    if (statusLastUpdated) {
        console.log({t})
        statusLastUpdated.textContent = `${t('dashboard.processing.status.lastUpdated')}: ${new Date().toLocaleTimeString()}`;
    }
}

// Format time ago with translations
function formatTimeAgo(dateString) {
    const date = new Date(dateString + 'Z');
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);

    if (seconds < 5) {
        return t('time.justNow');
    } else if (seconds < 60) {
        return t('time.secondsAgo', { count: seconds });
    } else if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        return t('time.minutesAgo', { count: minutes });
    } else if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        return t('time.hoursAgo', { count: hours });
    } else {
        const days = Math.floor(seconds / 86400);
        return t('time.daysAgo', { count: days });
    }
}

// Update processing status with translations
function updateProcessingStatus() {
    fetch('/api/processing-status')
        .then(response => response.json())
        .then(data => {
            console.log('Processing status data:', data);
            
            const processingContainer = document.getElementById('processingContainer');
            const idleContainer = document.getElementById('idleContainer');
            
            if (data.currentlyProcessing) {
                processingContainer.classList.remove('hidden');
                idleContainer.classList.add('hidden');
                document.getElementById('scanButton').disabled = true;
                
                document.getElementById('currentDocId').textContent = `#${data.currentlyProcessing.documentId}`;
                data.currentlyProcessing.title = data.currentlyProcessing.title.length > 50
                    ? data.currentlyProcessing.title.slice(0, 90) + '...'
                    : data.currentlyProcessing.title;
                document.getElementById('currentDocTitle').textContent = data.currentlyProcessing.title;
                
                document.getElementById('lastProcessed').innerHTML = `
                    <span class="text-blue-600">
                        <i class="fas fa-spinner fa-spin"></i> ${t('dashboard.processing.status.processing')}...
                    </span>`;
            } else {
                processingContainer.classList.add('hidden');
                idleContainer.classList.remove('hidden');
                document.getElementById('scanButton').disabled = false;
                
                if (data.lastProcessed) {
                    const timeAgo = formatTimeAgo(data.lastProcessed.processed_at);
                    document.getElementById('lastProcessed').textContent = timeAgo;
                } else {
                    document.getElementById('lastProcessed').textContent = t('dashboard.processing.status.noDocuments');
                }
            }
            
            document.getElementById('processedToday').textContent = data.processedToday;
            updateLastUpdated();
        })
        .catch(error => console.error('Error fetching processing status:', error));
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    // Update status every 3 seconds
    setInterval(updateProcessingStatus, 3000);

    // Initial update
    updateProcessingStatus();
});

// Update check functionality
async function checkForUpdates() {
    try {
        const currentVersion = document.querySelector('[data-version]')?.dataset.version;
        if (!currentVersion) return;

        const response = await fetch('https://api.github.com/repos/clusterzx/paperless-ai/releases/latest');
        if (!response.ok) throw new Error('Failed to fetch release info');
        
        const data = await response.json();
        const latestVersion = data.tag_name;

        const current = currentVersion.replace('v', '').split('.').map(Number);
        const latest = latestVersion.replace('v', '').split('.').map(Number);

        for (let i = 0; i < 3; i++) {
            if ((latest[i] || 0) > (current[i] || 0)) {
                document.getElementById('latestVersion').textContent = latestVersion;
                const notification = document.getElementById('updateNotification');
                notification.classList.remove('hidden');
                notification.style.opacity = '0';
                notification.style.transform = 'translateY(20px)';
                
                setTimeout(() => {
                    notification.style.transition = 'all 0.3s ease-out';
                    notification.style.opacity = '1';
                    notification.style.transform = 'translateY(0)';
                }, 100);
                
                break;
            } else if ((latest[i] || 0) < (current[i] || 0)) {
                break;
            }
        }
    } catch (error) {
        console.error('Failed to check for updates:', error);
    }
}

// Check for updates when the page loads
document.addEventListener('DOMContentLoaded', checkForUpdates);

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.navigationManager = new NavigationManager();
    window.chartManager = new ChartManager();
    window.modalManager = new ModalManager();
});