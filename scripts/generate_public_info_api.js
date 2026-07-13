#!/usr/bin/env node

/**
 * generate_public_info_api.js
 *
 * Parses the Orderly Network Public Info API MDX documentation (in the sibling
 * `documentation` repo) and produces a comprehensive `src/data/public-info-api.json`.
 *
 * The Public Info API is a single POST endpoint (POST /v1/public/query) whose
 * behaviour is selected by a `type` field. There are 24 query types spread
 * across market / account / platform / system categories. Unlike the other API
 * generators (which parse OpenAPI specs), this one parses structured MDX files.
 *
 * Source: ../documentation/build-on-omnichain/public-info-api/
 *   - overview.mdx        (endpoint, error codes, rate limits, freshness, rateLimitStatus)
 *   - market/*.mdx        (8 query types)
 *   - account/*.mdx       (13 query types)
 *   - platform/*.mdx      (2 query types)
 *   + rateLimitStatus     (extracted from overview → "system" category)
 *
 * Cost: FREE (no AI, no network — pure local MDX parsing).
 *
 * Usage:
 *   node scripts/generate_public_info_api.js
 *   ORDERLY_DOCS_DIR=/path/to/docs node scripts/generate_public_info_api.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const DEFAULT_DOCS_DIR = path.join(
  projectRoot,
  '..',
  'documentation',
  'build-on-omnichain',
  'public-info-api'
);
const DOCS_DIR = process.env.ORDERLY_DOCS_DIR || DEFAULT_DOCS_DIR;
const OUTPUT_FILE = path.join(projectRoot, 'src', 'data', 'public-info-api.json');

const API_VERSION = '1.0.0';
const API_TITLE = 'Orderly Network Public Info API';
const API_DESCRIPTION =
  'Zero-auth, single-endpoint query API for AI agents, quant traders, and analytics. ' +
  'POST /v1/public/query with a `type` field — covers market, account, and platform data.';
const ENDPOINT = {
  method: 'POST',
  url: 'https://api.orderly.org/v1/public/query',
  contentType: 'application/json',
};

const CATEGORY_META = {
  market: {
    title: 'Market data',
    description:
      'Public market data: prices, OHLCV, orderbook, trades, funding, and liquidations. No address required.',
    order: 0,
  },
  account: {
    title: 'Account data',
    description:
      'Per-address account data: state, positions, orders, trades, funding payments, PnL, and portfolio. Requires an `address`.',
    order: 1,
  },
  platform: {
    title: 'Platform data',
    description:
      'Platform-wide aggregates: the top-addresses leaderboard and platform-wide open positions.',
    order: 2,
  },
  system: {
    title: 'System',
    description: 'Operational queries: rate-limit status (free, weight 0).',
    order: 3,
  },
};

// ---------------------------------------------------------------------------
// Generic MDX / markdown helpers
// ---------------------------------------------------------------------------

/** Strip MDX frontmatter (`---\n...\n---`), returning parsed fields + body. */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { fields: {}, body: content };
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*"?(.*?)"?\s*$/);
    if (m) fields[m[1]] = m[2];
  }
  return { fields, body: match[2] };
}

/** Split a body into lines, preserving content exactly. */
function toLines(body) {
  return body.split(/\r?\n/);
}

/** Extract the first `**Weight:** N` value found. */
function extractWeight(body) {
  const m = body.match(/\*\*Weight:\*\*\s*`?(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Extract every fenced code block of the given language with its optional label. */
function extractFencedBlocks(body, lang = 'json') {
  const blocks = [];
  const re = new RegExp('```' + lang + '(?:[^\\n]*)\\n([\\s\\S]*?)```', 'g');
  // Labels appear on the fence line after the language (e.g. ```json Response).
  const labelRe = new RegExp('```' + lang + '([^\\n]*)\\n', 'g');
  const labels = [];
  let lm;
  while ((lm = labelRe.exec(body)) !== null) {
    labels.push(lm[1].trim());
  }
  let bm;
  let i = 0;
  while ((bm = re.exec(body)) !== null) {
    blocks.push({ label: labels[i] || '', code: bm[1].replace(/\s+$/, '') });
    i++;
  }
  return blocks;
}

/** Return the byte offset of the start of a given `## ` / `### ` heading line. */
function headingOffsets(body, prefix) {
  const offsets = [];
  const lines = toLines(body);
  let pos = 0;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      offsets.push({ pos, heading: line.replace(/^#+\s+/, '').trim(), lineNo: offsets.length });
    }
    pos += line.length + 1; // +1 for newline
  }
  return offsets;
}

/** Locate all markdown tables in body. Each table = consecutive lines starting with `|`. */
function findTables(body) {
  const lines = toLines(body);
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith('|')) {
      const startLine = i;
      // Collect the run of table lines (allow trailing whitespace-only lines to be skipped)
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        i++;
      }
      const raw = lines.slice(startLine, i).join('\n');
      tables.push({ startLine, endLine: i - 1, raw });
    } else {
      i++;
    }
  }
  return tables;
}

/** Parse a markdown table into header + rows (cell strings, backticks stripped). */
function parseTable(raw) {
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return { header: [], rows: [] };
  const splitCells = (line) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim().replace(/[`*]/g, ''));
  const header = splitCells(lines[0]);
  // Skip the separator row (| --- | --- |)
  const dataLines = lines[1].includes('---') ? lines.slice(2) : lines.slice(1);
  const rows = dataLines.map(splitCells);
  return { header, rows };
}

/** Find the nearest preceding heading (## or ###) text above a given line index. */
function nearestPrecedingHeading(body, lineIndex, maxLevel = 3) {
  const lines = toLines(body);
  for (let i = lineIndex - 1; i >= 0; i--) {
    const m = lines[i].match(/^(#{2,4})\s+(.+)$/);
    if (m && m[1].length <= maxLevel) {
      return m[2].trim();
    }
  }
  return 'Response';
}

/** Extract bullet list items under a `## Notes` section (until the next `##`/tag/end). */
function extractNotes(body) {
  const lines = toLines(body);
  const notes = [];
  let inNotes = false;
  for (const line of lines) {
    if (/^##\s+Notes/.test(line)) {
      inNotes = true;
      continue;
    }
    if (!inNotes) continue;
    // Stop at the next ## heading or an HTML block (e.g. <ResponseExample>)
    if (/^##\s+/.test(line) || /^<[A-Za-z]/.test(line.trim())) break;
    const m = line.match(/^\s*-\s+(.+)$/);
    if (m) notes.push(m[1].trim());
  }
  return notes;
}

/** Extract the intro paragraph(s): text between frontmatter-end and the first `**Weight:**` or heading. */
function extractIntro(body) {
  const lines = toLines(body);
  const collected = [];
  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line)) break;
    if (/^\*\*Weight:\*\*/.test(line)) break;
    if (/^\s*-\s+/.test(line)) break; // stop at first bullet list
    if (/^<[A-Za-z]/.test(line.trim())) break;
    if (line.trim()) collected.push(line.trim());
  }
  return collected.join(' ');
}

// ---------------------------------------------------------------------------
// Per-query-type extraction (from a single MDX file)
// ---------------------------------------------------------------------------

function processQueryTypeFile(filePath, category) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { fields, body } = parseFrontmatter(content);
  const slug = path.basename(filePath, '.mdx');

  // Request example = first json block in the `## Request` section, else first block overall.
  const allJsonBlocks = extractFencedBlocks(body, 'json');
  const requestExampleRaw = allJsonBlocks.length > 0 ? allJsonBlocks[0].code : '';

  let requestType = null;
  if (requestExampleRaw) {
    const m = requestExampleRaw.match(/"type"\s*:\s*"([^"]+)"/);
    if (m) requestType = m[1];
  }

  // Tables: first table = request params; subsequent tables (before Notes) = response sections.
  const tables = findTables(body);
  const notesLine = (() => {
    const idx = toLines(body).findIndex((l) => /^##\s+Notes/.test(l));
    return idx >= 0 ? idx : Number.POSITIVE_INFINITY;
  })();

  let requestParams = [];
  const responseSections = [];

  if (tables.length > 0) {
    requestParams = parseParamsTable(tables[0].raw);
    for (const t of tables.slice(1)) {
      if (t.startLine > notesLine) break;
      const heading = nearestPrecedingHeading(body, t.startLine);
      responseSections.push({ heading, markdown: t.raw });
    }
  }

  // Response examples live inside <ResponseExample>...</ResponseExample>.
  const responseExamples = extractResponseExamples(body);

  return {
    type: requestType,
    title: fields.title || slug,
    category,
    slug,
    description: fields.description || '',
    intro: extractIntro(body),
    weight: extractWeight(body),
    requestExample: requestExampleRaw,
    requestParams,
    responseSections,
    responseExamples,
    notes: extractNotes(body),
    paginated: /\bcursor\b/i.test(requestExampleRaw) || requestParams.some((p) => p.name === 'cursor'),
    path: `build-on-omnichain/public-info-api/${category}/${slug}`,
  };
}

/** Parse a request-params table (5 cols: Field|Type|Required|Default|Notes). */
function parseParamsTable(raw) {
  const { header, rows } = parseTable(raw);
  // Map header columns by name to be resilient to column reordering.
  const idx = (names) => {
    for (const n of names) {
      const i = header.findIndex((h) => h.toLowerCase().includes(n.toLowerCase()));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iField = idx(['field']);
  const iType = idx(['type']);
  const iRequired = idx(['required']);
  const iDefault = idx(['default']);
  const iNotes = idx(['note', 'description']);
  return rows.map((cells) => ({
    name: iField >= 0 ? cells[iField] : '',
    type: iType >= 0 ? cells[iType] : '',
    required: /^\s*(yes|true|required)\b/i.test(iRequired >= 0 ? cells[iRequired] : ''),
    default: iDefault >= 0 ? cells[iDefault] : '',
    notes: iNotes >= 0 ? cells[iNotes] : '',
  }));
}

/** Extract labelled JSON examples from within <ResponseExample>...</ResponseExample>. */
function extractResponseExamples(body) {
  const re = /<ResponseExample>([\s\S]*?)<\/ResponseExample>/;
  const m = body.match(re);
  if (!m) return [];
  return extractFencedBlocks(m[1], 'json');
}

// ---------------------------------------------------------------------------
// Overview extraction
// ---------------------------------------------------------------------------

function findTableByHeader(body, headerSubstring) {
  for (const t of findTables(body)) {
    if (t.raw.toLowerCase().includes(headerSubstring.toLowerCase())) {
      return t;
    }
  }
  return null;
}

function processOverview(body) {
  const overview = {
    responseEnvelope: null,
    errorCodes: [],
    addressResolution: [],
    pagination: { description: '', cursorShapes: [] },
    rateLimits: {
      weightPerMinute: 1200,
      weightByType: [],
      responseHeaders: '',
      overQuotaExample: null,
    },
    freshness: [],
  };

  // Response envelope — first json block in the "Response envelope" area.
  const envBlock = extractFencedBlocks(body, 'json');
  if (envBlock.length > 0) {
    overview.responseEnvelope = envBlock[0].code;
  }

  // Error codes table: header includes "UNKNOWN_TYPE" or "Meaning".
  const errTable = findTableByHeader(body, 'UNKNOWN_TYPE') || findTableByHeader(body, '| Meaning');
  if (errTable) {
    const { header, rows } = parseTable(errTable.raw);
    const iCode = header.findIndex((h) => h.toLowerCase().includes('code'));
    const iHttp = header.findIndex((h) => h.toLowerCase().includes('http'));
    const iMeaning = header.findIndex((h) => h.toLowerCase().includes('meaning'));
    overview.errorCodes = rows.map((cells) => ({
      code: iCode >= 0 ? cells[iCode] : '',
      http: iHttp >= 0 ? parseInt(cells[iHttp], 10) || 0 : 0,
      meaning: iMeaning >= 0 ? cells[iMeaning] : '',
    }));
  }

  // Address resolution table: header includes "Scope".
  const addrTable = findTableByHeader(body, 'Scope');
  if (addrTable) {
    const { header, rows } = parseTable(addrTable.raw);
    const iInput = header.findIndex((h) => h.toLowerCase().includes('input'));
    const iScope = header.findIndex((h) => h.toLowerCase().includes('scope'));
    overview.addressResolution = rows.map((cells) => ({
      input: iInput >= 0 ? cells[iInput] : '',
      scope: iScope >= 0 ? cells[iScope] : '',
    }));
  }

  // Pagination cursor shapes table: header includes "Cursor shape".
  const cursorTable = findTableByHeader(body, 'Cursor shape');
  if (cursorTable) {
    const { header, rows } = parseTable(cursorTable.raw);
    const iEndpoint = header.findIndex((h) => h.toLowerCase().includes('endpoint'));
    const iShape = header.findIndex((h) => h.toLowerCase().includes('cursor'));
    overview.pagination.cursorShapes = rows.map((cells) => ({
      endpoints: iEndpoint >= 0 ? cells[iEndpoint] : '',
      shape: iShape >= 0 ? cells[iShape] : '',
    }));
  }

  // Rate-limit weight per query type: header includes "Query types".
  const weightTable = findTableByHeader(body, 'Query types');
  if (weightTable) {
    const { header, rows } = parseTable(weightTable.raw);
    const iWeight = header.findIndex((h) => h.toLowerCase().includes('weight'));
    const iTypes = header.findIndex((h) => h.toLowerCase().includes('query'));
    overview.rateLimits.weightByType = rows.map((cells) => ({
      weight: iWeight >= 0 ? parseInt(cells[iWeight], 10) || 0 : 0,
      // Capture every identifier-like token; refined against known types later.
      types:
        iTypes >= 0
          ? (cells[iTypes].match(/[a-zA-Z][a-zA-Z0-9]*/g) || []).filter(Boolean)
          : [],
    }));
  }

  // Rate-limit response headers (plain fenced block listing X-RateLimit-* headers).
  const hdrMatch = body.match(/```\n(X-RateLimit[\s\S]*?)```/);
  if (hdrMatch) {
    overview.rateLimits.responseHeaders = hdrMatch[1].replace(/\s+$/, '');
  }

  // Over-quota (429) example payload.
  const overQuotaBlock = extractFencedBlocks(body, 'json').find((b) =>
    b.code.includes('RATE_LIMIT_EXCEEDED')
  );
  if (overQuotaBlock) {
    overview.rateLimits.overQuotaExample = overQuotaBlock.code;
  }

  // Freshness table: header includes "Worst-case freshness".
  const freshTable = findTableByHeader(body, 'freshness');
  if (freshTable) {
    const { header, rows } = parseTable(freshTable.raw);
    const iType = header.findIndex((h) => h.toLowerCase().includes('type'));
    const iField = header.findIndex((h) => h.toLowerCase().includes('field'));
    const iFresh = header.findIndex((h) => h.toLowerCase().includes('fresh'));
    overview.freshness = rows.map((cells) => ({
      type: iType >= 0 ? cells[iType] : '',
      field: iField >= 0 ? cells[iField] : '',
      freshness: iFresh >= 0 ? cells[iFresh] : '',
    }));
  }

  return overview;
}

/** Build the synthetic `rateLimitStatus` query type from the overview body. */
function buildRateLimitStatus(body) {
  const lines = toLines(body);
  const startIdx = lines.findIndex((l) => /###\s+`rateLimitStatus`/.test(l));
  const sectionLines = startIdx >= 0 ? lines.slice(startIdx) : lines;
  const section = sectionLines.join('\n');

  const blocks = extractFencedBlocks(section, 'json');
  const requestExample = blocks.find((b) => b.code.includes('"type"'))?.code || blocks[0]?.code || '';
  const responseExample = blocks.find((b) => !b.code.includes('"type"'))?.code || blocks[1]?.code || '';

  // Fields table after the response block.
  const tables = findTables(section);
  let responseSections = [];
  if (tables.length > 0) {
    responseSections = tables.map((t) => ({ heading: 'Response', markdown: t.raw }));
  }

  return {
    type: 'rateLimitStatus',
    title: 'Rate limit status',
    category: 'system',
    slug: 'rate-limit-status',
    description:
      'Read your IP quota state for the rolling one-minute window. Weight 0 — safe to poll every loop iteration.',
    intro:
      'Read your IP quota state for the rolling one-minute window. Weight 0 — calling it does not consume any quota.',
    weight: 0,
    requestExample,
    requestParams: [],
    responseSections,
    responseExamples: responseExample ? [{ label: 'Response', code: responseExample }] : [],
    notes: ['Weight 0 — never consumes quota.', 'Safe to poll on every loop iteration.'],
    paginated: false,
    path: 'build-on-omnichain/public-info-api/overview',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function discoverFiles() {
  const result = [];
  for (const category of ['market', 'account', 'platform']) {
    const dir = path.join(DOCS_DIR, category);
    if (!fs.existsSync(dir)) {
      console.warn(`   ⚠️  Directory not found: ${dir}`);
      continue;
    }
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mdx')).sort()) {
      result.push({ category, file: path.join(dir, file) });
    }
  }
  return result;
}

async function main() {
  console.log('🚀 Orderly Public Info API Documentation Generator\n');
  console.log(`   Docs dir: ${DOCS_DIR}\n`);
  console.log('Mode: Direct MDX parsing (no AI, no network) — FREE ⚡\n');

  if (!fs.existsSync(DOCS_DIR)) {
    console.error(`\n❌ Documentation directory not found: ${DOCS_DIR}`);
    console.error('   Set ORDERLY_DOCS_DIR to point at the public-info-api folder.');
    process.exit(1);
  }

  // Overview
  const overviewPath = path.join(DOCS_DIR, 'overview.mdx');
  if (!fs.existsSync(overviewPath)) {
    console.error(`\n❌ overview.mdx not found at ${overviewPath}`);
    process.exit(1);
  }
  const overviewContent = fs.readFileSync(overviewPath, 'utf-8');
  const { body: overviewBody } = parseFrontmatter(overviewContent);
  const overview = processOverview(overviewBody);

  // Query types from MDX files
  const files = discoverFiles();
  console.log(`🔍 Found ${files.length} query-type MDX files\n`);

  const queryTypes = [];
  for (const { category, file } of files) {
    const qt = processQueryTypeFile(file, category);
    if (!qt.type) {
      console.warn(`   ⚠️  No "type" extracted from ${path.basename(file)}`);
    }
    queryTypes.push(qt);
    console.log(`   ✅ ${qt.type || '(unknown)'} [${category}] w=${qt.weight ?? '?'}`);
  }

  // Synthetic rateLimitStatus from overview
  const rateLimitStatus = buildRateLimitStatus(overviewBody);
  queryTypes.push(rateLimitStatus);
  console.log(`   ✅ ${rateLimitStatus.type} [system] w=${rateLimitStatus.weight}`);

  // Deterministic ordering: by category order, then type alphabetical.
  queryTypes.sort((a, b) => {
    const ca = CATEGORY_META[a.category]?.order ?? 99;
    const cb = CATEGORY_META[b.category]?.order ?? 99;
    if (ca !== cb) return ca - cb;
    return (a.type || '').localeCompare(b.type || '');
  });

  // Build categories with their query type lists.
  const categories = Object.entries(CATEGORY_META)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([name, meta]) => ({
      name,
      title: meta.title,
      description: meta.description,
      queryTypes: queryTypes.filter((q) => q.category === name).map((q) => q.type),
    }))
    .filter((c) => c.queryTypes.length > 0);

  // Refine weight-table tokens: keep only tokens that are real query types.
  const knownTypes = new Set(queryTypes.map((q) => q.type).filter(Boolean));
  const orphanTypes = [];
  for (const entry of overview.rateLimits.weightByType) {
    const kept = entry.types.filter((t) => {
      if (knownTypes.has(t)) return true;
      orphanTypes.push(t);
      return false;
    });
    entry.types = kept;
  }
  if (orphanTypes.length > 0) {
    console.warn(`\n   ⚠️  Weight table dropped non-type tokens: ${orphanTypes.join(', ')}`);
  }

  const output = {
    version: API_VERSION,
    title: API_TITLE,
    description: API_DESCRIPTION,
    endpoint: ENDPOINT,
    auth: 'none',
    baseUrl: {
      mainnet: ENDPOINT.url,
      testnet: ENDPOINT.url,
    },
    categories,
    queryTypes,
    overview,
    metadata: {
      generatedAt: new Date().toISOString(),
      source: DOCS_DIR,
      mode: 'mdx-parsing',
      totalQueryTypes: queryTypes.length,
      totalCategories: categories.length,
    },
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`\n💾 Saved Public Info API documentation to ${OUTPUT_FILE}`);
  console.log('\n✅ Generation complete!\n');
  console.log('📊 Summary:');
  console.log(`   - Query types: ${queryTypes.length}`);
  console.log(`   - Categories:  ${categories.length}`);
  console.log(`   - Error codes: ${overview.errorCodes.length}`);
  console.log(`   - Freshness rows: ${overview.freshness.length}`);
  console.log('\nNext steps:');
  console.log('   1. Review src/data/public-info-api.json');
  console.log('   2. Run: yarn build && yarn test:run\n');
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
