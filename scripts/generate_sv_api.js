#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const OPENAPI_URL =
  'https://raw.githubusercontent.com/OrderlyNetwork/documentation-public/refs/heads/main/sv.openapi.yaml';
const OUTPUT_FILE = path.join(projectRoot, 'src', 'data', 'sv-api.json');

async function downloadSpec() {
  console.log(`Downloading SV OpenAPI spec from ${OPENAPI_URL}...`);
  const response = await fetch(OPENAPI_URL);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const content = await response.text();
  console.log(`  Downloaded ${content.length} characters`);
  return content;
}

function parseSpec(yamlContent) {
  console.log('Parsing OpenAPI specification...');
  const spec = YAML.parse(yamlContent);
  console.log(`  Parsed spec with ${Object.keys(spec.paths || {}).length} paths`);
  return spec;
}

function resolveRef(spec, ref) {
  if (!ref || !ref.startsWith('#/')) return ref;
  const path = ref.replace('#/', '').split('/');
  let current = spec;
  for (const key of path) {
    if (current && typeof current === 'object' && key in current) {
      current = current[key];
    } else {
      return ref;
    }
  }
  return current;
}

function deepResolveRefs(spec, obj, visited = new Set()) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.$ref) {
    if (visited.has(obj.$ref)) {
      return { $ref: obj.$ref };
    }
    visited.add(obj.$ref);
    const resolved = resolveRef(spec, obj.$ref);
    if (resolved !== obj.$ref) {
      const { $ref, ...rest } = obj;
      return { ...deepResolveRefs(spec, resolved, visited), ...rest };
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => deepResolveRefs(spec, item, visited));
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = deepResolveRefs(spec, value, visited);
  }
  return result;
}

function extractEndpoints(spec) {
  const endpoints = [];
  const paths = spec.paths || {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, details] of Object.entries(methods)) {
      if (typeof details !== 'object' || !details.summary) continue;

      const endpoint = {
        path,
        method: method.toUpperCase(),
        summary: details.summary || '',
        description: (details.description || '').replace(/\*\*Limit:.*?\*\*/g, '').replace(/`/g, '').trim(),
        tags: details.tags || [],
        parameters: extractParameters(details, spec),
        responses: extractResponses(details, spec),
        example: generateExample(path, method.toUpperCase(), details),
      };

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

function extractParameters(details, spec) {
  const params = [];
  const paramNames = new Set();

  if (details.parameters) {
    for (const param of details.parameters) {
      let resolvedParam = param;
      if (param.$ref) {
        resolvedParam = resolveRef(spec, param.$ref);
        if (!resolvedParam || resolvedParam === param.$ref) continue;
      }
      if (paramNames.has(resolvedParam.name)) continue;
      paramNames.add(resolvedParam.name);

      params.push({
        name: resolvedParam.name,
        in: resolvedParam.in,
        type: resolvedParam.schema?.type || 'string',
        required: resolvedParam.required || false,
        description: resolvedParam.description || '',
        example: resolvedParam.schema?.example || resolvedParam.example || null,
      });
    }
  }

  return params;
}

function extractResponses(details, spec) {
  if (!details.responses) return [];
  return Object.entries(details.responses).map(([code, resp]) => {
    let schema = resp.content?.['application/json']?.schema;
    if (schema) {
      schema = deepResolveRefs(spec, schema);
    }
    return {
      code: parseInt(code),
      description: resp.description || '',
      schema: schema ? JSON.stringify(schema, null, 2) : null,
    };
  });
}

function generateExample(path, method, _details) {
  return `const url = 'https://api.orderly.org${path}';
fetch(url).then(res => res.json()).then(console.log);`;
}

function extractSchemas(spec) {
  const schemas = [];
  const components = spec.components?.schemas || {};

  for (const [name, schema] of Object.entries(components)) {
    const resolvedSchema = deepResolveRefs(spec, schema);
    schemas.push({
      name,
      description: resolvedSchema.description || '',
      type: resolvedSchema.type || 'object',
      properties: resolvedSchema.properties
        ? Object.entries(resolvedSchema.properties).map(([propName, prop]) => ({
            name: propName,
            type: prop.type || prop.$ref ? 'object' : 'unknown',
            description: prop.description || '',
            required: (resolvedSchema.required || []).includes(propName),
            example: prop.example || null,
            enum: prop.enum || null,
            format: prop.format || null,
          }))
        : null,
      required: resolvedSchema.required || [],
    });
  }

  return schemas;
}

function processSpec(spec) {
  console.log('Extracting Strategy Vault API documentation...');
  const endpoints = extractEndpoints(spec);
  console.log(`  Extracted ${endpoints.length} endpoints`);
  const schemas = extractSchemas(spec);
  console.log(`  Extracted ${schemas.length} schemas`);

  const categories = [
    {
      name: 'Strategy Vault Info',
      description: 'Information about strategy vaults, their performance, and overall statistics.',
      endpoints: endpoints.filter((e) => e.path.startsWith('/v1/public/strategy_vault/vault/')),
    },
    {
      name: 'Strategy Provider',
      description: 'Endpoints for strategy providers to manage their strategies and view earnings.',
      endpoints: endpoints.filter((e) => e.path.includes('/sp/')),
    },
    {
      name: 'Fund Management',
      description: 'Fund-level information including period history and pending transactions.',
      endpoints: endpoints.filter((e) => e.path.includes('/fund/')),
    },
    {
      name: 'Liquidity Provider',
      description: 'Liquidity provider information, performance, fees, and claim status.',
      endpoints: endpoints.filter((e) => e.path.includes('/lp/')),
    },
    {
      name: 'User',
      description: 'User-level overview statistics across all strategy vaults.',
      endpoints: endpoints.filter((e) => e.path.includes('/user/')),
    },
  ];

  return {
    version: spec.info?.version || '1.0.0',
    title: 'Orderly Strategy Vault API',
    description: 'Strategy Vault is a yield optimization layer on top of Orderly Network. It allows strategy providers to create and manage automated trading strategies, while liquidity providers can allocate capital to these vaults to earn yields.',
    baseUrl: 'https://api.orderly.org',
    categories: categories.filter((c) => c.endpoints.length > 0),
    endpoints,
    schemas,
    commonErrors: [
      { code: 400, message: 'Bad Request', description: 'Invalid request parameters' },
      { code: 404, message: 'Not Found', description: 'Resource does not exist' },
      { code: 429, message: 'Too Many Requests', description: 'Rate limit exceeded (10 req/s per IP)' },
      { code: 500, message: 'Internal Server Error', description: 'Server error' },
    ],
  };
}

async function main() {
  console.log('Orderly Strategy Vault API Documentation Generator\n');

  try {
    const yamlContent = await downloadSpec();
    const spec = parseSpec(yamlContent);
    const apiData = processSpec(spec);

    const output = {
      ...apiData,
      metadata: {
        generatedAt: new Date().toISOString(),
        source: OPENAPI_URL,
        version: apiData.version,
        totalEndpoints: apiData.endpoints.length,
        totalSchemas: apiData.schemas.length,
      },
    };

    console.log(`Saving to ${OUTPUT_FILE}...`);
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

    console.log('\nGenerated successfully!');
    console.log(`  Endpoints: ${output.endpoints.length}`);
    console.log(`  Categories: ${output.categories.length}`);
    console.log(`  Schemas: ${output.schemas.length}`);
    console.log(`  File: ${OUTPUT_FILE}\n`);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();
