const fs = require('fs');
const path = require('path');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function ensureDir(absPath) {
  fs.mkdirSync(absPath, { recursive: true });
}

function readJson(absPath, fallback) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(absPath, value) {
  ensureDir(path.dirname(absPath));
  fs.writeFileSync(absPath, JSON.stringify(value, null, 2), 'utf8');
}

function getOntologyPaths(dataDir) {
  const root = path.join(dataDir, 'skill_cache', 'ontology');
  return {
    root,
    graphFile: path.join(root, 'graph.json'),
    schemaFile: path.join(root, 'schema.json')
  };
}

function buildDefaultSchema() {
  return {
    types: {
      Note: {
        description: 'Generic note or knowledge entity',
        properties: {
          title: 'string',
          summary: 'string',
          tags: 'array<string>'
        }
      },
      Person: {
        description: 'Person profile entity',
        properties: {
          name: 'string',
          role: 'string',
          status: 'string'
        }
      },
      Task: {
        description: 'Task or work item',
        properties: {
          title: 'string',
          status: 'string',
          priority: 'string'
        }
      }
    },
    relations: {
      related_to: {
        from: '*',
        to: '*',
        description: 'Generic relation between two entities'
      },
      assigned_to: {
        from: 'Task',
        to: 'Person',
        description: 'Task owner relation'
      }
    }
  };
}

function ensureSchema(paths) {
  const fallback = buildDefaultSchema();
  const current = readJson(paths.schemaFile, null);
  if (current && typeof current === 'object') {
    if (!current.types || typeof current.types !== 'object') current.types = {};
    if (!current.relations || typeof current.relations !== 'object') current.relations = {};
    return { schema: current, created: false };
  }
  writeJson(paths.schemaFile, fallback);
  return { schema: fallback, created: true };
}

function ensureState(dataDir) {
  const paths = getOntologyPaths(dataDir);
  const state = readJson(paths.graphFile, { entities: [], relations: [] });
  if (!Array.isArray(state.entities)) state.entities = [];
  if (!Array.isArray(state.relations)) state.relations = [];
  return { paths, state };
}

function saveState(paths, state) {
  writeJson(paths.graphFile, state);
}

function listEntities(state, type = '') {
  const normalizedType = normalizeText(type);
  return state.entities.filter((entity) => !normalizedType || normalizeText(entity.type) === normalizedType);
}

function formatEntities(items = []) {
  if (!items.length) return 'No entities.';
  return items.map((entity, index) => `${index + 1}. ${normalizeText(entity.id)} [${normalizeText(entity.type)}] ${JSON.stringify(entity.properties || {})}`).join('\n');
}

function mutateOntology(dataDir, args = {}) {
  const action = normalizeText(args.action).toLowerCase();
  if (!action) return 'Missing action.';

  const { paths, state } = ensureState(dataDir);

  if (action === 'create') {
    const type = normalizeText(args.type);
    if (!type) return 'Missing type.';
    const id = normalizeText(args.id) || `${type.toLowerCase()}_${Date.now()}`;
    const entity = {
      id,
      type,
      properties: args.props && typeof args.props === 'object' ? { ...args.props } : {}
    };
    state.entities.push(entity);
    saveState(paths, state);
    return JSON.stringify(entity, null, 2);
  }

  if (action === 'get') {
    const id = normalizeText(args.id);
    if (!id) return 'Missing id.';
    const entity = state.entities.find((item) => normalizeText(item.id) === id);
    if (!entity) return `Entity not found: ${id}`;
    return JSON.stringify(entity, null, 2);
  }

  if (action === 'delete') {
    const id = normalizeText(args.id);
    if (!id) return 'Missing id.';
    state.entities = state.entities.filter((item) => normalizeText(item.id) !== id);
    state.relations = state.relations.filter((item) => normalizeText(item.from_id) !== id && normalizeText(item.to_id) !== id);
    saveState(paths, state);
    return `deleted: ${id}`;
  }

  if (action === 'list') {
    return formatEntities(listEntities(state, args.type));
  }

  if (action === 'query') {
    const items = listEntities(state, args.type).filter((entity) => {
      const where = args.where && typeof args.where === 'object' ? args.where : {};
      return Object.entries(where).every(([key, value]) => String(entity.properties?.[key]) === String(value));
    });
    return formatEntities(items);
  }

  if (action === 'update') {
    const id = normalizeText(args.id);
    if (!id) return 'Missing id.';
    const entity = state.entities.find((item) => normalizeText(item.id) === id);
    if (!entity) return `Entity not found: ${id}`;
    entity.properties = {
      ...(entity.properties || {}),
      ...(args.props && typeof args.props === 'object' ? args.props : {})
    };
    saveState(paths, state);
    return JSON.stringify(entity, null, 2);
  }

  if (action === 'relate') {
    const fromId = normalizeText(args.from_id ?? args.from);
    const rel = normalizeText(args.rel);
    const toId = normalizeText(args.to_id ?? args.to);
    if (!fromId || !rel || !toId) return 'Missing from_id, rel, or to_id.';
    const relation = {
      from_id: fromId,
      rel,
      to_id: toId,
      properties: args.props && typeof args.props === 'object' ? { ...args.props } : {}
    };
    state.relations.push(relation);
    saveState(paths, state);
    return JSON.stringify(relation, null, 2);
  }

  if (action === 'related') {
    const id = normalizeText(args.id);
    if (!id) return 'Missing id.';
    const rel = normalizeText(args.rel);
    const dir = normalizeText(args.dir || 'both').toLowerCase();
    const items = state.relations.filter((item) => {
      const relMatch = !rel || normalizeText(item.rel) === rel;
      if (!relMatch) return false;
      if (dir === 'outgoing') return normalizeText(item.from_id) === id;
      if (dir === 'incoming') return normalizeText(item.to_id) === id;
      return normalizeText(item.from_id) === id || normalizeText(item.to_id) === id;
    });
    if (!items.length) return 'No relations.';
    return items.map((item, index) => `${index + 1}. ${item.from_id} -[${item.rel}]-> ${item.to_id}`).join('\n');
  }

  if (action === 'validate') {
    const { schema, created } = ensureSchema(paths);
    return created
      ? `schema: ok (initialized default schema with ${Object.keys(schema.types || {}).length} types)`
      : 'schema: ok';
  }

  if (action === 'schema-append') {
    const schema = ensureSchema(paths).schema;
    const data = args.data || args.schema || null;
    if (!data || typeof data !== 'object') return 'Missing data.';
    if (data.types && typeof data.types === 'object') {
      schema.types = { ...(schema.types || {}), ...data.types };
    }
    if (data.relations && typeof data.relations === 'object') {
      schema.relations = { ...(schema.relations || {}), ...data.relations };
    }
    writeJson(paths.schemaFile, schema);
    return JSON.stringify(schema, null, 2);
  }

  return 'Unsupported action.';
}

module.exports = {
  mutateOntology
};
