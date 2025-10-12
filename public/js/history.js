// Theme Management
class ThemeManager {
    constructor() {
        this.themeToggle = document.getElementById('themeToggle');
        this.initialize();
    }

    initialize() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        this.setTheme(savedTheme);
        this.themeToggle?.addEventListener('click', () => this.toggleTheme());
    }

    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        const icon = this.themeToggle.querySelector('i');
        if (icon) {
            icon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
        }
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        this.setTheme(newTheme);
    }
}

class HistoryManager {
    constructor() {
        this.confirmModal = document.getElementById('confirmModal');
        this.confirmModalAll = document.getElementById('confirmModalAll');
        this.selectAll = document.getElementById('selectAll');
        this.table = null; // Will be initialized in initializeDataTable
        this.validateModal = null;
        this.initialize();
    }

    initialize() {
        this.table = this.initializeDataTable();
        this.initializeModals();
        this.initializeResetButtons();
        this.initializeFilters();
        this.initializeSelectAll();
    }

    initializeDataTable() {
        return $('#historyTable').DataTable({
            serverSide: true,
            processing: true,
            ajax: {
                url: '/api/history',
                data: (d) => {
                    d.tag = $('#tagFilter').val();
                    d.correspondent = $('#correspondentFilter').val();
                }
            },
            columns: [
                {
                    data: 'document_id',
                    render: (data) => `<input type="checkbox" class="doc-select rounded" value="${data}">`,
                    orderable: false,
                    width: '40px'
                },
                { 
                    data: 'document_id',
                    width: '60px'
                },
                {
                    data: 'title',
                    render: (data, type, row) => {
                        if (type === 'display') {
                            return `
                                <div class="font-medium">${data}</div>
                                <div class="text-xs text-gray-500">Modified: ${new Date(row.created_at).toLocaleString()}</div>
                            `;
                        }
                        return data;
                    }
                },
                {
                    data: 'tags',
                    render: (data, type) => {
                        if (type === 'display') {
                            if (!data?.length) return '<span class="text-gray-400 text-sm">No tags</span>';
                            return data.map(tag => 
                                `<span class="px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-xs" data-tag-id="${tag.id}">${tag.name}</span>`
                            ).join(' ');
                        }
                        return data?.map(t => t.name).join(', ') || '';
                    }
                },
                { data: 'correspondent' },
                {
                    data: null,
                    render: (data) => `
                        <div class="flex space-x-2">
                            <button onclick="window.open('${data.link}')" class="px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors">
                                <i class="fa-solid fa-eye"></i>
                                <span class="hidden sm:inline ml-1">View</span>
                            </button>
                            <button onclick="window.open('/chat?open=${data.document_id}')" class="px-3 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors">
                                <i class="fa-solid fa-comment"></i>
                                <span class="hidden sm:inline ml-1">Chat</span>
                            </button>
                        </div>
                    `,
                    orderable: false,
                    width: '150px'
                }
            ],
            order: [[2, 'desc']],
            pageLength: 10,
            dom: '<"flex flex-col sm:flex-row justify-between items-center mb-4"<"flex-1"f><"flex-none"l>>rtip',
            language: {
                search: "Search documents:",
                lengthMenu: "Show _MENU_ entries",
                info: "Showing _START_ to _END_ of _TOTAL_ documents",
                infoEmpty: "Showing 0 to 0 of 0 documents",
                infoFiltered: "(filtered from _MAX_ total documents)"
            },
            drawCallback: () => {
                // Update "Select All" checkbox state after table redraw
                this.updateSelectAllState();
                // Reattach event listeners to checkboxes
                this.attachCheckboxListeners();
            }
        });
    }

    initializeModals() {
        // Modal close handlers
        [this.confirmModal, this.confirmModalAll].forEach(modal => {
            if (!modal) return;
            
            // Close on overlay click
            modal.querySelector('.modal-overlay')?.addEventListener('click', () => {
                this.hideModal(modal);
            });

            // Close on X button click
            modal.querySelector('.modal-close')?.addEventListener('click', () => {
                this.hideModal(modal);
            });

            // Close on Cancel button click
            modal.querySelector('[id^="cancel"]')?.addEventListener('click', () => {
                this.hideModal(modal);
            });
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideModal(this.confirmModal);
                this.hideModal(this.confirmModalAll);
            }
        });

        // Reset action handlers
        document.getElementById('confirmReset')?.addEventListener('click', async () => {
            const selectedDocs = this.getSelectedDocuments();
            const success = await this.resetDocuments(selectedDocs);
            if (success) {
                this.hideModal(this.confirmModal);
            }
        });

        document.getElementById('confirmResetAll')?.addEventListener('click', async () => {
            const success = await this.resetAllDocuments();
            if (success) {
                this.hideModal(this.confirmModalAll);
            }
        });

        // Validation modal handlers
        this.validateModal = document.getElementById('validateModal');
        document.getElementById('validateHistoryBtn')?.addEventListener('click', async () => {
            await this.validateHistory();
        });

        document.getElementById('confirmRemoveMissing')?.addEventListener('click', async () => {
            const missingIds = Array.from(document.querySelectorAll('#validateResults input[type="checkbox"]:checked'))
                .map(cb => cb.value);
            if (missingIds.length === 0) {
                alert('No missing documents selected for removal.');
                return;
            }

            const success = await this.resetDocuments(missingIds);
            if (success) {
                this.hideModal(this.validateModal);
            }
        });

        document.getElementById('cancelValidate')?.addEventListener('click', () => {
            this.hideModal(this.validateModal);
        });
    }

    initializeResetButtons() {
        // Reset Selected button
        document.getElementById('resetSelectedBtn')?.addEventListener('click', () => {
            const selectedDocs = this.getSelectedDocuments();
            if (selectedDocs.length === 0) {
                alert('Please select at least one document to reset.');
                return;
            }
            this.showModal(this.confirmModal);
        });

        // Reset All button
        document.getElementById('resetAllBtn')?.addEventListener('click', () => {
            this.showModal(this.confirmModalAll);
        });
    }

    initializeFilters() {
        $('#tagFilter, #correspondentFilter').on('change', () => {
            this.table.ajax.reload();
        });
    }

    initializeSelectAll() {
        if (!this.selectAll) return;

        // Handle "Select All" checkbox
        this.selectAll.addEventListener('change', () => {
            const isChecked = this.selectAll.checked;
            const checkboxes = document.querySelectorAll('.doc-select');
            checkboxes.forEach(checkbox => {
                checkbox.checked = isChecked;
            });
        });

        // Initial state check
        this.updateSelectAllState();
    }

    attachCheckboxListeners() {
        const checkboxes = document.querySelectorAll('.doc-select');
        checkboxes.forEach(checkbox => {
            // Remove existing listeners to prevent duplicates
            checkbox.removeEventListener('change', this.handleCheckboxChange);
            // Add new listener
            checkbox.addEventListener('change', () => this.handleCheckboxChange());
        });
    }

    handleCheckboxChange() {
        this.updateSelectAllState();
    }

    updateSelectAllState() {
        if (!this.selectAll) return;

        const checkboxes = document.querySelectorAll('.doc-select');
        const checkedBoxes = document.querySelectorAll('.doc-select:checked');
        
        // Update "Select All" checkbox state
        this.selectAll.checked = checkboxes.length > 0 && checkboxes.length === checkedBoxes.length;
        
        // Update indeterminate state
        this.selectAll.indeterminate = checkedBoxes.length > 0 && checkedBoxes.length < checkboxes.length;
    }

    showModal(modal) {
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('show');
        }
    }

    hideModal(modal) {
        if (modal) {
            modal.classList.remove('show');
            modal.classList.add('hidden');
        }
    }

    getSelectedDocuments() {
        return Array.from(document.querySelectorAll('.doc-select:checked'))
            .map(checkbox => checkbox.value);
    }

    async resetDocuments(ids) {
        try {
            const response = await fetch('/api/reset-documents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids })
            });

            if (!response.ok) {
                throw new Error('Failed to reset documents');
            }

            await this.table.ajax.reload();
            return true;
        } catch (error) {
            console.error('Error resetting documents:', error);
            alert('Failed to reset documents. Please try again.');
            return false;
        }
    }

    async resetAllDocuments() {
        try {
            const response = await fetch('/api/reset-all-documents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                throw new Error('Failed to reset all documents');
            }

            await this.table.ajax.reload();
            return true;
        } catch (error) {
            console.error('Error resetting all documents:', error);
            alert('Failed to reset all documents. Please try again.');
            return false;
        }
    }

    async validateHistory() {
        try {
            // Show a loading state in the modal while we validate
            this.showModal(this.validateModal);
            const container = document.getElementById('validateResults');
            container.innerHTML = '<div>Checking history entries...</div>';

            const response = await fetch('/api/history/validate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                throw new Error('Failed to validate history');
            }

            const data = await response.json();
            this.renderValidateResults(data.missing || []);
        } catch (error) {
            console.error('Error validating history:', error);
            alert('Failed to validate history. Please try again.');
            this.hideModal(this.validateModal);
        }
    }

    renderValidateResults(missing) {
        const container = document.getElementById('validateResults');
        if (!container) return;

        if (!missing || missing.length === 0) {
            container.innerHTML = '<div class="text-green-600">No missing documents found.</div>';
            return;
        }

        const list = missing.map(item => {
            return `
                <div class="flex items-center justify-between p-2 border-b">
                    <label class="flex items-center gap-2">
                        <input type="checkbox" value="${item.document_id}" />
                        <span class="font-medium">${item.title || ('Document ' + item.document_id)}</span>
                    </label>
                    <span class="text-sm text-gray-500">ID: ${item.document_id}</span>
                </div>
            `;
        }).join('');

        container.innerHTML = list;
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.themeManager = new ThemeManager();
    window.historyManager = new HistoryManager();
});