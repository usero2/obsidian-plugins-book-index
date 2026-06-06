const obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
    ruleHeadings: true,
    ruleBoldItalic: true,
    ruleCodeBlocks: true,
    linkColumns: 1
}

// Function to escape string for regex
function escapeRegex(string) {
    return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// Function to get line number from character index
function getLineNumber(text, index) {
    let line = 0;
    for (let i = 0; i < index; i++) {
        if (text[i] === '\n') line++;
    }
    return line;
}

class BookIndexPlugin extends obsidian.Plugin {
    async onload() {
        await this.loadSettings();
        this.addSettingTab(new BookIndexSettingTab(this.app, this));
        this.registerMarkdownCodeBlockProcessor("book-index", this.processBookIndex.bind(this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async processBookIndex(source, el, ctx) {
        const container = el.createEl("div", { cls: "book-index-container" });
        
        // Add search filter input
        const searchInput = container.createEl("input", {
            type: "text",
            placeholder: "Search index...",
            cls: "book-index-search"
        });
        
        const resultsContainer = container.createEl("div", { cls: "book-index-results" });
        resultsContainer.createEl("div", { text: "Loading index...", cls: "book-index-loading" });

        const manualWords = source.split("\n").map(w => w.trim()).filter(w => w.length > 0);
        const files = this.app.vault.getMarkdownFiles();
        const currentFilePath = ctx.sourcePath;

        // Results map: lowerWord -> { displayWord, files: Map<path, {file, score}> }
        const results = new Map();

        const addMatch = (word, file, score, lineNumber) => {
            const lower = word.toLowerCase();
            if (!results.has(lower)) {
                results.set(lower, { displayWord: word, files: new Map() });
            }
            const entry = results.get(lower);
            const currentScore = entry.files.get(file.path)?.score || 0;
            if (score > currentScore || !entry.files.has(file.path)) {
                entry.files.set(file.path, { file, score, lineNumber });
            }
        };

        for (const file of files) {
            let content = await this.app.vault.cachedRead(file);
            // Remove book-index blocks from content so it doesn't match its own definitions
            content = content.replace(/```book-index[\s\S]*?```/g, '');
            // Remove URLs to avoid extracting formatting characters inside them (like underscores)
            content = content.replace(/https?:\/\/[^\s\)<>"]+/g, '');
            
            const lowerContent = content.toLowerCase();

            // 1. Auto-extract Headings
            if (this.settings.ruleHeadings) {
                const headingRegex = /^#{1,6}\s+([^\n]+)$/gm;
                let match;
                while ((match = headingRegex.exec(content)) !== null) {
                    const text = match[1].trim();
                    // Limit length to avoid huge index terms
                    if (text.length > 0 && text.length < 100) addMatch(text, file, 50, getLineNumber(content, match.index));
                }
            }

            // 2. Auto-extract Bold/Italic
            if (this.settings.ruleBoldItalic) {
                const boldItalicRegex = /(\*\*|__)([^\n]+?)\1|(\*|_)([^\n]+?)\3/g;
                let match;
                while ((match = boldItalicRegex.exec(content)) !== null) {
                    const text = (match[2] || match[4]).trim();
                    if (text.length > 0 && text.length < 80) addMatch(text, file, 30, getLineNumber(content, match.index));
                }
            }

            // 3. Auto-extract Code blocks
            if (this.settings.ruleCodeBlocks) {
                const codeRegex = /(`{1,3})([^\n]+?)\1/g;
                let match;
                while ((match = codeRegex.exec(content)) !== null) {
                    const text = match[2].trim();
                    if (text.length > 0 && text.length < 80) addMatch(text, file, 20, getLineNumber(content, match.index));
                }
            }

            // 4. Match Manual Words
            for (const word of manualWords) {
                const lowerWord = word.toLowerCase();
                const idx = lowerContent.indexOf(lowerWord);
                if (idx !== -1) {
                    let score = 1; // Base score
                    let matchIndex = idx;

                    if (this.settings.ruleHeadings) {
                        const hr = new RegExp(`^#{1,6}\\s+.*${escapeRegex(word)}.*$`, 'gim');
                        const m = hr.exec(content);
                        if (m) { score += 50; matchIndex = m.index; }
                    }
                    if (score === 1 && this.settings.ruleBoldItalic) {
                        const br = new RegExp(`(\\*\\*|__)[^\\*\\n]*?${escapeRegex(word)}.*?\\1|(\\*|_)[^\\*\\n]*?${escapeRegex(word)}.*?\\2`, 'gim');
                        const m = br.exec(content);
                        if (m) { score += 30; matchIndex = m.index; }
                    }
                    if (score === 1 && this.settings.ruleCodeBlocks) {
                        const cr = new RegExp(`(\`\`\`)[\\s\\S]*?${escapeRegex(word)}[\\s\\S]*?\\1|(\`)[^\`\\n]*?${escapeRegex(word)}.*?\\2`, 'gim');
                        const m = cr.exec(content);
                        if (m) { score += 20; matchIndex = m.index; }
                    }

                    addMatch(word, file, score, getLineNumber(content, matchIndex));
                }
            }
        }

        // Render
        resultsContainer.empty();
        
        if (results.size === 0) {
            resultsContainer.createEl("div", { text: "No index terms found." });
            return;
        }

        const grouped = {};
        for (const [lower, entry] of results.entries()) {
            const displayWord = entry.displayWord;
            const firstLetter = displayWord.charAt(0).toUpperCase();
            if (!grouped[firstLetter]) {
                grouped[firstLetter] = [];
            }
            grouped[firstLetter].push(entry);
        }

        const sortedLetters = Object.keys(grouped).sort();

        for (const letter of sortedLetters) {
            const letterGroup = resultsContainer.createEl("div", { cls: "book-index-group" });
            letterGroup.createEl("h3", { text: letter, cls: "book-index-letter" });
            
            const entriesInGroup = grouped[letter].sort((a, b) => a.displayWord.toLowerCase().localeCompare(b.displayWord.toLowerCase()));
            
            for (const entry of entriesInGroup) {
                const wordRow = letterGroup.createEl("div", { cls: "book-index-row" });
                wordRow.createEl("span", { text: entry.displayWord, cls: "book-index-word" });
                
                const leader = wordRow.createEl("span", { cls: "book-index-leader" });
                const linksContainer = wordRow.createEl("span", { cls: "book-index-links" });
                
                // Sort matched files by score descending
                const matchedFiles = Array.from(entry.files.values()).sort((a, b) => b.score - a.score);
                
                // Dynamically set columns so it right-aligns properly if there are fewer links than the setting
                const actualCols = Math.max(1, Math.min(matchedFiles.length, this.settings.linkColumns));
                linksContainer.style.setProperty('--link-cols', actualCols);
                
                matchedFiles.forEach((matchData) => {
                    const file = matchData.file;
                    const linkEl = linksContainer.createEl("a", { 
                        text: file.basename,
                        cls: "internal-link book-index-link",
                        href: file.path 
                    });
                    
                    linkEl.onclick = async (e) => {
                        e.preventDefault();
                        const newLeaf = e.ctrlKey || e.metaKey;
                        const leaf = this.app.workspace.getLeaf(newLeaf);
                        await leaf.openFile(file, { eState: { line: matchData.lineNumber } });
                    };
                });
            }
        }

        // Search filter logic
        searchInput.oninput = (e) => {
            const query = e.target.value.toLowerCase();
            const groups = resultsContainer.querySelectorAll('.book-index-group');
            
            groups.forEach(group => {
                const rows = group.querySelectorAll('.book-index-row');
                let hasVisibleRow = false;
                
                rows.forEach(row => {
                    const wordEl = row.querySelector('.book-index-word');
                    if (wordEl && wordEl.textContent.toLowerCase().includes(query)) {
                        row.style.display = '';
                        hasVisibleRow = true;
                    } else {
                        row.style.display = 'none';
                    }
                });
                
                group.style.display = hasVisibleRow ? '' : 'none';
            });
        };
    }
}

class BookIndexSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const {containerEl} = this;
        containerEl.empty();

        containerEl.createEl('h2', {text: 'Book Index Settings'});
        containerEl.createEl('p', {text: 'Configure the rules used to automatically extract index terms and calculate file relevance.'});

        new obsidian.Setting(containerEl)
            .setName('Headings Rule (#, ##, ###)')
            .setDesc('Automatically add headings to the index. Gives highest weight (+50).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.ruleHeadings)
                .onChange(async (value) => {
                    this.plugin.settings.ruleHeadings = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Bold/Italic Rule (**word**, *word*)')
            .setDesc('Automatically add bold/italic text to the index. Gives medium weight (+30).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.ruleBoldItalic)
                .onChange(async (value) => {
                    this.plugin.settings.ruleBoldItalic = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Code Blocks Rule (`word`, ```word```)')
            .setDesc('Automatically add inline code and one-line code blocks to the index. Gives base weight (+20).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.ruleCodeBlocks)
                .onChange(async (value) => {
                    this.plugin.settings.ruleCodeBlocks = value;
                    await this.plugin.saveSettings();
                }));

        new obsidian.Setting(containerEl)
            .setName('Number of Link Columns')
            .setDesc('Choose how many columns to display for the links on the right side.')
            .addDropdown(dropdown => dropdown
                .addOption('1', '1 Column')
                .addOption('2', '2 Columns')
                .addOption('3', '3 Columns')
                .addOption('4', '4 Columns')
                .setValue(this.plugin.settings.linkColumns.toString())
                .onChange(async (value) => {
                    this.plugin.settings.linkColumns = parseInt(value, 10);
                    await this.plugin.saveSettings();
                }));
    }
}

module.exports = BookIndexPlugin;
