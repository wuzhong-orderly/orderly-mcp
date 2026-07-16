#!/usr/bin/env node

/**
 * generate_mcp_data.js
 *
 * This script processes docs_analysis.json using NEAR AI Cloud to generate
 * comprehensive MCP server data files.
 *
 * Optional input:
 *   - tg_analysis.json — if present, its Q&A pairs are merged with docs_analysis
 *     and contribute to documentation/workflows. If missing, generation
 *     proceeds with docs_analysis alone. (The Telegram pipeline that produced
 *     this file has been removed; the file is read opportunistically for
 *     backward compatibility with pre-existing artifacts.)
 *
 * INCREMENTAL MODE (default):
 *   Reads existing documentation.json and workflows.json. For each Q&A batch,
 *   computes a content fingerprint and reuses the cached result on hit. Only
 *   new/changed batches are sent to the AI. Checkpoint after every batch
 *   (crash-safe).
 *
 * FORCE MODE:
 *   FORCE=true node scripts/generate_mcp_data.js
 *   Re-processes every batch from scratch (pays for full regeneration).
 *
 * DEDUPE-ONLY MODE:
 *   DEDUPE_ONLY=true node scripts/generate_mcp_data.js
 *   No full regeneration. Reads existing documentation.json + workflows.json,
 *   free-dedupes near-duplicate doc chunks (keep longest), and AI-merges
 *   near-duplicate workflows. Preserves _batchCache. Cheap (~N small AI calls
 *   for workflow clusters only).
 *
 * UPSTREAM SHAPE (auto-detected):
 *   tg_analysis.json / docs_analysis.json may be either the legacy flat array
 *   of {question, answer, ...} OR the v2.0.0 object with a `qa_pairs` array.
 *   Both shapes are supported transparently.
 *
 * CHUNK ID FORMAT (v4.0.0):
 *   Documentation chunks now use stable batch-indexed IDs
 *   (`<category>-b<batchIdx>-c<k>`) so cached batches don't create gaps in the
 *   ID sequence. Previous sequential IDs (`<category>-<n>`) are replaced on
 *   the next full regeneration.
 *
 * Prerequisites:
 *   1. Node.js installed
 *   2. NEAR_AI_API_KEY in .env file
 *   3. docs_analysis.json from analyze_docs.js
 *
 * Usage:
 *   node scripts/generate_mcp_data.js
 *
 * Outputs:
 *   - src/data/documentation.json
 *   - src/data/workflows.json
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

dotenv.config();

// Configuration
const FORCE = process.env.FORCE === 'true';
const DEDUPE_ONLY = process.env.DEDUPE_ONLY === 'true';
const NEAR_AI_MODEL = 'qwen/qwen3.7-max';
const BATCH_SIZE = 200; // Process 200 Q&A pairs per API call (documentation chunks)
const WORKFLOW_BATCH_SIZE = 50; // Smaller batches for workflows — output is more complex
const RATE_LIMIT_DELAY = 1000; // 1 second between calls
// Near-dup clustering thresholds (title/content token Jaccard)
const DEDUPE_TITLE_STRICT = 0.75;
const DEDUPE_TITLE_SOFT = 0.45;
const DEDUPE_CONTENT_MIN = 0.7;
// Moderate thresholds for DEDUPE_ONLY candidate clustering (feeds AI merge).
// Wider net than strict so the AI can decide merge-vs-distinct on borderline pairs.
const DEDUPE_MODERATE = {
  titleStrict: 0.55,
  titleSoft: 0.3,
  contentMin: 0.55,
};

// Input files
const TG_ANALYSIS = path.join(projectRoot, 'tg_analysis.json');
const DOCS_ANALYSIS = path.join(projectRoot, 'docs_analysis.json');

// Output directory + files
const DATA_DIR = path.join(projectRoot, 'src', 'data');
const DOCUMENTATION_FILE = path.join(DATA_DIR, 'documentation.json');
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');

const openai = new OpenAI({
  baseURL: 'https://cloud-api.near.ai/v1',
  apiKey: process.env.NEAR_AI_API_KEY || process.env.OPENAI_API_KEY,
  // Per-request timeout. Default 30 min — batches can be large.
  // Override with NEAR_AI_TIMEOUT_MS env (milliseconds).
  timeout: parseInt(process.env.NEAR_AI_TIMEOUT_MS || String(30 * 60 * 1000), 10),
  maxRetries: 0, // we handle retries ourselves with longer backoff in callXxxAI
});

console.log('🚀 MCP Data Generation Pipeline\n');
console.log(
  `   Mode:  ${
    DEDUPE_ONLY
      ? 'DEDUPE_ONLY (no regen)'
      : FORCE
        ? 'FORCE (full regen)'
        : 'INCREMENTAL (cache-aware)'
  }`
);
console.log(`   Model: ${NEAR_AI_MODEL}\n`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read either the legacy flat-array shape or the v2.0.0 object shape and
 * always return a flat array of Q&A pairs.
 */
function readQAFile(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.qa_pairs)) return data.qa_pairs;
  return [];
}

/**
 * Content-addressable fingerprint of a batch of Q&A pairs.
 * Stable regardless of batch index — same content always maps to same hash.
 */
function computeBatchFingerprint(batch) {
  // Sort question+answer pairs so reordering within a batch doesn't invalidate.
  const normalized = batch
    .map((qa) => ({
      q: (qa.question || '').trim(),
      a: (qa.answer || '').trim(),
    }))
    .sort((a, b) => a.q.localeCompare(b.q));
  return crypto.createHash('md5').update(JSON.stringify(normalized)).digest('hex').substring(0, 12);
}

/**
 * Atomic JSON write: write to .tmp then rename. Prevents mid-write corruption.
 */
function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Load existing output file's cache map. Returns empty map if missing, FORCE'd,
 * or in an unexpected shape.
 */
function loadCache(filePath, cacheKey) {
  const empty = {};
  if (FORCE) return empty;
  try {
    if (!fs.existsSync(filePath)) return empty;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw && typeof raw[cacheKey] === 'object' && raw[cacheKey] !== null) {
      return raw[cacheKey];
    }
  } catch (e) {
    console.log(`⚠️  Could not load cache from ${filePath} (${e.message}); rebuilding.`);
  }
  return empty;
}

/**
 * Read flat array from an existing output file (any prior shape). Used to pass
 * existing chunks/workflows as AI refinement context.
 */
function readExistingArray(filePath, arrayKey) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(raw) ? raw : Array.isArray(raw[arrayKey]) ? raw[arrayKey] : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Near-duplicate detection + free/AI merge helpers
// ---------------------------------------------------------------------------

function tokenSet(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 2)
  );
}

function jaccard(a, b) {
  const ta = typeof a === 'string' ? tokenSet(a) : a;
  const tb = typeof b === 'string' ? tokenSet(b) : b;
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter++;
  }
  return inter / new Set([...ta, ...tb]).size;
}

/**
 * Are two items near-duplicates by title + content-prefix similarity?
 */
function isNearDuplicate(titleA, contentA, titleB, contentB, thresholds) {
  const titleStrict = thresholds?.titleStrict ?? DEDUPE_TITLE_STRICT;
  const titleSoft = thresholds?.titleSoft ?? DEDUPE_TITLE_SOFT;
  const contentMin = thresholds?.contentMin ?? DEDUPE_CONTENT_MIN;
  const titleSim = jaccard(titleA, titleB);
  if (titleSim >= titleStrict) return true;
  if (titleSim < titleSoft) return false;
  const contentSim = jaccard(String(contentA || '').slice(0, 1000), String(contentB || '').slice(0, 1000));
  return contentSim >= contentMin;
}

/**
 * Greedy cluster of near-duplicates.
 * @param {Array} items
 * @param {{ getTitle: (item) => string, getContent: (item) => string, sameBucket?: (a,b) => boolean }} opts
 * @returns {number[][]} clusters of original indices (only size >= 2)
 */
function clusterNearDuplicates(items, { getTitle, getContent, sameBucket, thresholds }) {
  const used = new Set();
  const clusters = [];
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const cluster = [i];
    const titleI = getTitle(items[i]);
    const contentI = getContent(items[i]);
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      if (sameBucket && !sameBucket(items[i], items[j])) continue;
      if (isNearDuplicate(titleI, contentI, getTitle(items[j]), getContent(items[j]), thresholds)) {
        cluster.push(j);
        used.add(j);
      }
    }
    if (cluster.length > 1) {
      used.add(i);
      clusters.push(cluster);
    }
  }
  return clusters;
}

/**
 * Score a doc chunk for "keep longest / richest" selection.
 */
function chunkRichness(chunk) {
  const contentLen = (chunk.content || '').length;
  const kwLen = (chunk.keywords || []).length;
  return contentLen * 1000 + kwLen;
}

/**
 * Free-dedupe documentation chunks: within each near-dup cluster keep the
 * richest chunk (longest content, then more keywords). Preserves ids of kept
 * chunks. Returns { chunks, stats }.
 */
function dedupeChunksKeepLongest(chunks) {
  if (!chunks?.length) return { chunks: [], stats: { before: 0, after: 0, dropped: 0, clusters: 0 } };

  const clusters = clusterNearDuplicates(chunks, {
    getTitle: (c) => c.title || '',
    getContent: (c) => c.content || '',
    sameBucket: (a, b) => (a.category || '') === (b.category || ''),
  });

  const drop = new Set();
  const dropLog = [];
  for (const cluster of clusters) {
    let bestIdx = cluster[0];
    let bestScore = chunkRichness(chunks[cluster[0]]);
    for (const idx of cluster.slice(1)) {
      const score = chunkRichness(chunks[idx]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }
    for (const idx of cluster) {
      if (idx !== bestIdx) {
        drop.add(idx);
        dropLog.push({
          dropped: chunks[idx].title,
          kept: chunks[bestIdx].title,
          category: chunks[idx].category,
        });
      }
    }
  }

  const kept = chunks.filter((_, i) => !drop.has(i));
  return {
    chunks: kept,
    stats: {
      before: chunks.length,
      after: kept.length,
      dropped: drop.size,
      clusters: clusters.length,
      dropLog,
    },
  };
}

// ---------------------------------------------------------------------------
// Topic-key clustering (union-find on distinctive 2-grams + 3-grams)
// ---------------------------------------------------------------------------

const TOPIC_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'via', 'from', 'into', 'using', 'your',
  'how', 'this', 'that', 'all', 'some', 'any', 'its', 'his', 'her',
  'their', 'can', 'you', 'not', 'but', 'are', 'was', 'has', 'have', 'had',
]);

function topicTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 3 && !TOPIC_STOPWORDS.has(t) && t !== 'orderly');
}

function topicKeyphrases(s) {
  const t = topicTokens(s);
  const out = [];
  for (let n = 2; n <= 3; n++) {
    for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n).join(' '));
  }
  return out;
}

/**
 * Union-find topic clustering. Edges from shared distinctive keyphrases
 * (2-grams + 3-grams, "orderly" excluded, appearing in 2-8 items) with a
 * jaccard gate >= 0.3 to prevent transitive over-chaining through weak
 * bridges. Also adds edges for very high title jaccard (>= 0.55).
 */
function buildTopicClusters(items, { getTitle, sameBucket }) {
  const phraseItems = {};
  items.forEach((it, i) => {
    for (const p of topicKeyphrases(getTitle(it))) {
      phraseItems[p] = phraseItems[p] || [];
      if (!phraseItems[p].includes(i)) phraseItems[p].push(i);
    }
  });
  const distinctive = Object.values(phraseItems).filter(
    (idxs) => idxs.length >= 2 && idxs.length <= 8
  );

  const parent = items.map((_, i) => i);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Keyphrase edge: shared distinctive phrase AND jaccard >= 0.3
  for (const idxs of distinctive) {
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        const a = items[idxs[i]], b = items[idxs[j]];
        if (sameBucket && !sameBucket(a, b)) continue;
        if (jaccard(getTitle(a), getTitle(b)) >= 0.3) union(idxs[i], idxs[j]);
      }
    }
  }
  // Overlay: very high jaccard (catches close variants)
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (sameBucket && !sameBucket(items[i], items[j])) continue;
      if (jaccard(getTitle(items[i]), getTitle(items[j])) >= 0.55) union(i, j);
    }
  }

  const comps = {};
  items.forEach((_, i) => {
    const r = find(i);
    comps[r] = comps[r] || [];
    comps[r].push(i);
  });
  return Object.values(comps).filter((c) => c.length >= 2);
}

/**
 * Exact-name dedupe for workflows (first wins). Already used at write time.
 */
function dedupeWorkflowsByExactName(workflows) {
  const seen = new Set();
  return workflows.filter((wf) => {
    const name = wf.name || '';
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function workflowRichness(wf) {
  return Buffer.byteLength(JSON.stringify(wf));
}

// ---------------------------------------------------------------------------
// AI family-merge (collapses a topic cluster into 1-2 canonical items)
// ---------------------------------------------------------------------------

/**
 * AI-merge a family of near-duplicate workflows into 1-2 canonical workflows.
 * Returns { distinct, workflows } — workflows is null when distinct or failure.
 */
async function mergeWorkflowFamilyAI(familyWorkflows) {
  const names = familyWorkflows.map((w) => w.name).join(' | ');
  const systemPrompt = `You merge a family of near-duplicate Orderly Network developer workflows into the MINIMUM number of canonical workflows.

GOAL: collapse this family. If they all describe the same procedure, return 1 workflow. Only split into 2 if user goals are genuinely different (e.g. "understand a concept" vs "execute an action"). Never keep 3+.

RULES:
1. If all workflows cover the same procedure (same goal, overlapping steps), merge into 1.
2. If there are 2 genuinely different goals (e.g. understanding vs executing), return 2. Never return 3+.
3. When merging:
   - Pick the clearest name. Each name must reflect the specific goal.
   - Union the best steps in logical order; drop pure duplicates.
   - Prefer concrete code snippets over vague descriptions.
   - Union prerequisites, commonIssues, relatedWorkflows (dedupe by text).
   - Do NOT invent APIs, endpoints, package names, or code that none of the inputs contain.
   - Keep commonIssues as objects {issue, solution} when possible.
4. Output ONLY valid JSON:
   {"distinct": true}
   {"workflows": [{"name":"...","description":"...","prerequisites":["..."],"steps":[{"title":"...","description":"...","code":"...","important":"..."}],"commonIssues":[{"issue":"...","solution":"..."}],"relatedWorkflows":["..."]}]}`;

  const userPrompt = `Collapse these ${familyWorkflows.length} near-duplicate workflows into the MINIMUM number of canonical workflows (1 or 2).

Workflows:
${JSON.stringify(familyWorkflows, null, 2)}

Return JSON only. Prefer 1 workflow. Only return 2 if goals are genuinely different.`;

  const MAX_ATTEMPTS = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) await delay(attempt * 5000);
      const completion = await openai.chat.completions.create({
        model: NEAR_AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });
      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) throw new Error('Empty response from model');
      const parsed = JSON.parse(responseContent);

      if (parsed.distinct === true) return { distinct: true, workflows: null };

      const wfs = Array.isArray(parsed.workflows) ? parsed.workflows : null;
      if (!wfs || wfs.length === 0 || wfs.length > 2) {
        throw new Error(
          `Invalid merge shape. keys=[${Object.keys(parsed).join(', ')}] count=${wfs?.length}`
        );
      }
      const normalized = wfs.map((wf) => ({
        name: wf.name || familyWorkflows[0].name,
        description: wf.description || familyWorkflows[0].description || '',
        prerequisites: Array.isArray(wf.prerequisites) ? wf.prerequisites : [],
        steps: (Array.isArray(wf.steps) ? wf.steps : []).map((s) => ({
          title: s.title || s.name || 'Step',
          description: s.description || '',
          ...(s.code ? { code: s.code } : {}),
          ...(s.important ? { important: s.important } : {}),
        })),
        ...(wf.commonIssues ? { commonIssues: wf.commonIssues } : {}),
        ...(wf.relatedWorkflows ? { relatedWorkflows: wf.relatedWorkflows } : {}),
      }));
      return { distinct: false, workflows: normalized };
    } catch (error) {
      lastError = error;
      console.error(
        `     ❌ Family merge attempt ${attempt}/${MAX_ATTEMPTS} for [${names.slice(0, 80)}] failed: ${error.message}`
      );
    }
  }
  console.error(`     💥 Family merge failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
  return null;
}

/**
 * AI-merge a family of near-duplicate doc chunks into 1-2 canonical chunks.
 * Returns { distinct, chunks } — chunks is null when distinct or failure.
 */
async function mergeDocFamilyAI(familyChunks) {
  const titles = familyChunks.map((c) => c.title).join(' | ');
  const systemPrompt = `You merge a family of near-duplicate Orderly Network documentation chunks into the MINIMUM number of canonical chunks (1 or 2).

GOAL: collapse this family. Merge into 1 chunk if they cover the same topic. Only split into 2 if the covered sub-topics are genuinely distinct. Never keep 3+.

RULES:
1. If all chunks cover the same topic (overlapping info), merge into 1.
2. If 2 genuinely distinct sub-topics exist, return 2 chunks. Never 3+.
3. When merging:
   - Pick the clearest title.
   - Combine unique information into one coherent narrative.
   - Preserve all concrete code examples, API names, package names, configuration values.
   - Do NOT invent information that none of the inputs contain.
   - Merge keywords arrays (dedupe, max 12 each).
4. Output ONLY valid JSON:
   {"distinct": true}
   {"chunks": [{"title":"...","content":"...","keywords":["...","..."]}]}`;

  const userPrompt = `Collapse these ${familyChunks.length} near-duplicate documentation chunks into the MINIMUM number of canonical chunks (1 or 2).

Category: ${familyChunks[0]?.category || 'unknown'}

Chunks:
${JSON.stringify(
  familyChunks.map((c) => ({ title: c.title, content: c.content, keywords: c.keywords })),
  null,
  2
)}

Return JSON only. Prefer 1 chunk.`;

  const MAX_ATTEMPTS = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) await delay(attempt * 5000);
      const completion = await openai.chat.completions.create({
        model: NEAR_AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });
      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) throw new Error('Empty response from model');
      const parsed = JSON.parse(responseContent);

      if (parsed.distinct === true) return { distinct: true, chunks: null };

      const chs = Array.isArray(parsed.chunks) ? parsed.chunks : null;
      if (!chs || chs.length === 0 || chs.length > 2) {
        throw new Error(
          `Invalid merge shape. keys=[${Object.keys(parsed).join(', ')}] count=${chs?.length}`
        );
      }
      const normalized = chs.map((ch) => ({
        title: ch.title || familyChunks[0].title,
        content: ch.content || '',
        category: familyChunks[0]?.category || '',
        keywords: Array.isArray(ch.keywords)
          ? ch.keywords.slice(0, 12)
          : familyChunks[0]?.keywords || [],
      }));
      return { distinct: false, chunks: normalized };
    } catch (error) {
      lastError = error;
      console.error(
        `     ❌ Doc family merge attempt ${attempt}/${MAX_ATTEMPTS} for [${titles.slice(0, 80)}] failed: ${error.message}`
      );
    }
  }
  console.error(`     💥 Doc family merge failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
  return null;
}

/**
 * Apply topic-key AI family-merge across all workflow clusters.
 * On AI failure: keep-longest fallback. On distinct: keep all.
 */
async function mergeNearDuplicateWorkflows(workflows) {
  const clusters = buildTopicClusters(workflows, {
    getTitle: (wf) => wf.name || wf.title || '',
  });
  if (clusters.length === 0) {
    return {
      workflows,
      stats: { before: workflows.length, after: workflows.length, clusters: 0, merged: 0, keptDistinct: 0, fallbacks: 0 },
    };
  }

  console.log(`   Found ${clusters.length} topic-family cluster(s)`);
  const drop = new Set();
  const replacements = []; // { replaceIdx, workflows: [...] }
  let merged = 0;
  let keptDistinct = 0;
  let fallbacks = 0;

  for (let c = 0; c < clusters.length; c++) {
    const idxs = clusters[c];
    const members = idxs.map((i) => workflows[i]);
    console.log(
      `   Cluster ${c + 1}/${clusters.length} (size ${idxs.length}): ${members
        .map((m) => m.name.slice(0, 50))
        .join(' || ')}`
    );

    const result = await mergeWorkflowFamilyAI(members);
    await delay(RATE_LIMIT_DELAY);

    if (!result) {
      // Fallback: keep-longest only
      let bestIdx = idxs[0];
      let bestScore = workflowRichness(members[0]);
      for (let k = 1; k < idxs.length; k++) {
        const score = workflowRichness(members[k]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = idxs[k];
        }
      }
      for (const idx of idxs) if (idx !== bestIdx) drop.add(idx);
      console.log(`     ⚠️  Fallback keep-longest → "${workflows[bestIdx].name}"`);
      fallbacks++;
      continue;
    }

    if (result.distinct) {
      console.log(`     ↩️  Marked distinct — keeping all ${idxs.length}`);
      keptDistinct++;
      continue;
    }

    // Replace all members with AI-merged 1-2 workflows
    replacements.push({ replaceIdx: idxs[0], workflows: result.workflows });
    for (const idx of idxs) if (idx !== idxs[0]) drop.add(idx);
    console.log(
      `     ✅ Merged → ${result.workflows.map((w) => `"${w.name}" (${w.steps.length} steps)`).join(' + ')}`
    );
    merged++;
  }

  const out = [];
  for (let i = 0; i < workflows.length; i++) {
    if (drop.has(i)) continue;
    const rep = replacements.find((r) => r.replaceIdx === i);
    if (rep) out.push(...rep.workflows);
    else out.push(workflows[i]);
  }

  return {
    workflows: out,
    stats: {
      before: workflows.length,
      after: out.length,
      clusters: clusters.length,
      merged,
      keptDistinct,
      fallbacks,
    },
  };
}

/**
 * Apply topic-key AI family-merge across all doc chunk clusters.
 * On AI failure: keep-longest fallback. On distinct: keep all.
 */
async function mergeNearDuplicateChunks(chunks) {
  const clusters = buildTopicClusters(chunks, {
    getTitle: (c) => c.title || '',
    sameBucket: (a, b) => (a.category || '') === (b.category || ''),
  });
  if (clusters.length === 0) {
    return {
      chunks,
      stats: { before: chunks.length, after: chunks.length, clusters: 0, merged: 0, keptDistinct: 0, fallbacks: 0 },
    };
  }

  console.log(`   Found ${clusters.length} topic-family cluster(s)`);
  const drop = new Set();
  const replacements = []; // { replaceIdx, chunks: [...] }
  let merged = 0;
  let keptDistinct = 0;
  let fallbacks = 0;

  for (let c = 0; c < clusters.length; c++) {
    const idxs = clusters[c];
    const members = idxs.map((i) => chunks[i]);
    console.log(
      `   Cluster ${c + 1}/${clusters.length} (size ${idxs.length}): ${members
        .map((m) => m.title.slice(0, 50))
        .join(' || ')}`
    );

    const result = await mergeDocFamilyAI(members);
    await delay(RATE_LIMIT_DELAY);

    if (!result) {
      let bestIdx = idxs[0];
      let bestScore = chunkRichness(chunks[idxs[0]]);
      for (const idx of idxs.slice(1)) {
        const score = chunkRichness(chunks[idx]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = idx;
        }
      }
      for (const idx of idxs) if (idx !== bestIdx) drop.add(idx);
      console.log(`     ⚠️  Fallback keep-longest → "${chunks[bestIdx].title}"`);
      fallbacks++;
      continue;
    }

    if (result.distinct) {
      console.log(`     ↩️  Marked distinct — keeping all ${idxs.length}`);
      keptDistinct++;
      continue;
    }

    // Replace all members with AI-merged 1-2 chunks (preserve id from richest)
    let bestIdx = idxs[0];
    let bestScore = chunkRichness(chunks[idxs[0]]);
    for (const idx of idxs.slice(1)) {
      const score = chunkRichness(chunks[idx]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }
    const mergedWithIds = result.chunks.map((ch, k) => ({
      ...ch,
      id: k === 0 ? chunks[bestIdx].id : `${chunks[bestIdx].id}-s${k}`,
    }));
    replacements.push({ replaceIdx: idxs[0], chunks: mergedWithIds });
    for (const idx of idxs) if (idx !== idxs[0]) drop.add(idx);
    console.log(
      `     ✅ Merged → ${result.chunks.map((ch) => `"${ch.title}" (${ch.content.length} chars)`).join(' + ')}`
    );
    merged++;
  }

  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    if (drop.has(i)) continue;
    const rep = replacements.find((r) => r.replaceIdx === i);
    if (rep) out.push(...rep.chunks);
    else out.push(chunks[i]);
  }

  return {
    chunks: out,
    stats: {
      before: chunks.length,
      after: out.length,
      clusters: clusters.length,
      merged,
      keptDistinct,
      fallbacks,
    },
  };
}

/**
 * DEDUPE_ONLY mode: rewrite existing documentation.json + workflows.json
 * without regenerating from upstream Q&A. Uses topic-key union-find clustering
 * + AI family-merge (collapses each topic family to 1-2 canonical items).
 */
async function runDedupeOnly() {
  console.log('🧹 DEDUPE_ONLY — topic-key clustering + AI family-merge\n');

  if (!process.env.NEAR_AI_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error('❌ NEAR_AI_API_KEY (or OPENAI_API_KEY) required for AI merge.');
    process.exit(1);
  }

  if (!fs.existsSync(DOCUMENTATION_FILE)) {
    console.error(`❌ Missing ${DOCUMENTATION_FILE}`);
    process.exit(1);
  }
  if (!fs.existsSync(WORKFLOWS_FILE)) {
    console.error(`❌ Missing ${WORKFLOWS_FILE}`);
    process.exit(1);
  }

  // --- documentation.json (topic-key AI family-merge) ---
  console.log('📄 Deduping documentation.json (topic-key + AI family-merge)...');
  const docRaw = JSON.parse(fs.readFileSync(DOCUMENTATION_FILE, 'utf-8'));

  // Quick strict free pre-pass (catches any exact-title dups from re-runs)
  const { chunks: strictChunks, stats: strictStats } = dedupeChunksKeepLongest(docRaw.chunks || []);
  if (strictStats.dropped > 0) {
    console.log(`   Strict free: ${strictStats.before} → ${strictStats.after} (−${strictStats.dropped})`);
  }

  // Topic-key AI family-merge on survivors
  const { chunks: mergedChunks, stats: docStats } = await mergeNearDuplicateChunks(strictChunks);
  console.log(
    `   Topic AI: ${strictChunks.length} → ${mergedChunks.length} (clusters=${docStats.clusters}, merged=${docStats.merged}, distinct=${docStats.keptDistinct}, fallbacks=${docStats.fallbacks})`
  );
  console.log(`   Total: ${docRaw.chunks?.length || 0} → ${mergedChunks.length}`);

  const docOut = {
    ...docRaw,
    chunks: mergedChunks,
    metadata: {
      ...(docRaw.metadata || {}),
      lastUpdated: new Date().toISOString().split('T')[0],
      totalChunks: mergedChunks.length,
      deduped: true,
      dedupeDropped: strictStats.dropped + (strictChunks.length - mergedChunks.length),
    },
  };
  if (docRaw._batchCache) docOut._batchCache = docRaw._batchCache;
  atomicWriteJson(DOCUMENTATION_FILE, docOut);
  console.log(`   ✅ Wrote ${DOCUMENTATION_FILE}\n`);

  // --- workflows.json (exact-name free + topic-key AI family-merge) ---
  console.log('🔄 Deduping workflows.json (topic-key + AI family-merge)...');
  const wfRaw = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf-8'));
  let workflows = dedupeWorkflowsByExactName(wfRaw.workflows || []);
  const exactDropped = (wfRaw.workflows || []).length - workflows.length;
  if (exactDropped > 0) {
    console.log(`   Exact-name dedupe: dropped ${exactDropped}`);
  }

  const { workflows: mergedWorkflows, stats: wfStats } = await mergeNearDuplicateWorkflows(workflows);
  console.log(
    `   ${wfStats.before} → ${wfStats.after} workflows (clusters=${wfStats.clusters}, merged=${wfStats.merged}, distinct=${wfStats.keptDistinct}, fallbacks=${wfStats.fallbacks})`
  );

  const wfOut = {
    ...wfRaw,
    workflows: mergedWorkflows,
    metadata: {
      ...(wfRaw.metadata || {}),
      lastUpdated: new Date().toISOString().split('T')[0],
      totalWorkflows: mergedWorkflows.length,
      deduped: true,
      dedupeMergedClusters: wfStats.merged,
    },
  };
  if (wfRaw._batchCache) wfOut._batchCache = wfRaw._batchCache;
  atomicWriteJson(WORKFLOWS_FILE, wfOut);
  console.log(`   ✅ Wrote ${WORKFLOWS_FILE}\n`);

  console.log('✅ DEDUPE_ONLY complete.');
  console.log(`   documentation: ${docRaw.chunks?.length || 0} → ${mergedChunks.length}`);
  console.log(`   workflows:     ${wfRaw.workflows?.length || 0} → ${mergedWorkflows.length}`);
}

// Q&A-category -> keyword map. Used to find existing chunks relevant to a batch.
const CATEGORY_KEYWORDS = {
  SDK: ['sdk', 'hook', 'react', 'component', 'package', 'install'],
  API: ['api', 'endpoint', 'rest', 'websocket', 'request'],
  Trading: ['trade', 'trading', 'market', 'orderbook', 'perpetual'],
  Authentication: ['auth', 'sign', 'signature', 'login', 'eip-712', 'ed25519'],
  Wallet: ['wallet', 'metamask', 'connect', 'rainbow'],
  Orders: ['order', 'limit', 'market', 'cancel', 'post_only', 'ioc', 'fok'],
  Positions: ['position', 'leverage', 'margin', 'pnl', 'liquidation'],
  Deposits: ['deposit', 'fund', 'vault'],
  Withdrawals: ['withdraw', 'withdrawal'],
  Subaccounts: ['subaccount', 'sub-account', 'delegate', 'sharing'],
  Errors: ['error', 'fail', 'issue', 'bug', 'troubleshoot'],
  Configuration: ['config', 'setup', 'init', 'initialize', 'setting'],
  Other: [],
};

/**
 * Filter existing chunks by keyword overlap with the Q&A category. Caps at
 * maxN to stay within token budget.
 */
function findRelevantChunks(allChunks, category, maxN = 12) {
  if (!allChunks?.length) return [];
  const keywords = CATEGORY_KEYWORDS[category] || [];
  if (keywords.length === 0) return allChunks.slice(0, maxN);
  return allChunks
    .filter((c) => {
      const text =
        `${c.title || ''} ${(c.keywords || []).join(' ')} ${c.category || ''}`.toLowerCase();
      return keywords.some((k) => text.includes(k));
    })
    .slice(0, maxN);
}

// ---------------------------------------------------------------------------
// Q&A categorization (unchanged from original)
// ---------------------------------------------------------------------------

function categorizeQA(qaPairs) {
  const categories = {
    SDK: [],
    API: [],
    Trading: [],
    Authentication: [],
    Wallet: [],
    Orders: [],
    Positions: [],
    Deposits: [],
    Withdrawals: [],
    Subaccounts: [],
    Errors: [],
    Configuration: [],
    Other: [],
  };

  const keywords = {
    SDK: ['sdk', 'hook', 'component', 'react', 'install', 'npm', 'package'],
    API: ['api', 'endpoint', 'rest', 'websocket', 'ws', 'request', 'response'],
    Trading: ['trade', 'trading', 'market', 'limit', 'orderbook', 'price'],
    Authentication: ['auth', 'login', 'sign', 'signature', 'authenticate', 'key'],
    Wallet: ['wallet', 'connect', 'metamask', 'rainbow', 'walletconnect'],
    Orders: ['order', 'place order', 'cancel order', 'order status'],
    Positions: ['position', 'leverage', 'margin', 'liquidation', 'pnl'],
    Deposits: ['deposit', 'fund', 'add funds'],
    Withdrawals: ['withdraw', 'withdrawal', 'remove funds'],
    Subaccounts: ['subaccount', 'sub-account', 'delegate'],
    Errors: ['error', 'fail', 'bug', 'issue', 'problem', 'troubleshoot'],
    Configuration: ['config', 'setup', 'initialize', 'init', 'setting'],
  };

  for (const qa of qaPairs) {
    const text = (qa.question + ' ' + qa.answer).toLowerCase();
    let matched = false;

    for (const [category, words] of Object.entries(keywords)) {
      if (words.some((word) => text.includes(word))) {
        categories[category].push(qa);
        matched = true;
        break;
      }
    }

    if (!matched) {
      categories['Other'].push(qa);
    }
  }

  return categories;
}

// ---------------------------------------------------------------------------
// Documentation generation (with per-batch caching)
// ---------------------------------------------------------------------------

async function generateDocumentation(tgData, docsData) {
  console.log('📝 Generating documentation.json...\n');

  const allQA = [...tgData, ...docsData];
  const categorized = categorizeQA(allQA);

  console.log('   Categories found:');
  for (const [cat, items] of Object.entries(categorized)) {
    if (items.length > 0) {
      console.log(`     - ${cat}: ${items.length} entries`);
    }
  }

  const batchCache = loadCache(DOCUMENTATION_FILE, '_batchCache');
  const existingChunks = readExistingArray(DOCUMENTATION_FILE, 'chunks');
  if (existingChunks.length > 0) {
    console.log(`🧠 Loaded ${existingChunks.length} existing chunks as AI refinement context.`);
  }
  const usedFingerprints = new Set(); // tracks which cache entries were used this run (for pruning)

  // Final ordered list of [category, batchIdx, fingerprint, chunks[]]
  const orderedBatches = [];
  let stats = { total: 0, processed: 0, skipped: 0, failed: 0 };

  for (const [category, qaPairs] of Object.entries(categorized)) {
    if (qaPairs.length === 0) continue;

    console.log(`\n   Processing ${category} (${qaPairs.length} entries)...`);
    const batches = chunkArray(qaPairs, BATCH_SIZE);

    for (let i = 0; i < batches.length; i++) {
      stats.total++;
      const batch = batches[i];
      const fingerprint = computeBatchFingerprint(batch);
      console.log(
        `     Batch ${i + 1}/${batches.length} (${batch.length} entries) fp=${fingerprint}`
      );

      let chunks = null;

      // Cache hit — reuse without AI call
      if (batchCache[fingerprint]) {
        chunks = batchCache[fingerprint].chunks;
        console.log(`     ⏭️  Cache hit. Reusing ${chunks.length} chunks.`);
        stats.skipped++;
      } else {
        // Cache miss — call AI. Pass existing chunks relevant to this category as
        // refinement context (so the AI updates rather than discards).
        const relevantExisting = findRelevantChunks(existingChunks, category);
        chunks = await callDocumentationAI(category, i, batch, relevantExisting);
        if (chunks === null) {
          stats.failed++;
          console.log(`     ⚠️  Batch failed; no result written (will retry next run).`);
          continue;
        }
        console.log(`     ✅ Generated ${chunks.length} chunks`);
        stats.processed++;
        batchCache[fingerprint] = { category, chunks };
      }

      usedFingerprints.add(fingerprint);
      orderedBatches.push({ category, batchIdx: i, chunks });

      // Checkpoint after each batch
      writeDocumentationCheckpoint(
        orderedBatches,
        batchCache,
        usedFingerprints,
        categorized,
        tgData,
        docsData
      );

      // Rate limit
      if (i < batches.length - 1) {
        await delay(RATE_LIMIT_DELAY);
      }
    }
  }

  // Prune orphaned cache entries (fingerprints not seen this run)
  let prunedCount = 0;
  for (const fp of Object.keys(batchCache)) {
    if (!usedFingerprints.has(fp)) {
      delete batchCache[fp];
      prunedCount++;
    }
  }
  if (prunedCount > 0) {
    console.log(`\n   🧹 Pruned ${prunedCount} orphaned cache entries.`);
  }

  // Final write with stable batch-indexed IDs
  writeDocumentationCheckpoint(
    orderedBatches,
    batchCache,
    usedFingerprints,
    categorized,
    tgData,
    docsData
  );

  const totalChunks = orderedBatches.reduce((sum, b) => sum + b.chunks.length, 0);
  console.log(
    `\n   ✅ Done: ${totalChunks} chunks from ${orderedBatches.length} batches ` +
      `(processed ${stats.processed}, cached ${stats.skipped}, failed ${stats.failed})\n`
  );
}

/**
 * Fallback parser: try to extract a chunks-like array from a model response
 * that didn't use the expected `{ "chunks": [...] }` shape. Looks for:
 *   1. Top-level "chunks" (primary, already checked by caller but double-check)
 *   2. Common alternative key names: "documentation", "items", "results", "data"
 *   3. Deep-search: first array of objects where every element has a "content"
 *      field (the one field every chunk must have)
 * Returns the array or null.
 */
function extractChunksArray(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // 1. Primary key
  if (Array.isArray(obj.chunks) && obj.chunks.length > 0) return obj.chunks;

  // 2. Common alternative key names
  const altKeys = ['documentation', 'items', 'results', 'data', 'docs'];
  for (const key of altKeys) {
    if (Array.isArray(obj[key]) && obj[key].length > 0 && looksLikeChunks(obj[key])) {
      return obj[key];
    }
  }

  // 3. Deep-search: first array of objects that all have a "content" field
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && value.length > 0 && looksLikeChunks(value)) {
      return value;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = extractChunksArray(value);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Heuristic: does every element in the array look like a documentation chunk?
 * Must be an object with at least a "content" field.
 */
function looksLikeChunks(arr) {
  return arr.every(
    (el) => el && typeof el === 'object' && typeof el.content === 'string' && el.content.length > 10
  );
}

/**
 * Fallback parser for workflows: deep-search for any array of objects that
 * look like workflows (have at least a "steps" field). Mirrors extractChunksArray.
 */
function extractWorkflowsArray(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // 1. Primary key
  if (Array.isArray(obj.workflows) && obj.workflows.length > 0) return obj.workflows;

  // 2. Common alternative key names
  const altKeys = ['items', 'results', 'data', 'guides'];
  for (const key of altKeys) {
    if (Array.isArray(obj[key]) && obj[key].length > 0 && looksLikeWorkflows(obj[key])) {
      return obj[key];
    }
  }

  // 3. Deep-search: first array of objects that all have a "steps" field
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && value.length > 0 && looksLikeWorkflows(value)) {
      return value;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = extractWorkflowsArray(value);
      if (nested) return nested;
    }
  }
  return null;
}

function looksLikeWorkflows(arr) {
  return arr.every(
    (el) =>
      el &&
      typeof el === 'object' &&
      (Array.isArray(el.steps) || typeof el.description === 'string')
  );
}

/**
 * Calls AI to generate documentation chunks for one batch. Returns array of
 * chunks (without final `id` assigned — IDs assigned at flatten time) or null
 * on failure.
 *
 * @param existingChunks - prior chunks relevant to this category, passed as
 *   refinement context so the AI updates rather than starting fresh.
 */
async function callDocumentationAI(category, batchIdx, batch, existingChunks = []) {
  const existingBlock =
    existingChunks.length > 0
      ? `\nEXISTING CHUNKS FOR THIS CATEGORY (UPDATE these where the new Q&A pairs provide better info or contradict them; otherwise omit unchanged):\n${JSON.stringify(
          existingChunks.map(({ id: _id, ...rest }) => rest),
          null,
          2
        )}\n`
      : '\nEXISTING CHUNKS FOR THIS CATEGORY: (none relevant)\n';

  const prompt = `Generate comprehensive documentation chunks for the "${category}" category based on these Q&A pairs from Orderly Network developers.

Q&A Pairs:
${JSON.stringify(batch, null, 2)}

Instructions:
1. Create 3-8 documentation chunks that cover the key topics in these Q&A pairs.
2. Each chunk should be a complete, self-contained guide or explanation.
3. Include practical code examples where relevant.
4. Address common issues and solutions.
5. Make content actionable for developers.
6. WHERE EXISTING CHUNKS ARE PROVIDED: refine them based on the new Q&A pairs (preserve what's still accurate, update what's improved, merge related ones). Brand-new chunks are welcome for topics not yet covered. Do not include unchanged existing chunks in your output — only net additions and updates.
${existingBlock}
Return ONLY this JSON object — no markdown fences, no prose outside JSON:

{
  "chunks": [
    {
      "title": "descriptive title",
      "category": "one of [Overview, SDK, API, Trading, Operations, Infrastructure, Security, Troubleshooting, FAQ]",
      "content": "full markdown content with examples",
      "keywords": ["term1", "term2", "term3", "term4", "term5"]
    }
  ]
}

The response MUST be a JSON object with a top-level "chunks" key whose value is an array. Do NOT nest chunks under any other key. Do NOT include an "id" field — it will be assigned by the caller.`;

  const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
  const RETRY_BACKOFF_MS = [0, 30_000, 60_000, 120_000];
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const waitMs = RETRY_BACKOFF_MS[attempt - 1];
      console.log(
        `     ⏳ Retry ${attempt}/${MAX_ATTEMPTS} for ${category} batch ${batchIdx + 1} in ${waitMs / 1000}s...`
      );
      await delay(waitMs);
    }

    try {
      const completion = await openai.chat.completions.create({
        model: NEAR_AI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert technical documentation writer for Orderly Network. ' +
              'Generate comprehensive, practical documentation chunks from developer Q&A pairs. ' +
              'Return ONLY valid JSON — no markdown fences, no prose outside the JSON object. ' +
              'The top-level key MUST be "chunks" and its value MUST be an array of chunk objects.',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });

      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) throw new Error('Empty response from model');

      const parsedResponse = JSON.parse(responseContent);

      // Primary path: top-level "chunks" array
      // Fallback: deep-search for any array of objects that look like chunks
      // (have at least a "content" field), in case the model nested or
      // mis-named the key.
      const chunksArray = extractChunksArray(parsedResponse);

      if (chunksArray && chunksArray.length > 0) {
        // Strip any id the model may have added — we assign stable IDs at write time.
        console.log(
          `     ✅ Generated ${chunksArray.length} chunks (attempt ${attempt}/${MAX_ATTEMPTS})`
        );
        return chunksArray.map(({ id: _id, ...rest }) => rest);
      }

      // Log what we actually got so the failure is debuggable
      const preview = JSON.stringify(parsedResponse).slice(0, 500);
      throw new Error(
        `No 'chunks' array in model response. Got keys: [${Object.keys(parsedResponse).join(', ')}]. Preview: ${preview}`
      );
    } catch (error) {
      lastError = error;
      console.error(
        `     ❌ ${category} batch ${batchIdx + 1} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error.message}`
      );
    }
  }

  console.error(
    `     💥 ${category} batch ${batchIdx + 1} failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError?.message}`
  );
  return null;
}

/**
 * Write documentation.json with stable batch-indexed IDs (`<cat>-b<i>-c<k>`).
 * Inline because the output is needed both as checkpoint and final write.
 */
function writeDocumentationCheckpoint(
  orderedBatches,
  batchCache,
  usedFingerprints,
  categorized,
  tgData,
  docsData
) {
  // Flatten with stable IDs assigned by current batch position.
  const allChunks = [];
  for (const { category, batchIdx, chunks } of orderedBatches) {
    chunks.forEach((chunk, k) => {
      allChunks.push({
        ...chunk,
        id: `${category.toLowerCase()}-b${batchIdx}-c${k}`,
      });
    });
  }

  // Free near-dup collapse (keep longest/richest per cluster). Cache still
  // holds per-batch originals for incremental reuse; only the published
  // `chunks` array is deduped.
  const { chunks: dedupedChunks, stats: dedupeStats } = dedupeChunksKeepLongest(allChunks);
  if (dedupeStats.dropped > 0) {
    console.log(
      `   🧹 Doc near-dup collapse: ${dedupeStats.before} → ${dedupeStats.after} (−${dedupeStats.dropped})`
    );
  }

  // Prune cache inline so checkpoints don't accumulate orphans either.
  const prunedCache = {};
  for (const fp of usedFingerprints) {
    if (batchCache[fp]) prunedCache[fp] = batchCache[fp];
  }

  const output = {
    chunks: dedupedChunks,
    metadata: {
      version: '4.0.0',
      lastUpdated: new Date().toISOString().split('T')[0],
      totalChunks: dedupedChunks.length,
      idFormat: 'stable-batch-indexed (<category>-b<batchIdx>-c<k>)',
      source: `Generated from ${tgData.length} Telegram + ${docsData.length} Docs Q&A entries`,
      categories: Object.entries(categorized)
        .filter(([_, items]) => items.length > 0)
        .map(([cat, items]) => ({ name: cat, count: items.length })),
      ...(dedupeStats.dropped > 0
        ? { deduped: true, dedupeDropped: dedupeStats.dropped }
        : {}),
    },
    _batchCache: prunedCache,
  };

  atomicWriteJson(DOCUMENTATION_FILE, output);
}

// ---------------------------------------------------------------------------
// Workflows generation (with per-batch caching)
// ---------------------------------------------------------------------------

async function generateWorkflows(tgData, docsData) {
  console.log('🔄 Generating workflows.json...\n');

  const howToQuestions = [...tgData, ...docsData].filter(
    (qa) =>
      qa.question.toLowerCase().includes('how do') ||
      qa.question.toLowerCase().includes('how to') ||
      qa.question.toLowerCase().includes('how can') ||
      qa.question.toLowerCase().includes('steps') ||
      qa.question.toLowerCase().includes('process') ||
      qa.question.toLowerCase().includes('guide') ||
      qa.question.toLowerCase().includes('tutorial')
  );

  console.log(`   Found ${howToQuestions.length} how-to questions`);

  const batches = chunkArray(howToQuestions, WORKFLOW_BATCH_SIZE);
  const batchCache = loadCache(WORKFLOWS_FILE, '_batchCache');
  const existingWorkflows = readExistingArray(WORKFLOWS_FILE, 'workflows');
  if (existingWorkflows.length > 0) {
    console.log(
      `🧠 Loaded ${existingWorkflows.length} existing workflows as AI refinement context.`
    );
  }
  const usedFingerprints = new Set();
  const allWorkflows = [];
  let stats = { total: batches.length, processed: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const fingerprint = computeBatchFingerprint(batch);
    console.log(
      `   Batch ${i + 1}/${batches.length} (${batch.length} questions) fp=${fingerprint}`
    );

    let workflows = null;

    if (batchCache[fingerprint]) {
      workflows = batchCache[fingerprint].workflows;
      console.log(`   ⏭️  Cache hit. Reusing ${workflows.length} workflows.`);
      stats.skipped++;
    } else {
      workflows = await callWorkflowsAI(batch, i, existingWorkflows);
      if (workflows === null) {
        stats.failed++;
        console.log(`   ⚠️  Batch failed; will retry next run.`);
        continue;
      }
      console.log(`   ✅ Generated ${workflows.length} workflows`);
      stats.processed++;
      batchCache[fingerprint] = { workflows };
    }

    usedFingerprints.add(fingerprint);
    allWorkflows.push(...workflows);

    // Checkpoint
    writeWorkflowsCheckpoint(allWorkflows, batchCache, usedFingerprints, howToQuestions.length);

    if (i < batches.length - 1) {
      await delay(RATE_LIMIT_DELAY);
    }
  }

  // Prune orphans
  for (const fp of Object.keys(batchCache)) {
    if (!usedFingerprints.has(fp)) delete batchCache[fp];
  }

  // Final write
  writeWorkflowsCheckpoint(allWorkflows, batchCache, usedFingerprints, howToQuestions.length);

  // Deduplicate workflows by name (display only — preserves cache)
  const seen = new Set();
  const uniqueWorkflows = allWorkflows.filter((wf) => {
    if (seen.has(wf.name)) return false;
    seen.add(wf.name);
    return true;
  });

  // Re-write with deduped workflows (cache unchanged)
  const finalOutput = {
    workflows: uniqueWorkflows,
    metadata: {
      version: '2.0.0',
      totalWorkflows: uniqueWorkflows.length,
      generatedFrom: howToQuestions.length,
      lastUpdated: new Date().toISOString().split('T')[0],
    },
    _batchCache: batchCache,
  };
  atomicWriteJson(WORKFLOWS_FILE, finalOutput);

  console.log(
    `   ✅ Done: ${uniqueWorkflows.length} unique workflows ` +
      `(processed ${stats.processed}, cached ${stats.skipped}, failed ${stats.failed})\n`
  );
}

async function callWorkflowsAI(batch, batchIdx, existingWorkflows = []) {
  const existingBlock =
    existingWorkflows.length > 0
      ? `\nEXISTING WORKFLOWS (UPDATE these where the new questions provide better info or additional steps; otherwise omit unchanged):\n${JSON.stringify(existingWorkflows, null, 2)}\n`
      : '\nEXISTING WORKFLOWS: (none)\n';

  const prompt = `Create step-by-step workflows from these how-to questions about Orderly Network.

Questions and Answers:
${JSON.stringify(batch, null, 2)}

Instructions:
1. Extract 2-5 distinct workflows from these questions.
2. Each workflow should have clear, actionable steps.
3. Include code examples where relevant.
4. Add common issues and troubleshooting tips.
5. Group related workflows together.
6. WHERE EXISTING WORKFLOWS ARE PROVIDED: refine them based on the new questions (preserve what's still accurate, update what's improved, merge related ones). Brand-new workflows are welcome for topics not yet covered. Do not include unchanged existing workflows in your output — only net additions and updates.
${existingBlock}
Return ONLY this JSON object — no markdown fences, no prose outside JSON:

{
  "workflows": [
    {
      "name": "workflow name",
      "description": "what it accomplishes",
      "prerequisites": ["what you need"],
      "steps": [
        {
          "title": "step title",
          "description": "step description",
          "code": "optional code snippet",
          "important": "optional important note (string, not array)"
        }
      ],
      "commonIssues": [
        { "issue": "common problem", "solution": "how to fix it" }
      ],
      "relatedWorkflows": ["related workflow name"]
    }
  ]
}

The response MUST be a JSON object with a top-level "workflows" key whose value is an array.`;

  const MAX_ATTEMPTS = 4; // 1 initial + 3 retries
  const RETRY_BACKOFF_MS = [0, 30_000, 60_000, 120_000];
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const waitMs = RETRY_BACKOFF_MS[attempt - 1];
      console.log(
        `   ⏳ Retry ${attempt}/${MAX_ATTEMPTS} for batch ${batchIdx + 1} in ${waitMs / 1000}s...`
      );
      await delay(waitMs);
    }

    try {
      const completion = await openai.chat.completions.create({
        model: NEAR_AI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert at creating step-by-step technical workflows for Orderly Network developers. ' +
              'Return ONLY valid JSON — no markdown fences, no prose outside the JSON object. ' +
              'The top-level key MUST be "workflows" and its value MUST be an array of workflow objects.',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });

      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) throw new Error('Empty response from model');

      const parsedResponse = JSON.parse(responseContent);

      // Primary path: top-level "workflows" array
      // Fallback: deep-search for any array of objects that look like workflows
      // (have at least a "steps" field)
      const workflowsArray = extractWorkflowsArray(parsedResponse);

      if (workflowsArray && workflowsArray.length > 0) {
        console.log(
          `   ✅ Generated ${workflowsArray.length} workflows (attempt ${attempt}/${MAX_ATTEMPTS})`
        );
        return workflowsArray;
      }

      const preview = JSON.stringify(parsedResponse).slice(0, 500);
      throw new Error(
        `No 'workflows' array in model response. Got keys: [${Object.keys(parsedResponse).join(', ')}]. Preview: ${preview}`
      );
    } catch (error) {
      lastError = error;
      console.error(
        `   ❌ Batch ${batchIdx + 1} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${error.message}`
      );
    }
  }

  console.error(
    `   💥 Batch ${batchIdx + 1} failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError?.message}`
  );
  return null;
}

function writeWorkflowsCheckpoint(allWorkflows, batchCache, usedFingerprints, sourceCount) {
  // Exact-name dedupe at write time so partial-progress checkpoints don't
  // include duplicates from re-runs. Near-dup AI merge is opt-in via DEDUPE_ONLY
  // (avoids surprise AI cost on every incremental generation).
  const uniqueWorkflows = dedupeWorkflowsByExactName(allWorkflows);

  // Prune cache inline.
  const prunedCache = {};
  for (const fp of usedFingerprints) {
    if (batchCache[fp]) prunedCache[fp] = batchCache[fp];
  }

  const output = {
    workflows: uniqueWorkflows,
    metadata: {
      version: '2.0.0',
      totalWorkflows: uniqueWorkflows.length,
      generatedFrom: sourceCount,
      lastUpdated: new Date().toISOString().split('T')[0],
    },
    _batchCache: prunedCache,
  };

  atomicWriteJson(WORKFLOWS_FILE, output);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (DEDUPE_ONLY) {
    try {
      await runDedupeOnly();
    } catch (error) {
      console.error('\n❌ Error during dedupe:', error.message);
      console.error(error.stack);
      process.exit(1);
    }
    return;
  }

  console.log('⏳ Starting generation...\n');

  // tg_analysis.json is OPTIONAL — read opportunistically if present.
  let tgData = [];
  if (fs.existsSync(TG_ANALYSIS)) {
    tgData = readQAFile(TG_ANALYSIS);
    console.log(`📖 Loaded tg_analysis.json (${tgData.length} entries) — optional input.`);
  } else {
    console.log(`ℹ️  tg_analysis.json not found — proceeding with docs_analysis.json only.`);
  }

  // docs_analysis.json is REQUIRED.
  if (!fs.existsSync(DOCS_ANALYSIS)) {
    console.error(`❌ Missing: ${DOCS_ANALYSIS}`);
    console.error('   Run: node scripts/analyze_docs.js');
    process.exit(1);
  }

  const docsData = readQAFile(DOCS_ANALYSIS);
  console.log(`   Docs Q&A: ${docsData.length} entries\n`);

  try {
    await generateDocumentation(tgData, docsData);
    await generateWorkflows(tgData, docsData);

    console.log('✅ All data files generated successfully!');
    console.log('\nGenerated files:');
    console.log('  - src/data/documentation.json');
    console.log('  - src/data/workflows.json');
    console.log('\nNext step: yarn build && yarn test:run');
  } catch (error) {
    console.error('\n❌ Error during generation:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
