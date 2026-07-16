/*
 * analyze_telegram_chats.js
 *
 * This script analyzes Telegram chat transcripts (plain-text .txt chat logs
 * produced by clean_telegram_export.js) using NEAR AI Cloud API to extract
 * DevRel-related questions and answers about Orderly Network.
 *
 * Input format: telegram_chats_filtered/<Name>.txt — a clean, preprocessed
 * chat log (header + transcript body). The transcript is sent to the AI
 * as-is. Legacy .json files (pre-migration raw Telegram exports) are also
 * accepted as a backward-compat fallback and preprocessed on the fly.
 *
 * INCREMENTAL MODE (default):
 *   Reads existing tg_analysis.json and skips chat files whose content
 *   hash matches the stored fingerprint. Only new/changed files are sent
 *   to the AI. A checkpoint is written after EVERY file (crash-safe).
 *
 * FORCE MODE:
 *   FORCE=true node scripts/analyze_telegram_chats.js
 *   Re-analyzes every file from scratch (pays for full regeneration).
 *
 * MAX_FILES_TO_PROCESS=N:
 *   Process only the first N chat files (for testing).
 *
 * PROMPT_VERSION:
 *   Baked into every file's fingerprint. Bumping the constant invalidates
 *   the whole cache on the next run, guaranteeing the corpus reflects the
 *   current prompt. Use this when the system prompt changes meaningfully.
 *
 * Cache-invalidation note: switching from .json to .txt changes every file's
 * content hash → all cache entries miss on the first run after migration.
 * This is intentional and one-time; subsequent runs are cached as normal.
 *
 * Prerequisites:
 *   1. Node.js installed.
 *   2. NEAR_AI_API_KEY in .env file.
 *   3. Run `node scripts/clean_telegram_export.js` first to produce the .txt
 *      chat logs in telegram_chats_filtered/.
 *
 * Usage:
 *   node scripts/analyze_telegram_chats.js
 *
 * Output: tg_analysis.json in the project root (shape: { version, generatedAt,
 *   mode, model, qa_pairs, _sources, _stats }). The flat `qa_pairs` array is
 *   preserved for backward compatibility with downstream consumers that expect
 *   the legacy flat-array shape.
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
const NEAR_AI_MODEL = 'qwen/qwen3.7-max';
const CHAT_EXPORTS_DIR = 'telegram_chats_filtered';
const FINAL_ANALYSIS_PATH = path.join(projectRoot, 'tg_analysis.json');
// Set to null or Infinity to process all, or a number for testing
const MAX_FILES_TO_PROCESS = null;
// Hard cap on transcript tokens sent to the AI. Transcripts exceeding this are
// truncated to the LATEST messages (tail) at a message boundary. Rough 4 chars
// per token, so 50k tokens ≈ 200k chars. Keeps cost predictable + avoids the
// model dropping the tail of long chats under context pressure.
const MAX_TRANSCRIPT_TOKENS = 50_000;
const CHARS_PER_TOKEN = 4;
const MAX_TRANSCRIPT_CHARS = MAX_TRANSCRIPT_TOKENS * CHARS_PER_TOKEN;

// Number of chat files to process in parallel. Each file triggers one AI call
// (with retries), so this directly controls how many calls are in-flight.
// Set to 1 for sequential (debug-friendly); 5 is a good default for throughput.
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);

// Bump this when the system prompt changes meaningfully — invalidates cache.
const PROMPT_VERSION = 2;

// Cap on Q&A pairs passed to AI as refinement/dedup context (mirrors docs script).
const MAX_CONTEXT_PAIRS = 30;

// Retry config (mirrors analyze_docs.js — catches any error, not just rate-limit).
const MAX_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = [0, 30_000, 60_000, 120_000];

// Preprocessing fallback for legacy .json files (raw Telegram exports from
// the pre-migration cleanup script). Kept here only so old cache entries can
// be regenerated if a .json file lingers in the filter directory. New cleanup
// runs emit .txt — no preprocessing is done in the analyzer for those.
const BLOCKED_SENDERS = (process.env.BLOCKED_SENDERS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const MIN_MESSAGE_LENGTH = parseInt(process.env.MIN_MESSAGE_LENGTH || '10', 10);
const URL_ONLY_PATTERN = /^\s*https?:\/\/\S+\s*$/;

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
 * Load existing analysis (if present and not bypassed by FORCE).
 * @returns {{ loaded: boolean, sources: Record<string, {fingerprint: string, qa_pairs: any[]}>, existingPairs: any[] }}
 */
function loadExistingData() {
  const empty = { loaded: false, sources: {}, existingPairs: [] };
  if (FORCE) {
    console.log('⚠️  FORCE=true — ignoring existing cache, full regeneration.\n');
    return empty;
  }
  try {
    if (!fs.existsSync(FINAL_ANALYSIS_PATH)) return empty;
    const raw = JSON.parse(fs.readFileSync(FINAL_ANALYSIS_PATH, 'utf-8'));
    // Backward compat: legacy format was a bare array — no per-file cache to reuse.
    if (Array.isArray(raw)) {
      console.log('ℹ️  Existing tg_analysis.json is legacy flat-array format; rebuilding cache.');
      return empty;
    }
    if (!raw._sources || typeof raw._sources !== 'object') {
      console.log('ℹ️  Existing tg_analysis.json missing _sources map; rebuilding cache.');
      return empty;
    }
    const sources = raw._sources;
    // Flatten all per-file Q&A pairs into one list for cross-file context.
    const existingPairs = [];
    for (const file of Object.keys(sources)) {
      const entry = sources[file];
      if (entry && Array.isArray(entry.qa_pairs)) existingPairs.push(...entry.qa_pairs);
    }
    return { loaded: true, sources, existingPairs };
  } catch (e) {
    console.log(`⚠️  Could not load existing tg_analysis.json (${e.message}); rebuilding.`);
    return empty;
  }
}

/**
 * md5-based fingerprint of (PROMPT_VERSION + filename + file content). 12 hex chars.
 * Filename is included so renaming a file invalidates the cache.
 * PROMPT_VERSION is included so prompt changes invalidate the cache.
 */
function computeFileFingerprint(filename, content) {
  return crypto
    .createHash('md5')
    .update(`v${PROMPT_VERSION}\n${filename}\n${content}`)
    .digest('hex')
    .substring(0, 12);
}

/**
 * Atomic JSON write: write to .tmp then rename. Prevents mid-write corruption
 * if the process is killed during the write.
 */
function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function buildOutput(sources, stats) {
  // Flatten all per-file QA pairs (preserves insertion order of `sources`).
  const qaPairs = [];
  for (const file of Object.keys(sources)) {
    const entry = sources[file];
    if (entry && Array.isArray(entry.qa_pairs)) {
      qaPairs.push(...entry.qa_pairs);
    }
  }
  return {
    version: '2.0.0',
    generatedAt: new Date().toISOString(),
    mode: FORCE ? 'full-regeneration' : 'incremental',
    model: NEAR_AI_MODEL,
    promptVersion: PROMPT_VERSION,
    qa_pairs: qaPairs,
    _sources: sources,
    _stats: stats,
  };
}

// ---------------------------------------------------------------------------
// Cross-file context: pick relevant prior Q&A pairs by chat-name keyword
// ---------------------------------------------------------------------------

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
  'chat',
  'group',
  'official',
]);

/**
 * Score existing Q&A pairs against the chat's display name. Returns top N
 * pairs whose question or answer mentions any of the chat-name keywords.
 * Mirrors analyze_docs.js's findRelevantExistingPairs.
 */
function findRelevantExistingPairs(allPairs, chatName, maxN = MAX_CONTEXT_PAIRS) {
  if (!allPairs?.length || !chatName) return [];
  const keywords = [
    ...new Set(
      String(chatName)
        .toLowerCase()
        .split(/\W+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 2 && !STOPWORDS.has(w))
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

/**
 * Merge same-file cached pairs (for refinement) with cross-file filtered pairs
 * (for dedup), dedupe by question text, cap at MAX_CONTEXT_PAIRS.
 */
function mergeContextPairs(sameFilePairs, crossFilePairs) {
  const seen = new Set();
  const merged = [];
  for (const pair of [...(sameFilePairs || []), ...(crossFilePairs || [])]) {
    const key = String(pair.question || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(pair);
    if (merged.length >= MAX_CONTEXT_PAIRS) break;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Transcript loading (.txt primary, .json legacy fallback)
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a Telegram message's `text` field, handling all 3
 * forms the export can produce (string / array-of-entities / single-object).
 * Used only by the legacy .json fallback path.
 */
function extractText(message) {
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.text)) {
    return message.text.map((e) => (typeof e === 'string' ? e : e?.text || '')).join('');
  }
  if (message.text && typeof message.text === 'object') {
    return message.text.text || '';
  }
  return '';
}

function compactDate(rawDate) {
  if (!rawDate) return 'unknown-date';
  const m = String(rawDate).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : String(rawDate);
}

/**
 * Legacy fallback: build a transcript from a raw Telegram JSON export.
 * Mirrors clean_telegram_export.js's preprocessing so a stale .json file in
 * the filter dir can still be analyzed. Prefer running cleanup to produce .txt.
 */
function preprocessMessages(messages) {
  const kept = [];
  if (!Array.isArray(messages)) return kept;
  for (const msg of messages) {
    if (msg.type === 'service') continue;
    const sender = String(msg.from || msg.from_id || '');
    if (BLOCKED_SENDERS.length > 0) {
      const senderLower = sender.toLowerCase();
      if (BLOCKED_SENDERS.some((b) => senderLower.includes(b))) continue;
    }
    const text = extractText(msg).trim();
    if (!text) continue;
    if (URL_ONLY_PATTERN.test(text)) continue;
    if (text.length < MIN_MESSAGE_LENGTH) continue;
    kept.push({ date: compactDate(msg.date), from: sender || 'Unknown', text });
  }
  return kept;
}

function formatChatTranscript(cleanMessages) {
  return cleanMessages
    .map((m) => {
      if (m.text.includes('\n')) {
        return `[${m.date}] ${m.from}:\n${m.text}`;
      }
      return `[${m.date}] ${m.from}: ${m.text}`;
    })
    .join('\n\n');
}

/**
 * Parse the `# Chat:` / `# Stats:` header block from a cleanup .txt file.
 * Returns { chatName, dateRange, messageCount } or null if no header.
 *   - chatName: display string ("Orderly | Solana") or null
 *   - dateRange: 'YYYY-MM-DD..YYYY-MM-DD' parsed from message timestamps, or null
 *   - messageCount: kept-message count from `# Stats:`, or null
 */
function parseTranscriptHeader(content) {
  const headerEnd = content.indexOf('\n\n');
  if (headerEnd === -1) return null;
  const headerBlock = content.slice(0, headerEnd);
  if (!headerBlock.split('\n').every((l) => l.startsWith('#'))) return null;

  let chatName = null;
  let messageCount = null;
  const chatMatch = headerBlock.match(/^# Chat:\s*(.+)$/m);
  if (chatMatch) chatName = chatMatch[1].trim();
  const statsMatch = headerBlock.match(/^# Stats:\s*\d+\s+raw\s+messages?\s*→\s*(\d+)\s+kept/mi);
  if (statsMatch) messageCount = parseInt(statsMatch[1], 10);
  return { chatName, messageCount };
}

/**
 * Walk a transcript body to find the earliest and latest date stamps.
 * Looks for [YYYY-MM-DD HH:MM] markers at line starts.
 */
function deriveDateRange(transcript) {
  const stamps = [];
  const re = /^\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}\]/gm;
  let m;
  while ((m = re.exec(transcript)) !== null) stamps.push(m[1]);
  if (stamps.length === 0) return null;
  stamps.sort();
  return `${stamps[0]}..${stamps[stamps.length - 1]}`;
}

/**
 * Truncate a transcript to the LATEST N chars (tail), at a message boundary.
 * Messages are separated by '\n\n'. Walks from the end and accumulates whole
 * messages until the budget is exceeded, then returns the rejoined tail.
 *
 * If the transcript fits within the budget, returns it unchanged.
 *
 * @param {string} transcript       Full chat transcript
 * @param {number} maxChars         Character budget (e.g. MAX_TRANSCRIPT_CHARS)
 * @returns {{ transcript: string, truncated: boolean, droppedCount: number, keptCount: number }}
 */
function truncateToLatest(transcript, maxChars) {
  if (transcript.length <= maxChars) {
    return { transcript, truncated: false, droppedCount: 0, keptCount: 0 };
  }

  // Split on the message separator while preserving boundaries.
  // '\n\n' is the separator used by formatChatTranscript.
  const messages = transcript.split('\n\n');
  const kept = [];
  let keptChars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // +2 accounts for the '\n\n' separator that rejoins will add.
    const additional = msg.length + (kept.length > 0 ? 2 : 0);
    if (keptChars + additional > maxChars) break;
    kept.unshift(msg);
    keptChars += additional;
  }

  return {
    transcript: kept.join('\n\n'),
    truncated: true,
    droppedCount: messages.length - kept.length,
    keptCount: kept.length,
  };
}

/**
 * Load a chat transcript from a file. .txt files (the current cleanup output)
 * are returned with the `# Chat:` header block stripped (but parsed first so
 * chatName/dateRange/messageCount can be passed to the AI as metadata).
 * Legacy .json files are preprocessed on the fly so old cache entries can
 * still regenerate.
 *
 * Returns: { transcript, chatName, dateRange, messageCount, rawMessageCount }
 */
function loadTranscript(fileInfo) {
  const ext = path.extname(fileInfo.name).toLowerCase();

  if (ext === '.txt') {
    const content = fs.readFileSync(fileInfo.path, 'utf-8');
    const headerEnd = content.indexOf('\n\n');
    const startsWithHeader =
      headerEnd !== -1 &&
      content
        .slice(0, headerEnd)
        .split('\n')
        .every((l) => l.startsWith('#'));
    const header = startsWithHeader ? parseTranscriptHeader(content) : null;
    const transcript = startsWithHeader ? content.slice(headerEnd + 2) : content;
    const dateRange = deriveDateRange(transcript);
    return {
      transcript,
      chatName: header?.chatName || null,
      dateRange,
      messageCount: header?.messageCount ?? null,
      rawMessageCount: null,
    };
  }

  // Legacy .json fallback — derive metadata from the raw Telegram fields.
  const chatData = JSON.parse(fs.readFileSync(fileInfo.path, 'utf-8'));
  const chatName = typeof chatData.name === 'string' ? chatData.name : fileInfo.name;
  const messages = Array.isArray(chatData.messages) ? chatData.messages : [];
  const kept = preprocessMessages(messages);
  const transcript = formatChatTranscript(kept);
  const dateRange = deriveDateRange(transcript);
  return {
    transcript,
    chatName,
    dateRange,
    messageCount: kept.length,
    rawMessageCount: messages.length,
  };
}

// ---------------------------------------------------------------------------
// AI call with retry-on-any-error (mirrors analyze_docs.js)
// ---------------------------------------------------------------------------

async function analyzeChatWithAI(transcript, fileInfo, chatMeta, contextPairs) {
  const ctxN = contextPairs.length;
  console.log(
    `  Analyzing ${fileInfo.name} with NEAR AI (context: ${ctxN} pairs${chatMeta.chatName ? `, chat: "${chatMeta.chatName}"` : ''})...`
  );

  const systemPrompt = `You are an expert technical DevRel analyst for Orderly Network. Read the chat transcript and extract developer-focused Q&A pairs about: SDK usage, REST and WebSocket APIs, trading mechanics, troubleshooting errors, configuration, deposits/withdrawals, and similar developer-centric topics.

OUTPUT SCHEMA — return ONLY this JSON, no markdown fences, no prose:
{
  "qa_pairs": [
    {
      "question": "...",
      "answer": "...",
      "last_referenced_date": "YYYY-MM-DD"
    }
  ]
}

CORRECTNESS RULES:
1. ACCURACY: Answer the question that was actually asked. Differentiate near-synonyms (deposit vs withdraw, mainnet vs testnet, EVM vs Solana, etc.) — do not drift to related-but-distinct topics.
2. NO PERSONAL INFORMATION: Drop names, @mentions, and individual attributions. Use "Orderly team" or "support" instead.
3. NO DATE-SPECIFIC CONTENT: No "available May 27", "next Monday", "last week", etc. Focus on generally-available functionality.
4. NO META-REFERENCES: No "the chat says", "according to the thread", "as discussed here", "the transcript shows". Provide direct, standalone answers as if you are the authoritative source.
5. ACTIONABILITY: Include endpoint URLs, function names, parameter names, short code snippets, or doc pointers when the transcript provides them.
6. LINK HANDLING: Include a single URL only if it deep-links to API/SDK reference that directly clarifies the answer AND no textual summary is available in the transcript. Otherwise describe where to find it textually.
7. INCOMPLETE INFO: If the transcript confirms a feature but gives no actionable details, say so explicitly (e.g., "The feature exists, but specific implementation details were not provided").

CONTEXT PAIR HANDLING:
The PREVIOUSLY EXTRACTED Q&A pairs below came from THIS chat (refine them if the current transcript contains better or more recent info) AND from OTHER chats (use them only to avoid duplicates — if an existing pair already answers a question adequately, drop the new candidate).
DO NOT echo back unchanged existing pairs. Return ONLY:
  (a) brand-new pairs, OR
  (b) REFINED/UPDATED versions of existing pairs (preserve the question text where possible).
last_referenced_date: use the date stamp (YYYY-MM-DD) of the transcript message(s) you derived the answer from. If refining an existing pair and the current transcript provides newer info, use the newer date.

PREVIOUSLY EXTRACTED Q&A PAIRS (keyword-filtered, capped at ${MAX_CONTEXT_PAIRS}):
${JSON.stringify(contextPairs, null, 2)}

If no new or significantly refined Q&A pairs are found, return { "qa_pairs": [] }.`;

  const metaLines = [
    `Chat: ${chatMeta.chatName || '(unknown)'}`,
    chatMeta.dateRange ? `Date range: ${chatMeta.dateRange}` : null,
    chatMeta.messageCount != null ? `Messages: ${chatMeta.messageCount}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const userPrompt = `${metaLines}

--- TRANSCRIPT ---
${transcript}
--- END TRANSCRIPT ---

Extract NEW Q&A pairs or REFINED versions of existing ones. Do not echo back unchanged pairs.`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const waitMs = RETRY_BACKOFF_MS[attempt - 1];
      console.log(`   ⏳ Retry ${attempt}/${MAX_ATTEMPTS} in ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    try {
      const completion = await openai.chat.completions.create({
        model: NEAR_AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) throw new Error('Empty response from model');

      const parsedResponse = JSON.parse(responseContent);
      if (!parsedResponse.qa_pairs || !Array.isArray(parsedResponse.qa_pairs)) {
        throw new Error("Response missing 'qa_pairs' array");
      }
      if (attempt > 1) {
        console.log(`   ✅ Recovered on attempt ${attempt}/${MAX_ATTEMPTS}`);
      }
      return parsedResponse.qa_pairs;
    } catch (error) {
      lastError = error;
      const msg = error.message || String(error);
      console.warn(`   ⚠️  Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${fileInfo.name}: ${msg}`);
      // Continue to next attempt (backoff happens at top of loop)
    }
  }

  console.error(
    `   ❌ All ${MAX_ATTEMPTS} attempts failed for ${fileInfo.name}. Last error: ${lastError?.message || lastError}`
  );
  return null; // signal transient failure so caller preserves cached entry
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🚀 Starting analysis of Telegram chat exports...');
  console.log(`   Mode:  ${FORCE ? 'FORCE (full regen)' : 'INCREMENTAL (cache-aware)'}`);
  console.log(
    `   Model: ${NEAR_AI_MODEL}  (prompt v${PROMPT_VERSION}, ${MAX_ATTEMPTS} attempts, ${MAX_CONTEXT_PAIRS} ctx cap, ${CONCURRENCY} parallel)\n`
  );

  const chatExportsDir = path.join(projectRoot, CHAT_EXPORTS_DIR);

  if (!fs.existsSync(chatExportsDir)) {
    console.error(`❌ Error: Directory not found: ${chatExportsDir}`);
    console.error('   Please run: node scripts/clean_telegram_export.js');
    process.exit(1);
  }

  const chatFiles = fs
    .readdirSync(chatExportsDir)
    .filter((file) => {
      const ext = path.extname(file).toLowerCase();
      return ext === '.txt' || ext === '.json';
    })
    .map((file) => ({
      name: file,
      path: path.join(chatExportsDir, file),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (chatFiles.length === 0) {
    console.error(`❌ Error: No .txt or .json chat files found in ${chatExportsDir}`);
    console.error('   Run: node scripts/clean_telegram_export.js');
    process.exit(1);
  }

  const filesToProcess =
    MAX_FILES_TO_PROCESS && MAX_FILES_TO_PROCESS !== Infinity
      ? chatFiles.slice(0, MAX_FILES_TO_PROCESS)
      : chatFiles;

  console.log(`Found ${chatFiles.length} chat files total.`);
  if (MAX_FILES_TO_PROCESS && MAX_FILES_TO_PROCESS !== Infinity) {
    console.log(`Limiting to first ${filesToProcess.length} files for testing.`);
  }

  // Load cache (empty if FORCE)
  const existing = loadExistingData();
  if (existing.loaded) {
    console.log(
      `📦 Loaded cache: ${Object.keys(existing.sources).length} previously-processed files ` +
        `(${existing.existingPairs.length} flattened Q&A pairs for cross-file context).`
    );
  }

  // Working state — preserve insertion order of pre-existing source keys.
  const sources = { ...(existing.sources || {}) };
  const stats = {
    total: filesToProcess.length,
    skipped: 0,
    processed: 0,
    failed: 0,
    totalQAPairs: 0,
  };

  // Serialized checkpoint writes — prevents concurrent file writes from
  // clobbering each other when CONCURRENCY > 1. Each call chains after the
  // previous write completes; the returned promise resolves when this write is done.
  let writeLock = Promise.resolve();
  function checkpoint() {
    writeLock = writeLock.then(() => {
      try {
        atomicWriteJson(FINAL_ANALYSIS_PATH, buildOutput(sources, stats));
      } catch (e) {
        console.error(`  ⚠️  Checkpoint write failed: ${e.message}`);
      }
    });
    return writeLock;
  }

  /**
   * Process a single chat file: read, fingerprint, cache-check, load transcript,
   * truncate, build context, call AI, write result. All log lines are prefixed
   * with a tag so interleaved concurrent output stays traceable.
   */
  async function processFile(fileInfo, index) {
    const tag = `[${index + 1}/${filesToProcess.length}] ${fileInfo.name}`;
    console.log(`\n${tag}`);

    let fileContent;
    try {
      fileContent = fs.readFileSync(fileInfo.path, 'utf-8');
    } catch (e) {
      console.error(`  ${tag} ❌ Could not read file: ${e.message}`);
      stats.failed++;
      return;
    }

    const fingerprint = computeFileFingerprint(fileInfo.name, fileContent);
    const cached = sources[fileInfo.name];

    // Cache hit — skip AI call entirely
    if (cached && cached.fingerprint === fingerprint) {
      const n = (cached.qa_pairs || []).length;
      console.log(`  ${tag} ⏭️  Cache hit (fingerprint unchanged). Reusing ${n} cached pairs.`);
      stats.skipped++;
      stats.totalQAPairs += n;
      return;
    }

    // Load transcript (.txt primary; legacy .json preprocessed on the fly)
    let chatMeta;
    let formattedChat;
    try {
      const loaded = loadTranscript(fileInfo);
      chatMeta = loaded;
      if (loaded.rawMessageCount !== null) {
        console.log(`  ${tag} Read ${loaded.rawMessageCount} raw messages (legacy .json).`);
      } else {
        console.log(`  ${tag} Read .txt transcript.`);
      }
      if (loaded.chatName) {
        console.log(
          `  ${tag} Chat: "${loaded.chatName}"${loaded.dateRange ? `, ${loaded.dateRange}` : ''}`
        );
      }

      formattedChat = loaded.transcript;
      if (!formattedChat.trim()) {
        console.warn(`  ${tag} ⚠️  No usable text in transcript, skipping.`);
        stats.failed++;
        return;
      }

      // Truncate to the LATEST MAX_TRANSCRIPT_TOKENS if over budget.
      const trunc = truncateToLatest(formattedChat, MAX_TRANSCRIPT_CHARS);
      if (trunc.truncated) {
        formattedChat = trunc.transcript;
        console.log(
          `  ${tag} ✂️  Truncated to latest ${MAX_TRANSCRIPT_TOKENS.toLocaleString()} tokens ` +
            `(${trunc.keptCount} kept, ${trunc.droppedCount} dropped).`
        );
      }
      const charCount = formattedChat.length;
      const approxTokens = Math.ceil(charCount / CHARS_PER_TOKEN);
      console.log(`  ${tag} Transcript: ${charCount} chars (~${approxTokens.toLocaleString()} tokens)`);
    } catch (e) {
      console.error(`  ${tag} ❌ Parse error: ${e.message}`);
      stats.failed++;
      return;
    }

    // Build context: same-file cached pairs (for refinement) + cross-file
    // keyword-filtered pairs (for dedup). Deduped + capped at MAX_CONTEXT_PAIRS.
    const sameFilePairs = (cached && cached.qa_pairs) || [];
    const crossFilePairs = findRelevantExistingPairs(
      existing.existingPairs,
      chatMeta.chatName || fileInfo.name
    );
    const contextPairs = mergeContextPairs(sameFilePairs, crossFilePairs);
    console.log(
      `  ${tag} Context: ${sameFilePairs.length} same-file + ${crossFilePairs.length} cross-file → ${contextPairs.length} merged (cap ${MAX_CONTEXT_PAIRS})`
    );

    const newQAPairs = await analyzeChatWithAI(formattedChat, fileInfo, chatMeta, contextPairs);

    if (newQAPairs === null) {
      // Transient AI failure — preserve previous result so progress isn't lost.
      stats.failed++;
      if (cached) {
        console.log(`  ${tag} Preserving cached ${cached.qa_pairs?.length || 0} pairs due to AI failure.`);
        stats.totalQAPairs += (cached.qa_pairs || []).length;
      } else {
        // Remove any stale entry so the next run retries.
        delete sources[fileInfo.name];
      }
      await checkpoint();
      return;
    }

    if (newQAPairs.length > 0) {
      console.log(`  ${tag} ✅ Extracted ${newQAPairs.length} Q/A pairs.`);
    } else {
      console.log(`  ${tag} ℹ️  No Q/A pairs extracted (caching empty result).`);
    }

    sources[fileInfo.name] = { fingerprint, qa_pairs: newQAPairs };
    stats.processed++;
    stats.totalQAPairs += newQAPairs.length;

    // Checkpoint after each file (crash-safe)
    await checkpoint();
  }

  // Worker pool — runs CONCURRENCY files in parallel. Each worker pulls the
  // next file from the shared index, so fast files don't wait for slow ones.
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const myIndex = nextIndex++;
      if (myIndex >= filesToProcess.length) return;
      await processFile(filesToProcess[myIndex], myIndex);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, filesToProcess.length) }, () =>
    worker()
  );
  await Promise.all(workers);

  // Final write
  try {
    atomicWriteJson(FINAL_ANALYSIS_PATH, buildOutput(sources, stats));
  } catch (e) {
    console.error(`\n❌ Final write failed: ${e.message}`);
    process.exit(1);
  }

  console.log(`\n--- Analysis complete ---`);
  console.log(`  Files:     ${stats.total} total`);
  console.log(
    `             ${stats.processed} processed · ${stats.skipped} cached · ${stats.failed} failed`
  );
  console.log(`  Q/A pairs: ${stats.totalQAPairs} total`);
  console.log(`  Output:    ${FINAL_ANALYSIS_PATH}`);
}

main().catch((err) => {
  console.error('Unhandled error in main function:', err);
  process.exit(1);
});
