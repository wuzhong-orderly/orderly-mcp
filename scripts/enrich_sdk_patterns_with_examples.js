#!/usr/bin/env node

/**
 * enrich_sdk_patterns_with_examples.js
 *
 * This script merges the example-dex analysis into the SDK patterns data,
 * adding real-world code examples for charts, components, and DEX patterns.
 *
 * INCREMENTAL MODE (default):
 *   Reads existing sdk-patterns.json's _enrichedFingerprints map and skips
 *   items whose source content hasn't changed. Only new/changed items are
 *   sent to the AI. Checkpoint after every item (crash-safe).
 *
 * FORCE MODE:
 *   FORCE=true node scripts/enrich_sdk_patterns_with_examples.js
 *   Re-processes every item from scratch (pays for full regeneration).
 *
 * Usage:
 *   node scripts/enrich_sdk_patterns_with_examples.js
 *   USE_AI=true node scripts/enrich_sdk_patterns_with_examples.js  # AI-enhanced mode
 *   FORCE=true USE_AI=true node scripts/enrich_sdk_patterns_with_examples.js
 *
 * Prerequisites:
 *   - example_dex_analysis.json from analyze_example_dex.js
 *   - src/data/sdk-patterns.json exists
 *   - (AI mode) NEAR_AI_API_KEY in .env
 *
 * Output:
 *   - Updates src/data/sdk-patterns.json with example-dex patterns
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

dotenv.config();

const EXAMPLE_DEX_ANALYSIS = path.join(projectRoot, 'example_dex_analysis.json');
const SDK_PATTERNS_FILE = path.join(projectRoot, 'src/data/sdk-patterns.json');

const USE_AI = process.env.USE_AI === 'true';
const FORCE = process.env.FORCE === 'true';

console.log('🚀 Enriching SDK patterns with example-dex code...\n');

if (USE_AI) {
  console.log('🤖 AI-Enhanced Mode Enabled\n');
  console.log('This will use AI to analyze code and generate comprehensive,');
  console.log('educational SDK patterns with intelligent analysis.\n');
}

// Check input files exist
if (!fs.existsSync(EXAMPLE_DEX_ANALYSIS)) {
  console.error(`❌ Missing: ${EXAMPLE_DEX_ANALYSIS}`);
  console.error('   Run: node scripts/analyze_example_dex.js');
  process.exit(1);
}

if (!fs.existsSync(SDK_PATTERNS_FILE)) {
  console.error(`❌ Missing: ${SDK_PATTERNS_FILE}`);
  console.error('   Run: node scripts/analyze_sdk.js first');
  process.exit(1);
}

// Check AI prerequisites if in AI mode
let openai = null;
let NEAR_AI_MODEL = null;

if (USE_AI) {
  if (!process.env.NEAR_AI_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error('❌ Missing API key for AI mode');
    console.error('   Set NEAR_AI_API_KEY in .env file');
    process.exit(1);
  }

  const { default: OpenAI } = await import('openai');
  openai = new OpenAI({
    baseURL: 'https://cloud-api.near.ai/v1',
    apiKey: process.env.NEAR_AI_API_KEY || process.env.OPENAI_API_KEY,
    timeout: parseInt(process.env.NEAR_AI_TIMEOUT_MS || String(30 * 60 * 1000), 10),
    maxRetries: 0,
  });
  NEAR_AI_MODEL = 'qwen/qwen3.7-max';
}

// Read input data
console.log('📖 Reading analysis files...');
const exampleDexData = JSON.parse(fs.readFileSync(EXAMPLE_DEX_ANALYSIS, 'utf-8'));
const sdkPatterns = JSON.parse(fs.readFileSync(SDK_PATTERNS_FILE, 'utf-8'));
console.log(`   Example DEX patterns: ${exampleDexData.patterns.length}`);
console.log(`   Current SDK categories: ${sdkPatterns.categories.length}`);
console.log(`   Mode: ${FORCE ? 'FORCE (full regen)' : 'INCREMENTAL (cache-aware)'}\n`);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Find or create category
function findOrCreateCategory(categories, name) {
  let category = categories.find((c) => c.name === name);
  if (!category) {
    category = { name, patterns: [] };
    categories.push(category);
  }
  return category;
}

// ---------------------------------------------------------------------------
// Caching helpers
// ---------------------------------------------------------------------------

/**
 * md5 fingerprint of an example-dex item's source fields (the fields that
 * determine what the AI sees). 12 hex chars.
 */
function computeItemFingerprint(item) {
  const sourceData = {
    name: item.name || item.filename,
    description: item.description || '',
    content: (item.content || '').substring(0, 2000),
    keyCode: item.keyCode ? item.keyCode.substring(0, 1000) : '',
    category: item.category || '',
    files: item.files || [],
    dependencies: item.dependencies || [],
    steps: item.steps || [],
    keyFeatures: item.keyFeatures || [],
    resolutions: item.resolutions || [],
  };
  return crypto.createHash('md5').update(JSON.stringify(sourceData)).digest('hex').substring(0, 12);
}

/**
 * Look up an existing pattern by name within a category (case-insensitive).
 */
function findExistingPattern(categoryName, name) {
  const category = sdkPatterns.categories.find((c) => c.name === categoryName);
  if (!category) return null;
  return (
    category.patterns.find((p) => p.name.toLowerCase() === name.toLowerCase()) ||
    category.patterns.find((p) => p.name.toLowerCase() === name.toLowerCase().replace(/\s+/g, '')) ||
    null
  );
}

/**
 * Insert-or-update by pattern name. Returns 'added' or 'updated'.
 */
function upsertPattern(categoryName, pattern) {
  const category = findOrCreateCategory(sdkPatterns.categories, categoryName);
  const idx = category.patterns.findIndex(
    (p) => p.name.toLowerCase() === pattern.name.toLowerCase()
  );
  if (idx >= 0) {
    category.patterns[idx] = pattern;
    return 'updated';
  }
  category.patterns.push(pattern);
  return 'added';
}

function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// Load existing fingerprints (empty if FORCE'd away)
const fingerprints = FORCE ? {} : sdkPatterns._enrichedFingerprints || {};
if (Object.keys(fingerprints).length > 0) {
  console.log(`📦 Loaded ${Object.keys(fingerprints).length} cached item fingerprints.\n`);
}

// Stats accumulators
const stats = {
  processed: 0,
  cached: 0,
  failed: 0,
  addedCount: 0,
  errorCount: 0,
  processedFiles: [],
};

/**
 * Unified per-item processor with cache-aware skipping + refinement context.
 *
 * @param items         - array of example-dex items to process
 * @param categoryName  - SDK pattern category to upsert into
 * @param aiProcessor   - (item, existingPattern) => Promise<pattern|null>
 * @param basicCreator  - (item) => pattern  (used when USE_AI is false)
 * @param itemName      - (item) => string used for cache key + name lookup
 * @param rateLimitDelay - ms to wait after each AI call
 */
async function processItems(items, categoryName, opts) {
  const { aiProcessor, basicCreator, itemName, rateLimitDelay = 500 } = opts;

  if (items.length === 0) {
    console.log('   (no items)');
    return;
  }

  for (const item of items) {
    const name = itemName(item);
    console.log(`   Processing: ${name}`);

    const fp = computeItemFingerprint(item);
    const key = `${categoryName}::${name}`;
    const storedFp = fingerprints[key];

    // Cache hit — skip AI call entirely
    if (storedFp && storedFp === fp && !FORCE) {
      console.log(`   ⏭️  Cache hit (fingerprint unchanged). Skipping.`);
      stats.cached++;
      continue;
    }

    let pattern;
    if (USE_AI) {
      const existing = findExistingPattern(categoryName, name);
      pattern = await aiProcessor(item, existing);
      await delay(rateLimitDelay);
    } else {
      pattern = basicCreator(item);
    }

    if (pattern) {
      const action = upsertPattern(categoryName, pattern);
      console.log(`   ${action === 'updated' ? '📝 Updated' : '✅ Added'}: ${pattern.name}`);
      fingerprints[key] = fp;
      stats.processed++;
      stats.addedCount++;
      stats.processedFiles.push(name);

      // Checkpoint after each item (crash-safe)
      writeCheckpoint();
    } else {
      stats.failed++;
      stats.errorCount++;
    }
  }
}

function writeCheckpoint() {
  sdkPatterns._enrichedFingerprints = fingerprints;
  sdkPatterns.metadata = sdkPatterns.metadata || {};
  sdkPatterns.metadata.enrichedWithExamples = {
    timestamp: new Date().toISOString(),
    source: 'https://github.com/orderlynetwork/example-dex',
    mode: USE_AI ? 'ai-enhanced' : 'basic',
    patternsAdded: stats.addedCount,
    errors: stats.errorCount,
    processedFiles: stats.processedFiles,
    cacheStats: {
      processed: stats.processed,
      cached: stats.cached,
      failed: stats.failed,
    },
  };
  if (USE_AI) {
    sdkPatterns.metadata.enrichedWithExamples.model = NEAR_AI_MODEL;
  }
  atomicWriteJson(SDK_PATTERNS_FILE, sdkPatterns);
}

// AI prompt for analyzing a component
function createComponentAnalysisPrompt(component, category, existingPattern = null) {
  const existingBlock = existingPattern
    ? `\nEXISTING PATTERN (UPDATE this where the new source improves it; otherwise preserve accurate parts):\n${JSON.stringify(existingPattern, null, 2)}\n`
    : '';

  return `Analyze this React/TypeScript component from the Orderly Network example-dex repository and create a comprehensive SDK pattern.

Component: ${component.filename}
Category: ${category}
Description: ${component.description}

Source Code:
\`\`\`typescript
${component.content}
\`\`\`
${existingBlock}
Generate a comprehensive pattern object with the following structure:

{
  "name": "PascalCase component name without extension",
  "description": "Clear, concise description of what this component does and when to use it",
  "installation": "npm install packages needed (only Orderly packages, not React/etc)",
  "usage": "Detailed explanation of how to use this component, including:",
    - Required props and their types
    - Optional props and defaults
    - Context/providers needed
    - Integration steps",
  "example": "Complete, focused code example showing the key implementation patterns. Include:",
    - Imports
    - Component usage
    - Key logic (not boilerplate)
    - Comments explaining important parts",
  "notes": [
    "Implementation tips and best practices",
    "Common gotchas",
    "Performance considerations",
    "Accessibility notes",
    "TypeScript tips"
  ],
  "difficulty": "beginner|intermediate|advanced",
  "prerequisites": ["List of knowledge/components needed before using this"],
  "related": ["Related Orderly hooks or components"]
}

Guidelines:
1. Extract the ESSENTIAL patterns, not the full file
2. Focus on Orderly-specific integration
3. Include realistic prop examples
4. Add practical troubleshooting tips
5. Identify difficulty level honestly
6. List actual prerequisites for using this
7. Cross-reference related Orderly SDK features
${existingPattern ? '8. CRITICAL: When EXISTING PATTERN is provided, refine it based on new source rather than starting from scratch. Preserve accurate content; update improved content.\n' : ''}
Return ONLY valid JSON, no markdown formatting.`;
}

// AI prompt for analyzing implementation patterns
function createPatternAnalysisPrompt(pattern, existingPattern = null) {
  const existingBlock = existingPattern
    ? `\nEXISTING PATTERN (UPDATE this where the new source improves it; otherwise preserve accurate parts):\n${JSON.stringify(existingPattern, null, 2)}\n`
    : '';

  return `Analyze this implementation pattern from the Orderly Network example-dex repository.

Pattern: ${pattern.name}
Description: ${pattern.description}
Category: ${pattern.category}
Difficulty: ${pattern.difficulty}

Key Code:
\`\`\`typescript
${pattern.keyCode || '// No key code provided'}
\`\`\`

Steps:
${pattern.steps?.map((s, i) => `${i + 1}. ${s}`).join('\n') || 'No steps provided'}
${existingBlock}
Generate an enhanced pattern object:

{
  "name": "PascalCase pattern name",
  "description": "Comprehensive description of what this pattern accomplishes",
  "installation": "npm install packages needed",
  "usage": "Detailed usage guide with:",
    - When to use this pattern
    - Prerequisites
    - Integration steps
    - Configuration options",
  "example": "Complete, production-ready code example with:",
    - Full implementation
    - Error handling
    - Best practices
    - Comments",
  "notes": [
    "Common issues and solutions",
    "Performance tips",
    "Security considerations",
    "Testing approaches",
    "Alternative approaches"
  ],
  "difficulty": "beginner|intermediate|advanced",
  "prerequisites": ["Required knowledge/components"],
  "related": ["Related patterns or hooks"]
}
${existingPattern ? '\nCRITICAL: When EXISTING PATTERN is provided, refine it based on new source rather than starting from scratch. Preserve accurate content; update improved content.\n' : ''}
Make this educational and practical. Return ONLY valid JSON.`;
}

// Process a single component with AI
async function processComponentWithAI(component, category, existingPattern = null) {
  const prompt = createComponentAnalysisPrompt(component, category, existingPattern);

  try {
    const completion = await openai.chat.completions.create({
      model: NEAR_AI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert React/TypeScript developer specializing in Orderly Network SDK. Analyze code and generate comprehensive, educational SDK patterns. Return only valid JSON.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 12_000,
    });

    const responseContent = completion.choices[0]?.message?.content;
    if (!responseContent) {
      throw new Error('Empty response from AI');
    }

    // Clean up markdown code blocks if present
    let jsonContent = responseContent.trim();
    if (jsonContent.startsWith('```json')) {
      jsonContent = jsonContent.slice(7);
    } else if (jsonContent.startsWith('```')) {
      jsonContent = jsonContent.slice(3);
    }
    if (jsonContent.endsWith('```')) {
      jsonContent = jsonContent.slice(0, -3);
    }
    jsonContent = jsonContent.trim();

    return JSON.parse(jsonContent);
  } catch (error) {
    console.error(`   ❌ AI processing failed for ${component.filename}:`, error.message);
    // Log the actual response for debugging
    console.error('   Response preview:', responseContent?.substring(0, 200));
    return null;
  }
}

// Process implementation pattern with AI
async function processPatternWithAI(pattern, existingPattern = null) {
  const prompt = createPatternAnalysisPrompt(pattern, existingPattern);

  try {
    const completion = await openai.chat.completions.create({
      model: NEAR_AI_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert in Orderly Network SDK patterns. Create comprehensive implementation guides. Return only valid JSON.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 12_000,
    });

    const responseContent = completion.choices[0]?.message?.content;
    if (!responseContent) {
      throw new Error('Empty response from AI');
    }

    // Clean up markdown code blocks if present
    let jsonContent = responseContent.trim();
    if (jsonContent.startsWith('```json')) {
      jsonContent = jsonContent.slice(7);
    } else if (jsonContent.startsWith('```')) {
      jsonContent = jsonContent.slice(3);
    }
    if (jsonContent.endsWith('```')) {
      jsonContent = jsonContent.slice(0, -3);
    }
    jsonContent = jsonContent.trim();

    return JSON.parse(jsonContent);
  } catch (error) {
    console.error(`   ❌ AI processing failed for ${pattern.name}:`, error.message);
    // Log the actual response for debugging
    console.error('   Response preview:', responseContent?.substring(0, 200));
    return null;
  }
}

// Basic pattern creation (no AI)
function createPatternFromExample(patternData) {
  return {
    name: patternData.name.replace(/\s+/g, ''),
    description: patternData.description,
    installation: patternData.dependencies
      ? `npm install ${patternData.dependencies.join(' ')}`
      : undefined,
    usage: patternData.description,
    example: patternData.keyCode || `// See ${patternData.files?.join(', ') || 'example files'}`,
    notes: [
      `Difficulty: ${patternData.difficulty}`,
      `Category: ${patternData.category}`,
      `Source files: ${patternData.files?.join(', ')}`,
    ],
    related: patternData.dependencies?.filter((d) => d.includes('@orderly')) || [],
  };
}

// Basic component creation (no AI)
function createComponentPattern(component, categoryName) {
  const maxContentLength = 3000;
  let content = component.content;
  if (content.length > maxContentLength) {
    content =
      content.substring(0, maxContentLength) +
      '\n// ... (truncated, see full example in repository)';
  }

  return {
    name: component.filename.replace('.tsx', '').replace('.ts', ''),
    description: component.description,
    usage: `Complete ${categoryName.toLowerCase().replace(' components', '')} component implementation`,
    example: content,
    notes: [
      'Full working example from Orderly example-dex repository',
      `Source: https://github.com/orderlynetwork/example-dex/blob/master/app/components/${component.filename}`,
      'Copy and adapt for your own DEX implementation',
    ],
    related: ['@orderly.network/hooks', '@orderly.network/types'],
  };
}

// Main processing function
async function main() {
  // 1. Process implementation patterns — pre-group by category because each
  //    pattern's target category is derived from its own `category` field.
  console.log('📋 Processing implementation patterns...\n');
  const patternsByCategory = {};
  for (const pattern of exampleDexData.patterns || []) {
    let cat;
    switch (pattern.category) {
      case 'charts':
        cat = 'Charts & Visualization';
        break;
      case 'trading':
        cat = 'Trading Interface';
        break;
      case 'positions':
        cat = 'Position Management';
        break;
      case 'wallet':
        cat = 'Wallet Connection';
        break;
      case 'orderManagement':
        cat = 'Order Management';
        break;
      default:
        cat = 'DEX Components';
    }
    if (!patternsByCategory[cat]) patternsByCategory[cat] = [];
    patternsByCategory[cat].push(pattern);
  }

  for (const [cat, items] of Object.entries(patternsByCategory)) {
    console.log(`\n📂 ${cat}:`);
    await processItems(items, cat, {
      aiProcessor: (item, existing) => processPatternWithAI(item, existing),
      basicCreator: createPatternFromExample,
      itemName: (item) => item.name,
    });
  }

  // 2. Chart components (lightweight + tradingView)
  console.log('\n📊 Processing chart components...\n');
  await processItems(
    [...(exampleDexData.charts?.lightweightCharts || []), ...(exampleDexData.charts?.tradingView || [])],
    'Chart Components',
    {
      aiProcessor: (item, existing) => processComponentWithAI(item, 'Chart Components', existing),
      basicCreator: (item) => createComponentPattern(item, 'Chart Components'),
      itemName: (item) => item.filename,
    }
  );

  // 3. WebSocket services
  console.log('\n📡 Processing WebSocket services...\n');
  await processItems(exampleDexData.charts?.websocketServices || [], 'WebSocket Services', {
    aiProcessor: (item, existing) => processComponentWithAI(item, 'WebSocket Services', existing),
    basicCreator: (item) => ({
      name: item.filename.replace('.ts', ''),
      description: item.description,
      usage: 'Real-time WebSocket data subscription service',
      example: item.content,
      notes: [
        ...(item.keyFeatures || []),
        `Supports resolutions: ${item.resolutions?.join(', ')}`,
        `Source: https://github.com/orderlynetwork/example-dex/blob/master/app/services/${item.filename}`,
      ],
      related: ['@orderly.network/net', '@orderly.network/hooks'],
    }),
    itemName: (item) => item.filename,
  });

  // 4. Trading components
  console.log('\n🔄 Processing trading components...\n');
  await processItems(exampleDexData.components?.trading || [], 'Trading Components', {
    aiProcessor: (item, existing) => processComponentWithAI(item, 'Trading Components', existing),
    basicCreator: (item) => createComponentPattern(item, 'Trading Components'),
    itemName: (item) => item.filename,
  });

  // 5. Position components
  console.log('\n📈 Processing position components...\n');
  await processItems(exampleDexData.components?.positionManagement || [], 'Position Components', {
    aiProcessor: (item, existing) => processComponentWithAI(item, 'Position Components', existing),
    basicCreator: (item) => createComponentPattern(item, 'Position Components'),
    itemName: (item) => item.filename,
  });

  // 6. Order components
  console.log('\n📋 Processing order components...\n');
  await processItems(exampleDexData.components?.orderManagement || [], 'Order Components', {
    aiProcessor: (item, existing) => processComponentWithAI(item, 'Order Components', existing),
    basicCreator: (item) => createComponentPattern(item, 'Order Components'),
    itemName: (item) => item.filename,
  });

  // 7. Wallet components
  console.log('\n👛 Processing wallet components...\n');
  await processItems(exampleDexData.components?.wallet || [], 'Wallet Components', {
    aiProcessor: (item, existing) => processComponentWithAI(item, 'Wallet Components', existing),
    basicCreator: (item) => createComponentPattern(item, 'Wallet Components'),
    itemName: (item) => item.filename,
  });

  // 8. Account components
  console.log('\n💰 Processing account components...\n');
  await processItems(exampleDexData.components?.account || [], 'Account Components', {
    aiProcessor: (item, existing) => processComponentWithAI(item, 'Account Components', existing),
    basicCreator: (item) => createComponentPattern(item, 'Account Components'),
    itemName: (item) => item.filename,
  });

  // Final checkpoint (already written incrementally, this just updates stats)
  writeCheckpoint();

  console.log(`\n✅ Enrichment complete!`);
  console.log(`📄 Updated: ${SDK_PATTERNS_FILE}`);
  console.log(`\nSummary:`);
  console.log(`   - Mode: ${USE_AI ? 'AI-Enhanced' : 'Basic'} ${FORCE ? '(FORCE)' : ''}`);
  console.log(`   - Total categories: ${sdkPatterns.categories.length}`);
  console.log(`   - Processed: ${stats.processed} (added/updated)`);
  console.log(`   - Cached:   ${stats.cached} (skipped, fingerprint unchanged)`);
  if (stats.failed > 0) {
    console.log(`   - Failed:   ${stats.failed}`);
  }
  if (USE_AI) {
    console.log(`   - Model:    ${NEAR_AI_MODEL}`);
  }
  console.log(`\nNext: yarn build && yarn test:run`);
}

main().catch((error) => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
