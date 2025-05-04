class ThemeManager {
    constructor() {
        this.themeToggle = document.getElementById('themeToggle');
        this.initialize();
    }

    initialize() {
        // Load saved theme or default to light
        const savedTheme = localStorage.getItem('theme') || 'light';
        this.setTheme(savedTheme);
        
        // Add event listener for theme toggle
        this.themeToggle.addEventListener('click', () => this.toggleTheme());
    }

    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        
        // Update toggle button icon
        const icon = this.themeToggle.querySelector('i');
        icon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
        
        // Update any active Shepherd tour
        this.updateShepherdTheme(theme);
    }

    updateShepherdTheme(theme) {
        const activeTooltips = document.querySelectorAll('.shepherd-element');
        activeTooltips.forEach(tooltip => {
            tooltip.style.background = getComputedStyle(document.documentElement)
                .getPropertyValue('--shepherd-bg');
        });
    }

    toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        this.setTheme(newTheme);
    }
}

class FormManager {
    constructor() {
        this.form = document.getElementById('setupForm');
        this.aiProvider = document.getElementById('aiProvider');
        this.showTags = document.getElementById('showTags');
        this.aiProcessedTag = document.getElementById('aiProcessedTag');
        this.usePromptTags = document.getElementById('usePromptTags');
        this.systemPrompt = document.getElementById('systemPrompt');
        this.systemPromptBtn = document.getElementById('systemPromptBtn');
        this.initialize();
    }

    initialize() {
        // Initialize provider settings
        this.toggleProviderSettings();
        
        // Initialize tags section
        this.toggleTagsInput();
        
        // Add event listeners
        this.aiProvider.addEventListener('change', () => this.toggleProviderSettings());
        this.showTags.addEventListener('change', () => this.toggleTagsInput());
        this.aiProcessedTag.addEventListener('change', () => this.toggleAiTagInput());
        this.usePromptTags.addEventListener('change', () => this.togglePromptTagsInput());
        
        // Initialize password toggles
        this.initializePasswordToggles();

        // Initial state for prompt elements based on usePromptTags
        if (this.usePromptTags.value === 'yes') {
            this.disablePromptElements();
        }
        
        // Initialize new sections
        this.toggleAiTagInput();
        this.togglePromptTagsInput();
    }

    toggleProviderSettings() {
        const provider = this.aiProvider.value;
        const openaiSettings = document.getElementById('openaiSettings');
        const ollamaSettings = document.getElementById('ollamaSettings');
        const customSettings = document.getElementById('customSettings');
        const azureSettings = document.getElementById('azureSettings');
        
        // Get all required fields
        const openaiKey = document.getElementById('openaiKey');
        const ollamaUrl = document.getElementById('ollamaUrl');
        const ollamaModel = document.getElementById('ollamaModel');
        const customBaseUrl = document.getElementById('customBaseUrl');
        const customApiKey = document.getElementById('customApiKey');
        const customModel = document.getElementById('customModel');
        const azureApiKey = document.getElementById('azureApiKey');
        const azureEndpoint = document.getElementById('azureEndpoint');
        const azureModel = document.getElementById('azureApiVersion');
        const azureDeployment = document.getElementById('azureDeploymentName');
        
        // Hide all settings first
        openaiSettings.style.display = 'none';
        ollamaSettings.style.display = 'none';
        customSettings.style.display = 'none';
        azureSettings.style.display = 'none';
        
        // Reset all required attributes
        openaiKey.required = false;
        ollamaUrl.required = false;
        ollamaModel.required = false;
        customBaseUrl.required = false;
        customApiKey.required = false;
        customModel.required = false;
        azureApiKey.required = false;
        azureEndpoint.required = false;
        azureModel.required = false;
        azureDeployment.required = false;
        
        // Show and set required fields based on selected provider
        switch (provider) {
            case 'openai':
                openaiSettings.style.display = 'block';
                openaiKey.required = true;
                break;
            case 'ollama':
                ollamaSettings.style.display = 'block';
                ollamaUrl.required = true;
                ollamaModel.required = true;
                break;
            case 'custom':
                customSettings.style.display = 'block';
                customBaseUrl.required = true;
                customApiKey.required = true;
                customModel.required = true;
                break;
            case 'azure':
                azureSettings.style.display = 'block';
                azureApiKey.required = true;
                azureEndpoint.required = true;
                azureModel.required = true;
                azureDeployment.required = true;
                break;
        }
    }

    toggleTagsInput() {
        const showTags = this.showTags.value;
        const tagsInputSection = document.getElementById('tagsInputSection');
        
        if (showTags === 'yes') {
            tagsInputSection.classList.remove('hidden');
        } else {
            tagsInputSection.classList.add('hidden');
        }
    }

    toggleAiTagInput() {
        const showAiTag = this.aiProcessedTag.value;
        const aiTagNameSection = document.getElementById('aiTagNameSection');
        
        if (showAiTag === 'yes') {
            aiTagNameSection.classList.remove('hidden');
        } else {
            aiTagNameSection.classList.add('hidden');
        }
    }

    togglePromptTagsInput() {
        const usePromptTags = this.usePromptTags.value;
        const promptTagsSection = document.getElementById('promptTagsSection');
        
        if (usePromptTags === 'yes') {
            promptTagsSection.classList.remove('hidden');
            this.disablePromptElements();
        } else {
            promptTagsSection.classList.add('hidden');
            this.enablePromptElements();
        }
    }

    disablePromptElements() {
        this.systemPrompt.disabled = true;
        this.systemPromptBtn.disabled = true;
        this.systemPrompt.classList.add('disabled');
        this.systemPromptBtn.classList.add('disabled');
    }

    enablePromptElements() {
        this.systemPrompt.disabled = false;
        this.systemPromptBtn.disabled = false;
        this.systemPrompt.classList.remove('disabled');
        this.systemPromptBtn.classList.remove('disabled');
    }

    initializePasswordToggles() {
        document.querySelectorAll('.password-toggle').forEach(toggle => {
            toggle.addEventListener('click', (e) => {
                const inputId = e.currentTarget.dataset.input;
                this.togglePassword(inputId);
            });
        });
    }

    togglePassword(inputId) {
        const input = document.getElementById(inputId);
        const icon = input.nextElementSibling.querySelector('i');
        
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.remove('fa-eye');
            icon.classList.add('fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.remove('fa-eye-slash');
            icon.classList.add('fa-eye');
        }
    }
}

class TabManager {
    constructor() {
        this.currentTab = 0;
        this.tabs = Array.from(document.querySelectorAll('.tab-button'));
        this.contents = Array.from(document.querySelectorAll('.tab-content'));
        this.prevBtn = document.getElementById('prevBtn');
        this.nextBtn = document.getElementById('nextBtn');
        this.submitBtn = document.getElementById('submitBtn');
        
        this.initialize();
    }

    initialize() {
        // Add click handlers to tab buttons
        this.tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => this.showTab(index));
        });

        // Add click handlers to navigation buttons
        this.prevBtn.addEventListener('click', () => this.navigate(-1));
        this.nextBtn.addEventListener('click', () => this.navigate(1));

        // Show initial tab
        this.showTab(this.currentTab);
    }

    showTab(index) {
        if (index < 0 || index >= this.tabs.length) return;

        // Update active states
        this.tabs.forEach(tab => tab.classList.remove('active'));
        this.contents.forEach(content => content.classList.remove('active'));

        this.tabs[index].classList.add('active');
        this.contents[index].classList.add('active');

        // Update navigation buttons
        this.prevBtn.style.display = index === 0 ? 'none' : 'flex';
        if (index === this.tabs.length - 1) {
            this.nextBtn.style.display = 'none';
            this.submitBtn.style.display = 'flex';
        } else {
            this.nextBtn.style.display = 'flex';
            this.submitBtn.style.display = 'none';
        }

        this.currentTab = index;
    }

    navigate(direction) {
        const newIndex = this.currentTab + direction;
        if (newIndex >= 0 && newIndex < this.tabs.length) {
            // Validate current tab before proceeding
            if (direction > 0 && !this.validateTab(this.currentTab)) {
                return;
            }
            this.showTab(newIndex);
        }
    }

    validateTab(tabIndex) {
        // Get all required fields in the current tab
        const currentTabContent = this.contents[tabIndex];
        const requiredFields = currentTabContent.querySelectorAll('[required]');
        
        let isValid = true;
        requiredFields.forEach(field => {
            if (!field.value.trim()) {
                isValid = false;
                field.classList.add('error');
                // Add error styling
                field.style.borderColor = 'var(--error-text)';
            } else {
                field.classList.remove('error');
                field.style.borderColor = '';
            }
        });

        if (!isValid) {
            Swal.fire({
                icon: 'error',
                title: 'Required Fields',
                text: 'Please fill in all required fields before proceeding.',
                confirmButtonColor: 'var(--accent-primary)'
            });
        }

        return isValid;
    }
}

// Tags Management
class TagsManager {
    constructor() {
        this.tagInput = document.getElementById('tagInput');
        this.tagsContainer = document.getElementById('tagsContainer');
        this.tagsHiddenInput = document.getElementById('tags');
        this.addTagButton = document.querySelector('.add-tag-btn');
        this.initialize();
        
        // Initialize existing tags with click handlers
        document.querySelectorAll('.modern-tag button').forEach(button => {
            button.addEventListener('click', async () => {
                const result = await Swal.fire({
                    title: 'Remove Tag',
                    text: 'Are you sure you want to remove this tag?',
                    icon: 'question',
                    showCancelButton: true,
                    confirmButtonText: 'Yes, remove it',
                    cancelButtonText: 'Cancel',
                    confirmButtonColor: '#d33',
                    cancelButtonColor: '#3085d6',
                    customClass: {
                        container: 'my-swal'
                    }
                });

                if (result.isConfirmed) {
                    button.closest('.modern-tag').remove();
                    this.updateHiddenInput();
                }
            });
        });
    }

    initialize() {
        // Add event listeners
        this.addTagButton.addEventListener('click', () => this.addTag());
        this.tagInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.addTag();
            }
        });
    }

    async addTag() {
        const tagText = this.tagInput.value.trim();
        const specialChars = /[,;:\n\r\\/]/;
        if (specialChars.test(tagText)) {
            await Swal.fire({
                title: 'Invalid Characters',
                text: 'Tags cannot contain commas, semi-colons, colons, or line breaks.',
                icon: 'warning',
                confirmButtonText: 'OK',
                confirmButtonColor: '#3085d6',
                customClass: {
                    container: 'my-swal'
                }
            });
            return;
        }
        if (tagText) {
            const tag = this.createTagElement(tagText);
            this.tagsContainer.appendChild(tag);
            this.updateHiddenInput();
            this.tagInput.value = '';
        }
    }

    createTagElement(text) {
        const tag = document.createElement('div');
        tag.className = 'modern-tag fade-in';
        
        const tagText = document.createElement('span');
        tagText.textContent = text;
        
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.innerHTML = '<i class="fas fa-times"></i>';
        removeButton.addEventListener('click', async () => {
            const result = await Swal.fire({
                title: 'Remove Tag',
                text: 'Are you sure you want to remove this tag?',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Yes, remove it',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#d33',
                cancelButtonColor: '#3085d6',
                customClass: {
                    container: 'my-swal'
                }
            });

            if (result.isConfirmed) {
                tag.remove();
                this.updateHiddenInput();
            }
        });

        tag.appendChild(tagText);
        tag.appendChild(removeButton);
        
        return tag;
    }

    updateHiddenInput() {
        const tags = Array.from(this.tagsContainer.children)
            .map(tag => tag.querySelector('span').textContent);
        this.tagsHiddenInput.value = tags.join(',');
    }
}

// Prompt Tags Management
class PromptTagsManager {
    constructor() {
        this.tagInput = document.getElementById('promptTagInput');
        this.tagsContainer = document.getElementById('promptTagsContainer');
        this.tagsHiddenInput = document.getElementById('promptTags');
        this.addTagButton = document.querySelector('.add-prompt-tag-btn');
        this.initialize();
        
        // Initialize existing tags with click handlers
        document.querySelectorAll('#promptTagsContainer .modern-tag button').forEach(button => {
            button.addEventListener('click', async () => {
                const result = await Swal.fire({
                    title: 'Remove Tag',
                    text: 'Are you sure you want to remove this tag?',
                    icon: 'question',
                    showCancelButton: true,
                    confirmButtonText: 'Yes, remove it',
                    cancelButtonText: 'Cancel',
                    confirmButtonColor: '#d33',
                    cancelButtonColor: '#3085d6',
                    customClass: {
                        container: 'my-swal'
                    }
                });

                if (result.isConfirmed) {
                    button.closest('.modern-tag').remove();
                    this.updateHiddenInput();
                }
            });
        });
    }

    initialize() {
        // Add event listeners
        this.addTagButton.addEventListener('click', () => this.addTag());
        this.tagInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.addTag();
            }
        });
    }

    async addTag() {
        const tagText = this.tagInput.value.trim();
        const specialChars = /[,;:\n\r\\/]/;
        if (specialChars.test(tagText)) {
            await Swal.fire({
                title: 'Invalid Characters',
                text: 'Tags cannot contain commas, semi-colons, colons, or line breaks.',
                icon: 'warning',
                confirmButtonText: 'OK',
                confirmButtonColor: '#3085d6',
                customClass: {
                    container: 'my-swal'
                }
            });
            return;
        }
        if (tagText) {
            const tag = this.createTagElement(tagText);
            this.tagsContainer.appendChild(tag);
            this.updateHiddenInput();
            this.tagInput.value = '';
        }
    }

    createTagElement(text) {
        const tag = document.createElement('div');
        tag.className = 'modern-tag fade-in';
        
        const tagText = document.createElement('span');
        tagText.textContent = text;
        
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.innerHTML = '<i class="fas fa-times"></i>';
        removeButton.addEventListener('click', async () => {
            const result = await Swal.fire({
                title: 'Remove Tag',
                text: 'Are you sure you want to remove this tag?',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: 'Yes, remove it',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#d33',
                cancelButtonColor: '#3085d6',
                customClass: {
                    container: 'my-swal'
                }
            });

            if (result.isConfirmed) {
                tag.remove();
                this.updateHiddenInput();
            }
        });

        tag.appendChild(tagText);
        tag.appendChild(removeButton);
        
        return tag;
    }

    updateHiddenInput() {
        const tags = Array.from(this.tagsContainer.children)
            .map(tag => tag.querySelector('span').textContent);
        this.tagsHiddenInput.value = tags.join(',');
    }
}

// Prompt Management
class PromptManager {
    constructor() {
        this.systemPrompt = document.getElementById('systemPrompt');
        this.exampleButton = document.getElementById('systemPromptBtn');
        this.initialize();
    }

    initialize() {
        this.exampleButton.addEventListener('click', () => this.prefillExample());
    }

    prefillExample() {
        const examplePrompt = `You are a personalized document analysis expert trained to process various types of documents—including multi-document PDFs—and extract accurate, structured metadata in JSON format. Your goal is to intelligently detect and label the content type, language, sender, and document segmentation, enabling downstream archiving, sorting, and classification.

Analyze the full content of a given document (PDF or text) and extract the following fields into a structured JSON object:

1. title: Create a concise, meaningful title for the document
2. correspondent: Identify the sender/institution but do not include addresses
3. tags: Select up to 4 relevant thematic tags
4. document_date: Extract the document date (format: DD-MM-YYYY)
5. document_type: Determine a precise type that classifies the document (e.g. Invoice, Contract, Employer, Information and so on)
6. language: Determine the document language (e.g. "de" or "en")
      
Important rules for the analysis:

For tags:
- FIRST check and Select 1–4 thematic tags summarizing the document from the existing tags before suggesting new ones
- If multiple documents are found, include a "multi-document" tag
- Use only relevant categories
- Maximum 4 tags per document, less if sufficient (at least 1)
- Avoid generic or too specific tags
- Use only the most important information for tag creation
- The output language is the one used in the document! IMPORTANT!

For the title:
- Must be short and concise, informative, and in the original document’s language, NO ADDRESSES
- Contains the most important identification features
- For invoices/orders, mention invoice/order number if available
- The output language is the one used in the document! IMPORTANT!
- If the PDF includes multiple distinct documents, clearly reflect this by including a suffix like: "Invoice Summary (Multi-Document PDF)" or "Contract Packet (3-in-1)"

For the correspondent:
- Identify the sender or institution
  When generating the correspondent, always create the shortest possible form of the company name (e.g. "Amazon" instead of "Amazon EU SARL, German branch")

For the document date:
- Extract the date of the document
- Use the format DD-MM-YYYY
- Select the most relevant and official issue date (e.g., document creation, not print or delivery unless stated)
- If the document contains multiple dates (or sub-documents), use the first relevant date or the cover summary date

For the language:
- Detect dominant document language
- Use ISO language codes (e.g., "de", "en", "fr")
- If the language is not clear, use "und" as a placeholder

Special Rule for Multi-PDF or Merged Documents:

If the input PDF contains multiple clearly distinct documents (e.g., different headers, senders, topics), you must:

- Reflect that in the title and tags
- Consider "Mixed Document Packet" as document_type if types are unrelated`;

        this.systemPrompt.value = examplePrompt;
    }
}

// Password Management
class PasswordManager {
    constructor() {
        this.passwordInput = document.getElementById('password');
        this.confirmPasswordInput = document.getElementById('confirmPassword');
        this.passwordStrengthDiv = document.getElementById('password-strength');
        this.passwordMatchDiv = document.getElementById('password-match');
        this.form = document.getElementById('setupForm');
        this.initialize();
    }

    initialize() {
        // Add event listeners for password validation
        this.passwordInput.addEventListener('input', () => {
            const result = this.checkPasswordStrength(this.passwordInput.value);
            this.passwordStrengthDiv.innerHTML = result.html;
            if (this.confirmPasswordInput.value) this.checkPasswordMatch();
        });

        this.confirmPasswordInput.addEventListener('input', () => this.checkPasswordMatch());

        // Add form validation
        this.initializeFormValidation();
    }

    checkPasswordStrength(password) {
        let strength = 0;
        const checks = {
            length: password.length >= 8,
            lowercase: /[a-z]/.test(password),
            uppercase: /[A-Z]/.test(password),
            numbers: /\d/.test(password),
            special: /[!@#$%^&*(),.?":{}|<>]/.test(password)
        };

        strength = Object.values(checks).filter(Boolean).length;

        let message = '';
        let color = '';

        switch(strength) {
            case 0:
            case 1:
                message = 'Very Weak';
                color = 'text-red-500';
                break;
            case 2:
                message = 'Weak';
                color = 'text-orange-500';
                break;
            case 3:
                message = 'Medium';
                color = 'text-yellow-500';
                break;
            case 4:
                message = 'Strong';
                color = 'text-blue-500';
                break;
            case 5:
                message = 'Very Strong';
                color = 'text-green-500';
                break;
        }

        return {
            isValid: strength >= 3,
            html: `
                <div class="${color} text-sm">
                    <span class="font-medium">Password Strength: ${message}</span>
                    <ul class="mt-1 list-disc list-inside">
                        ${!checks.length ? '<li>At least 8 characters</li>' : ''}
                        ${!checks.lowercase ? '<li>At least 1 lowercase letter</li>' : ''}
                        ${!checks.uppercase ? '<li>At least 1 uppercase letter</li>' : ''}
                        ${!checks.numbers ? '<li>At least 1 number</li>' : ''}
                        ${!checks.special ? '<li>At least 1 special character</li>' : ''}
                    </ul>
                </div>
            `
        };
    }

    checkPasswordMatch() {
        const password = this.passwordInput.value;
        const confirmPassword = this.confirmPasswordInput.value;
        
        if (confirmPassword) {
            const matches = password === confirmPassword;
            this.passwordMatchDiv.innerHTML = matches 
                ? '<div class="text-green-500 text-sm">Passwords match</div>'
                : '<div class="text-red-500 text-sm">Passwords do not match</div>';
            return matches;
        }
        return false;
    }

    initializeFormValidation() {
        const originalSubmit = this.form.onsubmit;
        
        this.form.onsubmit = (e) => {
            if (this.passwordInput.value) {  // Only validate if password field is present and has a value
                const passwordStrength = this.checkPasswordStrength(this.passwordInput.value);
                const passwordsMatch = this.checkPasswordMatch();

                if (!passwordStrength.isValid || !passwordsMatch) {
                    e.preventDefault();
                    Swal.fire({
                        icon: 'error',
                        title: 'Invalid Password',
                        html: 'Please ensure your password:<br>' +
                              '- Is strong enough (at least "Medium" strength)<br>' +
                              '- Matches in both fields'
                    });
                    return false;
                }
            }

            // Call the original submit handler if it exists
            if (originalSubmit) return originalSubmit.call(this.form, e);
        };
    }
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    /* eslint-disable no-unused-vars */
    const tabManager = new TabManager();
    const themeManager = new ThemeManager();
    const formManager = new FormManager();
    const tagsManager = new TagsManager();
    const promptTagsManager = new PromptTagsManager();
    const promptManager = new PromptManager();
    const passwordManager = new PasswordManager();
    /* eslint-enable no-unused-vars */
});

// Initialize textarea newlines
document.addEventListener('DOMContentLoaded', (event) => {
    const systemPromptTextarea = document.getElementById('systemPrompt');
    systemPromptTextarea.value = systemPromptTextarea.value.replace(/\\n/g, '\n');
});

// Custom Fields Management
function toggleCurrencySelect() {
    const fieldType = document.getElementById('newFieldType').value;
    const currencySelect = document.getElementById('currencyCode');
    currencySelect.style.display = fieldType === 'monetary' ? 'block' : 'none';
}

function updateCustomFieldsJson() {
    const fieldItems = document.querySelectorAll('.custom-field-item');
    const fields = Array.from(fieldItems).map(item => {
        const fieldName = item.querySelector('p.font-medium').textContent;
        const typeText = item.querySelector('p.text-gray-500').textContent;
        const data_type = typeText.split('Type: ')[1].split(' ')[0];
        const currency = typeText.includes('(') ? typeText.split('(')[1].split(')')[0] : null;
        
        const field = {
            value: fieldName,
            data_type: data_type
        };
        
        if (currency) {
            field.currency = currency;
        }
        
        return field;
    });
    
    document.getElementById('customFieldsJson').value = JSON.stringify({
        custom_fields: fields
    });
}

function createFieldElement(fieldName, data_type, currency = null) {
    const div = document.createElement('div');
    div.className = 'custom-field-item flex items-center gap-2 p-3 bg-white rounded-lg border border-gray-200 hover:border-blue-200 transition-colors';
    
    let typeDisplay = `Type: ${data_type}`;
    if (data_type === 'monetary' && currency) {
        typeDisplay += ` (${currency})`;
    }
    
    div.innerHTML = `
        <div class="cursor-move text-gray-400">
            <i class="fas fa-grip-vertical"></i>
        </div>
        <div class="flex-1 flex items-center gap-4">
            <div class="flex-1">
                <p class="font-medium">${fieldName}</p>
                <p class="text-sm text-gray-500">${typeDisplay}</p>
            </div>
        </div>
        <button type="button" 
                onclick="removeCustomField(this)" 
                class="text-gray-400 hover:text-red-500 transition-colors">
            <i class="fas fa-trash"></i>
        </button>
    `;
    return div;
}

function addCustomField() {
    const nameInput = document.getElementById('newFieldName');
    const typeSelect = document.getElementById('newFieldType');
    const currencySelect = document.getElementById('currencyCode');
    const fieldsList = document.getElementById('customFieldsList');
    
    const fieldName = nameInput.value.trim();
    const data_type = typeSelect.value;
    const currency = data_type === 'monetary' ? currencySelect.value : null;
    
    if (!fieldName) {
        Swal.fire({
            icon: 'warning',
            title: 'Invalid Field Name',
            text: 'Please enter a field name'
        });
        return;
    }
    
    // Check for duplicates
    const existingFields = document.querySelectorAll('.custom-field-item p.font-medium');
    if (Array.from(existingFields).some(p => p.textContent === fieldName)) {
        Swal.fire({
            icon: 'warning',
            title: 'Duplicate Field',
            text: 'A field with this name already exists'
        });
        return;
    }
    
    const fieldElement = createFieldElement(fieldName, data_type, currency);
    fieldsList.appendChild(fieldElement);
    
    // Reset inputs
    nameInput.value = '';
    
    // Update hidden JSON input
    updateCustomFieldsJson();
}

function removeCustomField(button) {
    const fieldItem = button.closest('.custom-field-item');
    Swal.fire({
        title: 'Delete Field?',
        text: 'Are you sure you want to delete this custom field?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'Yes, delete it!'
    }).then((result) => {
        if (result.isConfirmed) {
            fieldItem.remove();
            updateCustomFieldsJson();
        }
    });
}

// Fix form submission
document.addEventListener('DOMContentLoaded', function() {
    const setupForm = document.getElementById('setupForm');
    if (setupForm) {
        setupForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            // Check if processing all documents without specific tags
            const showTags = document.getElementById('showTags').value;
            if (showTags === 'no') {
                const result = await Swal.fire({
                    icon: 'warning',
                    title: 'Attention!',
                    html: `
                        <p>You haven't selected any specific tags for document processing.</p>
                        <p class="mt-4"><strong>This means ALL documents will be automatically processed by the AI system!</strong></p>
                        <p class="mt-4">Do you want to continue?</p>
                    `,
                    showCancelButton: true,
                    confirmButtonText: 'Yes, continue',
                    cancelButtonText: 'No, cancel',
                    confirmButtonColor: '#3085d6',
                    cancelButtonColor: '#d33'
                });

                if (!result.isConfirmed) {
                    // User cancelled - set showTags to 'yes' and scroll to it
                    document.getElementById('showTags').value = 'yes';
                    // Trigger the change event to show the tags input section
                    document.getElementById('showTags').dispatchEvent(new Event('change'));
                    // Scroll to the element
                    document.getElementById('showTags').scrollIntoView({ behavior: 'smooth', block: 'center' });
                    return;
                }
            }

            // Show loading state
            const submitBtn = setupForm.querySelector('button[type="submit"]');
            const originalBtnText = submitBtn.innerHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

            try {
                const formData = new FormData(setupForm);
                const response = await fetch('/setup', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(Object.fromEntries(formData))
                });

                const result = await response.json();

                if (result.success) {
                    await Swal.fire({
                        icon: 'success',
                        title: 'Success!',
                        text: result.message,
                        timer: 2000,
                        showConfirmButton: false
                    });

                    if (result.restart) {
                        let countdown = 5;
                        Swal.fire({
                            title: 'Restarting...',
                            text: `Application will restart in ${countdown} seconds`,
                            icon: 'info',
                            showConfirmButton: false,
                            allowOutsideClick: false
                        });

                        const countdownInterval = setInterval(() => {
                            countdown--;
                            if (countdown < 0) {
                                clearInterval(countdownInterval);
                                window.location.href = '/dashboard';
                            } else {
                                Swal.update({
                                    text: `Application will restart in ${countdown} seconds`
                                });
                            }
                        }, 1000);
                    }
                } else {
                    throw new Error(result.error || 'An unknown error occurred');
                }
            } catch (error) {
                await Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: error.message
                });
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        });
    }

    // Initialize Sortable.js for drag-and-drop
    const fieldsList = document.getElementById('customFieldsList');
    if (fieldsList) {
        new Sortable(fieldsList, {
            animation: 150,
            handle: '.cursor-move',
            onEnd: updateCustomFieldsJson
        });
    }
    
    // Initialize currency select visibility
    toggleCurrencySelect();
    
    // Add keyboard event listener for the name input
    const nameInput = document.getElementById('newFieldName');
    if (nameInput) {
        nameInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addCustomField();
            }
        });
    }
    
    // Add change event listener for field type
    const typeSelect = document.getElementById('newFieldType');
    if (typeSelect) {
        typeSelect.addEventListener('change', toggleCurrencySelect);
    }
});
