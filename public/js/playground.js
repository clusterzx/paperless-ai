// Theme Management für Playground
class ThemeManager {
  constructor() {
    this.themeToggle = document.getElementById('themeToggle');
    this.initialize();
  }

  initialize() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    this.setTheme(savedTheme);

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
  }
}

// Search & Sort Functionality
class DocumentManager {
  constructor() {
    this.searchInput = document.getElementById('searchInput');
    this.sortSelect = document.getElementById('sortSelect');
    this.documentsGrid = document.getElementById('documentsGrid');
    this.initialize();
  }

  initialize() {
    // Search Event Listener
    this.searchInput.addEventListener('input', (e) => this.handleSearch(e));

    // Sort Event Listener
    this.sortSelect.addEventListener('change', (e) => this.handleSort(e));
  }

  handleSearch(e) {
    const searchTerm = e.target.value.toLowerCase();
    const cards = document.querySelectorAll('.document-card');

    cards.forEach((card) => {
      const title = card.querySelector('.card-title').textContent.toLowerCase();
      card.style.display = title.includes(searchTerm) ? '' : 'none';
    });
  }

  handleSort(e) {
    const cards = Array.from(this.documentsGrid.children);

    cards.sort((a, b) => {
      const titleA = a.querySelector('.card-title').textContent;
      const titleB = b.querySelector('.card-title').textContent;
      const dateA = new Date(a.querySelector('.card-date').dataset.created);
      const dateB = new Date(b.querySelector('.card-date').dataset.created);

      switch (e.target.value) {
        case 'title_asc':
          return titleA.localeCompare(titleB);
        case 'title_desc':
          return titleB.localeCompare(titleA);
        case 'created_asc':
          return dateA - dateB;
        case 'created_desc':
          return dateB - dateA;
        default:
          return 0;
      }
    });

    cards.forEach((card) => this.documentsGrid.appendChild(card));
  }
}

// Initialize everything when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.themeManager = new ThemeManager();
  window.documentManager = new DocumentManager();
});
