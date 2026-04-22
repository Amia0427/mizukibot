const fs = require('fs');
const path = require('path');

let recipeCache = null;

function normalizeText(value = '') {
  return String(value || '').trim();
}

function findHowToCookDataFile() {
  const explicit = normalizeText(process.env.HOWTOCOOK_MCP_DATA_FILE);
  const candidates = [
    explicit,
    path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx')
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const stat = fs.statSync(candidate);
      if (stat.isFile() && path.basename(candidate).toLowerCase() === 'all_recipes.json') {
        return candidate;
      }
      if (!stat.isDirectory()) continue;

      const stack = [candidate];
      while (stack.length > 0) {
        const current = stack.pop();
        let entries = [];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_) {
          continue;
        }
        for (const entry of entries) {
          const abs = path.join(current, entry.name);
          if (entry.isDirectory()) {
            stack.push(abs);
            continue;
          }
          if (
            entry.isFile()
            && entry.name === 'all_recipes.json'
            && abs.toLowerCase().includes(`${path.sep}howtocook-mcp${path.sep}`)
          ) {
            return abs;
          }
        }
      }
    } catch (_) {}
  }

  return '';
}

function loadHowToCookRecipes() {
  if (recipeCache) return recipeCache;

  const dataFile = findHowToCookDataFile();
  if (!dataFile) {
    recipeCache = {
      dataFile: '',
      recipes: []
    };
    return recipeCache;
  }

  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    recipeCache = {
      dataFile,
      recipes: Array.isArray(parsed) ? parsed : []
    };
  } catch (_) {
    recipeCache = {
      dataFile,
      recipes: []
    };
  }
  return recipeCache;
}

function searchRecipes(args = {}) {
  const query = normalizeText(args.query);
  if (!query) return 'Missing query.';

  const limit = Math.max(1, Math.min(10, Number(args.limit) || 5));
  const { dataFile, recipes } = loadHowToCookRecipes();
  if (!recipes.length) {
    return dataFile
      ? `HowToCook recipe cache is unreadable: ${dataFile}`
      : 'HowToCook recipe cache not found on this machine.';
  }

  const normalizedQuery = query.toLowerCase();
  const scored = recipes.map((recipe) => {
    const name = normalizeText(recipe.name);
    const description = normalizeText(recipe.description);
    const category = normalizeText(recipe.category);
    const tags = Array.isArray(recipe.tags) ? recipe.tags.map((item) => normalizeText(item)).filter(Boolean) : [];
    const ingredientNames = Array.isArray(recipe.ingredients)
      ? recipe.ingredients.map((item) => normalizeText(item?.name || item?.text_quantity || '')).filter(Boolean)
      : [];
    const haystack = [
      name,
      description,
      category,
      normalizeText(recipe.source_path),
      tags.join(' '),
      ingredientNames.join(' ')
    ].join('\n').toLowerCase();

    let score = 0;
    if (name.toLowerCase().includes(normalizedQuery)) score += 8;
    if (category.toLowerCase().includes(normalizedQuery)) score += 4;
    if (tags.some((item) => item.toLowerCase().includes(normalizedQuery))) score += 3;
    if (ingredientNames.some((item) => item.toLowerCase().includes(normalizedQuery))) score += 2;
    if (description.toLowerCase().includes(normalizedQuery)) score += 1;
    if (!haystack.includes(normalizedQuery)) score = 0;

    return { recipe, score };
  }).filter((item) => item.score > 0);

  if (!scored.length) return `No recipes found for: ${query}`;

  scored.sort((a, b) => b.score - a.score || normalizeText(a.recipe.name).localeCompare(normalizeText(b.recipe.name), 'zh-Hans-CN'));

  const lines = [`HowToCook recipes for "${query}":`];
  for (const item of scored.slice(0, limit)) {
    const recipe = item.recipe || {};
    const ingredients = Array.isArray(recipe.ingredients)
      ? recipe.ingredients.slice(0, 5).map((ing) => normalizeText(ing?.name || ing?.text_quantity || '')).filter(Boolean)
      : [];
    lines.push(`${lines.length}. ${normalizeText(recipe.name)}`);
    if (normalizeText(recipe.category)) lines.push(`   category: ${normalizeText(recipe.category)}`);
    if (Number.isFinite(Number(recipe.difficulty))) lines.push(`   difficulty: ${Number(recipe.difficulty)}`);
    if (ingredients.length) lines.push(`   ingredients: ${ingredients.join(' / ')}`);
    if (normalizeText(recipe.source_path)) lines.push(`   source: ${normalizeText(recipe.source_path)}`);
    const desc = normalizeText(recipe.description).replace(/\s+/g, ' ');
    if (desc) lines.push(`   summary: ${desc.slice(0, 220)}${desc.length > 220 ? '...' : ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  findHowToCookDataFile,
  loadHowToCookRecipes,
  searchRecipes
};
