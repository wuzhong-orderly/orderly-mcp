#!/usr/bin/env node

/**
 * analyze_docs.js
 *
 * Processes the Orderly Network documentation repo (OrderlyNetwork/documentation-public)
 * to extract clean Q&A pairs using NEAR AI Cloud API.
 *
 * DESIGN (v3.0.0):
 *   Instead of chunking a concatenated llms-full.txt (where any doc edit shifted
 *   chunk boundaries and invalidated nearly every cache entry), we clone the
 *   source repo and process each canonical MDX page individually. Cache
 *   granularity is now per-file, so editing one doc only reprocesses that one
 *   file.
 *
 *   The canonical page list comes from the repo's own `llms.config.json`
 *   (`canonicalPages` array) — this is the curated set the repo authors deem
 *   AI-relevant.
 *
 * INCREMENTAL MODE (default):
 *   Reads existing docs_analysis.json. For each canonical page, computes a
 *   content fingerprint and reuses cached result on hit. Only new/changed
 *   pages are sent to the AI. Checkpoint after EVERY page (crash-safe).
 *
 * EXISTING-DATA-AWARE REFINEMENT:
 *   On any AI call (cache miss), the script passes a small set of relevant
 *   existing Q&A pairs (filtered by keyword match against the page's
 *   title/description/section) as context. The AI is instructed to UPDATE
 *   existing pairs where the new content improves the answer, and to ADD new
 *   pairs for topics not yet covered. This preserves good content from prior
 *   model versions (e.g. GLM-4.7) when regenerating with a new model.
 *
 * FORCE MODE:
 *   FORCE=true node scripts/analyze_docs.js
 *   Re-processes every page from scratch (pays for full regeneration). Still
 *   re-clones the repo to pick up latest content.
 *
 * SKIP_CLONE=true:
 *   Reuses existing .temp-docs/ directory (faster iteration while debugging
 *   prompts). The script will still process all canonical pages.
 *
 * MAX_FILES_TO_PROCESS=N:
 *   Process only the first N canonical pages (smoke-test the model).
 *
 * Prerequisites:
 *   1. Node.js installed
 *   2. NEAR_AI_API_KEY in .env file
 *   3. git available (for clone)
 *
 * Usage:
 *   node scripts/analyze_docs.js
 *
 * Output: docs_analysis.json in the project root (shape: { version, source,
 *   generatedAt, mode, model, qa_pairs, _files, _stats }). The flat qa_pairs
 *   array is preserved for backward compatibility with downstream consumers
 *   (generate_mcp_data.js auto-detects either shape).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

dotenv.config();

// Configuration
const FORCE = process.env.FORCE === 'true';
const SKIP_CLONE = process.env.SKIP_CLONE === 'true';
const NEAR_AI_MODEL = 'qwen/qwen3.7-max';
const DOC_REPO = 'https://github.com/OrderlyNetwork/documentation-public.git';
const TEMP_DIR = path.join(projectRoot, '.temp-docs');
const OUTPUT_FILE = path.join(projectRoot, 'docs_analysis.json');
// Set to 0/null to process all pages, or a number for smoke-testing
const MAX_FILES_TO_PROCESS = parseInt(process.env.MAX_FILES_TO_PROCESS || '0', 10) || null;
// Cap on legacy pairs passed to AI per page (token-budget guard)
const MAX_CONTEXT_PAIRS_PER_PAGE = 20;

const openai = new OpenAI({
  baseURL: 'https://cloud-api.near.ai/v1',
  apiKey: process.env.NEAR_AI_API_KEY || process.env.OPENAI_API_KEY,
  timeout: parseInt(process.env.NEAR_AI_TIMEOUT_MS || String(30 * 60 * 1000), 10),
  maxRetries: 0,
});

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Load existing analysis (any prior shape) and return both the cache map and
 * the flat list of pairs (for use as AI refinement context).
 */
function loadExistingData() {
  const empty = { loaded: false, files: {}, existingPairs: [] };
  if (FORCE) {
    console.log('⚠️  FORCE=true — ignoring existing cache (still loaded as AI context).\n');
    // Even in FORCE mode we want existing pairs for AI context
    return { ...empty, existingPairs: readExistingPairs() };
  }
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return empty;
    const raw = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));

    // Extract flat pairs regardless of format
    const existingPairs = Array.isArray(raw)
      ? raw
      : Array.isArray(raw.qa_pairs)
        ? raw.qa_pairs
        : [];

    // Extract cache map (only from v3.0.0+ with _files)
    if (raw && typeof raw === 'object' && raw._files && typeof raw._files === 'object') {
      return { loaded: true, files: raw._files, existingPairs };
    }

    // Legacy v2.0.0 (_chunks) or flat array — no per-file cache to reuse
    console.log(
      'ℹ️  Existing docs_analysis.json uses a prior format; rebuilding per-file cache.\n' +
        '   (Existing pairs will be passed to the AI as refinement context.)\n'
    );
    return { loaded: false, files: {}, existingPairs };
  } catch (e) {
    console.log(`⚠️  Could not load existing docs_analysis.json (${e.message}); rebuilding.`);
    return empty;
  }
}

function readExistingPairs() {
  try {
    if (!fs.existsSync(OUTPUT_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
    return Array.isArray(raw) ? raw : Array.isArray(raw.qa_pairs) ? raw.qa_pairs : [];
  } catch {
    return [];
  }
}

function computeFileFingerprint(route, content) {
  return crypto.createHash('md5').update(`${route}\n${content}`).digest('hex').substring(0, 12);
}

function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function buildOutput(fileMap, stats, repoCommit) {
  // Flatten all per-file QA pairs (preserves insertion order of `fileMap`).
  const qaPairs = [];
  for (const route of Object.keys(fileMap)) {
    const entry = fileMap[route];
    if (entry && Array.isArray(entry.qa_pairs)) {
      qaPairs.push(...entry.qa_pairs);
    }
  }
  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    mode: FORCE ? 'full-regeneration' : 'incremental',
    model: NEAR_AI_MODEL,
    source: {
      repo: DOC_REPO,
      commit: repoCommit || 'unknown',
    },
    qa_pairs: qaPairs,
    _files: fileMap,
    _stats: stats,
  };
}

// ---------------------------------------------------------------------------
// Repo clone (pattern copied from analyze_sdk.js)
// ---------------------------------------------------------------------------

function cloneRepo() {
  if (SKIP_CLONE && fs.existsSync(TEMP_DIR)) {
    console.log(`📦 SKIP_CLONE=true — reusing existing ${TEMP_DIR}`);
    return getRepoCommit();
  }

  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }

  console.log(`📦 Cloning ${DOC_REPO}...`);
  try {
    execSync(`git clone --depth 1 ${DOC_REPO} ${TEMP_DIR}`, {
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log('   ✅ Repo cloned');
    return getRepoCommit();
  } catch (e) {
    console.error(`❌ Failed to clone: ${e.message}`);
    process.exit(1);
  }
}

function getRepoCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: TEMP_DIR, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Page resolution + frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Load llms.config.json and build the work list:
 *   { route, section, file, title, description, content }
 *
 * `section` comes from a reverse lookup in compactSections — first section
 * whose routes include this canonical page wins. Pages not in any section
 * get section = 'General'.
 *
 * Skips pages under verification.readOnlyGeneratedDirectories (defensive —
 * canonical pages currently have none of these, but it's cheap insurance).
 */
function loadCanonicalPages() {
  const configPath = path.join(TEMP_DIR, 'llms.config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Missing ${configPath}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  const canonical = Array.isArray(config.canonicalPages) ? config.canonicalPages : [];
  const compactSections = Array.isArray(config.compactSections) ? config.compactSections : [];
  const skipDirs = config.verification?.readOnlyGeneratedDirectories || [];

  if (canonical.length === 0) {
    console.error('❌ llms.config.json has no canonicalPages array');
    process.exit(1);
  }

  // Reverse lookup: route -> section title
  const routeToSection = new Map();
  for (const section of compactSections) {
    for (const route of section.routes || []) {
      if (!routeToSection.has(route)) routeToSection.set(route, section.title);
    }
  }

  const pages = [];
  let skipped = 0;
  let missing = 0;

  for (const route of canonical) {
    // Skip generated dirs (already covered by other generators)
    if (skipDirs.some((dir) => route.startsWith(dir))) {
      skipped++;
      continue;
    }

    // Try .mdx then .md
    const mdxPath = path.join(TEMP_DIR, `${route}.mdx`);
    const mdPath = path.join(TEMP_DIR, `${route}.md`);
    // Also try route/index.mdx (directory-style routes)
    const indexMdxPath = path.join(TEMP_DIR, route, 'index.mdx');
    const indexMdPath = path.join(TEMP_DIR, route, 'index.md');

    let filePath = null;
    if (fs.existsSync(mdxPath)) filePath = mdxPath;
    else if (fs.existsSync(mdPath)) filePath = mdPath;
    else if (fs.existsSync(indexMdxPath)) filePath = indexMdxPath;
    else if (fs.existsSync(indexMdPath)) filePath = indexMdPath;

    if (!filePath) {
      console.warn(`   ⚠️  No file found for canonical route "${route}" — skipping.`);
      missing++;
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const section = routeToSection.get(route) || 'General';

    pages.push({
      route,
      section,
      file: filePath,
      title: frontmatter.title || route.split('/').pop(),
      description: frontmatter.description || '',
      content,
    });
  }

  console.log(
    `\n📄 Resolved ${pages.length} canonical pages` +
      (skipped ? `, skipped ${skipped} (generated dirs)` : '') +
      (missing ? `, ${missing} missing files` : '') +
      '.'
  );

  return pages;
}

/**
 * Very small frontmatter parser: reads `---\n...yaml...\n---` block at top
 * of file and extracts title/description. Returns {} if no frontmatter.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yamlBlock = match[1];
  const result = {};
  // Naive single-line key: value extraction (sufficient for title/description).
  const lines = yamlBlock.split('\n');
  for (const line of lines) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (m) {
      const key = m[1].trim();
      let value = m[2].trim();
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Keyword-based filtering of existing pairs for AI context
// ---------------------------------------------------------------------------

/**
 * Score existing pairs against the page's metadata (title, description,
 * section, route). Returns top N pairs whose question or answer mentions
 * any of the metadata keywords.
 */
function findRelevantExistingPairs(allPairs, page, maxN = MAX_CONTEXT_PAIRS_PER_PAGE) {
  if (!allPairs?.length) return [];
  const text = `${page.title} ${page.description} ${page.section} ${page.route}`.toLowerCase();
  const keywords = [
    ...new Set(
      text
        .split(/\W+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    ),
  ];
  if (keywords.length === 0) return [];

  const scored = allPairs.map((pair) => {
    const pairText = `${pair.question || ''} ${pair.answer || ''}`.toLowerCase();
    const score = keywords.reduce((s, k) => s + (pairText.includes(k) ? 1 : 0), 0);
    return { pair, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxN)
    .map((s) => s.pair);
}

// Tiny stopword set — keep small, this is just keyword-noise reduction.
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'your',
  'have',
  'will',
  'about',
  'into',
  'orderly',
  'network',
  'orderlynetwork',
  'page',
  'getting',
  'started',
  'introduction',
]);

// ---------------------------------------------------------------------------
// AI call with retry-on-any-error
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = [0, 30_000, 60_000, 120_000];

async function analyzePage(page, contextPairs) {
  console.log(
    `\n🔍 Analyzing "${page.route}" (${page.content.length} chars, section: ${page.section})`
  );

  const systemPrompt = `You are an expert technical documentation analyst. Your task is to read the provided Orderly Network documentation page and produce a clean set of developer-focused Q&A pairs.

CURRENT PAGE CONTEXT:
- Title: ${page.title}
- Description: ${page.description || '(none)'}
- Section: ${page.section}
- Route: ${page.route}

CRITICAL INSTRUCTIONS:
1. EXTRACT REAL Q&A: Identify questions developers would actually ask and provide complete, accurate answers from this page's content.
2. BE SPECIFIC: Include concrete details like endpoint URLs, function names, parameter names, code examples where available in the page.
3. NO FLUFF: Avoid vague answers. Every answer should be actionable and technically precise.
4. UPDATE EXISTING ANSWERS: If the EXISTING Q&A PAIRS section below contains a pair whose answer this page can improve, refine, correct, or extend, output the UPDATED version (preserving the question text where possible). Drop pairs that are now wrong if this page contradicts them.
5. AVOID DUPLICATES: Don't include a pair if an existing one already covers the topic adequately and this page adds nothing new.
6. ADD NEW: Add brand-new pairs for topics on this page not covered by existing pairs.
7. NO META-REFERENCES: Don't use phrases like "The documentation states" or "According to the docs". Provide direct answers as if you are the authoritative source.
8. NO DATES IN ANSWERS: Don't include specific dates, timelines, or version numbers unless they're part of API specifications.

Think like a developer reading this page for the first time. What would they need to know?

${
  contextPairs.length > 0
    ? `EXISTING Q&A PAIRS (relevant to this page — UPDATE these where the page content improves the answer, otherwise omit):\n${JSON.stringify(contextPairs, null, 2)}\n`
    : 'EXISTING Q&A PAIRS: (none relevant)\n'
}

Return ONLY valid JSON in this exact format:
{
  "qa_pairs": [
    {
      "question": "...",
      "answer": "...",
      "last_referenced_date": "YYYY-MM-DD"
    }
  ]
}

The returned array should contain BOTH updated versions of existing pairs AND brand-new pairs. Do not include unchanged existing pairs — only net additions and updates.`;

  const userPrompt = `--- DOCUMENTATION PAGE (${page.route}) ---
${page.content}
--- END PAGE ---

Generate the Q&A pairs this page should contribute, refining any relevant existing pairs.`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const waitMs = RETRY_BACKOFF_MS[attempt - 1];
      console.log(
        `   ⏳ Retry ${attempt}/${MAX_ATTEMPTS} for "${page.route}" in ${waitMs / 1000}s...`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }

    try {
      const completion = await openai.chat.completions.create({
        model: NEAR_AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });

      const response = completion.choices[0]?.message?.content;
      if (!response) throw new Error('Empty response from model');

      const parsed = JSON.parse(response);
      const pairs = parsed.qa_pairs || [];

      console.log(
        `   ✅ Extracted ${pairs.length} Q&A pairs (attempt ${attempt}/${MAX_ATTEMPTS}, context: ${contextPairs.length} legacy pairs)`
      );
      return pairs;
    } catch (error) {
      lastError = error;
      console.error(
        `   ❌ "${page.route}" attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error.message}`
      );
    }
  }

  console.error(
    `   💥 "${page.route}" failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError?.message}`
  );
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🚀 Starting documentation analysis (per-file from git repo)...\n');
  console.log(`   Mode:    ${FORCE ? 'FORCE (full regen)' : 'INCREMENTAL (cache-aware)'}`);
  console.log(`   Model:   ${NEAR_AI_MODEL}`);
  console.log(`   Source:  ${DOC_REPO}`);
  console.log(`   Clone:   ${SKIP_CLONE ? 'SKIP (reuse .temp-docs/)' : 'yes'}\n`);

  // 1. Clone repo
  const repoCommit = cloneRepo();

  // 2. Resolve canonical pages
  const pages = loadCanonicalPages();

  const pagesToProcess =
    MAX_FILES_TO_PROCESS && MAX_FILES_TO_PROCESS > 0 ? pages.slice(0, MAX_FILES_TO_PROCESS) : pages;
  if (MAX_FILES_TO_PROCESS && MAX_FILES_TO_PROCESS > 0) {
    console.log(
      `🔬 Smoke-test mode: processing only first ${pagesToProcess.length}/${pages.length} pages.`
    );
  }

  // 3. Load existing data (cache + legacy pairs for AI context)
  const existing = loadExistingData();
  if (existing.loaded) {
    console.log(
      `📦 Loaded cache: ${Object.keys(existing.files).length} previously-processed pages.`
    );
  }
  if (existing.existingPairs.length > 0) {
    console.log(
      `🧠 Loaded ${existing.existingPairs.length} existing Q&A pairs as AI refinement context.`
    );
  }

  // 4. Working state — preserve insertion order of pre-existing file keys
  const fileMap = { ...(existing.files || {}) };
  const seenRoutes = new Set(pagesToProcess.map((p) => p.route));
  const stats = {
    total: pagesToProcess.length,
    skipped: 0,
    processed: 0,
    failed: 0,
    totalQAPairs: 0,
  };

  for (let i = 0; i < pagesToProcess.length; i++) {
    const page = pagesToProcess[i];
    console.log(`\n[${i + 1}/${pagesToProcess.length}] ${page.route}`);

    const content = page.content;
    const fingerprint = computeFileFingerprint(page.route, content);
    const cached = fileMap[page.route];

    // Cache hit — skip AI call entirely
    if (cached && cached.fingerprint === fingerprint) {
      const n = (cached.qa_pairs || []).length;
      console.log(`  ⏭️  Cache hit (fingerprint unchanged). Reusing ${n} pairs.`);
      stats.skipped++;
      stats.totalQAPairs += n;
      continue;
    }

    // Cache miss — pick relevant existing pairs as refinement context
    const contextPairs = findRelevantExistingPairs(existing.existingPairs, page);

    const pairs = await analyzePage(page, contextPairs);

    if (pairs === null) {
      stats.failed++;
      if (cached) {
        console.log(
          `   Preserving cached ${cached.qa_pairs?.length || 0} pairs due to AI failure.`
        );
        stats.totalQAPairs += (cached.qa_pairs || []).length;
      } else {
        // Will retry on next run because no entry was written.
      }
      continue;
    }

    fileMap[page.route] = {
      fingerprint,
      title: page.title,
      description: page.description,
      section: page.section,
      qa_pairs: pairs,
    };
    stats.processed++;
    stats.totalQAPairs += pairs.length;

    // Checkpoint after each page (crash-safe)
    try {
      atomicWriteJson(OUTPUT_FILE, buildOutput(fileMap, stats, repoCommit));
    } catch (e) {
      console.error(`   ⚠️  Checkpoint write failed: ${e.message}`);
    }
  }

  // 5. Prune cache entries for routes no longer in the canonical set
  let prunedCount = 0;
  for (const route of Object.keys(fileMap)) {
    if (!seenRoutes.has(route)) {
      delete fileMap[route];
      prunedCount++;
    }
  }
  if (prunedCount > 0) {
    console.log(`\n🧹 Pruned ${prunedCount} cache entries for routes no longer in canonicalPages.`);
  }

  // 6. Final write
  try {
    atomicWriteJson(OUTPUT_FILE, buildOutput(fileMap, stats, repoCommit));
  } catch (e) {
    console.error(`\n❌ Final write failed: ${e.message}`);
    process.exit(1);
  }

  console.log('\n✅ Analysis complete!');
  console.log(`   Pages:    ${stats.total} total`);
  console.log(
    `             ${stats.processed} processed · ${stats.skipped} cached · ${stats.failed} failed`
  );
  console.log(`   Q&A pairs: ${stats.totalQAPairs} total`);
  console.log(`   Source:    ${repoCommit || 'unknown commit'}`);
  console.log(`   Output:    ${OUTPUT_FILE}`);
  console.log('\nNext step: Run generate_mcp_data.js to generate MCP server data files.');
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
