#!/usr/bin/env node

/**
 * clean_telegram_export.js
 *
 * Filters a raw Telegram Desktop export (result.json) down to relevant Orderly
 * group chats, producing one file per kept chat for easy manual review before
 * AI analysis.
 *
 * Pipeline position:
 *   result.json
 *     ↓  (this script)
 *   telegram_chats_filtered/
 *     ↓  (user reviews + manually deletes unwanted files)
 *   analyze_telegram_chats.js
 *     ↓
 *   tg_analysis.json
 *
 * FILTERS (keep chat if ALL true):
*   1. Type contains "group"         (skips DMs, channels, bots, saved_messages)
 *   2. Name contains "Orderly"       (case-insensitive — replaces old blacklist)
 *   3. Name contains "<>" OR "&" OR " x " OR "|"
 *   4. Name does NOT contain any of: "Orderly One", "Configuration", "Orderly Team"
 *      (case-insensitive — final override even if all other filters pass)
 *
 * (Previous version had a ≥2-members filter that relied on a `create_group`
 * service message — but supergroups don't emit that, causing false drops.
 * Removed; the name filter is already restrictive enough.)
 *
 * PREPROCESSING:
 *   Each kept chat is preprocessed (noise filtered out) and written as a
 *   plain-text chat log (.txt) — NOT raw JSON. The output is human-reviewable
 *   and ready to be sent to the AI as-is by analyze_telegram_chats.js.
 *
 *   Message-level filters applied during preprocessing (drop on first match):
 *     1. Service messages (type === 'service')
 *     2. Blocked senders  (BLOCKED_SENDERS env, comma-separated, case-insensitive)
 *     3. Empty text after extractText()
 *     4. URL-only messages (no surrounding context)
 *     5. Too short (< MIN_MESSAGE_LENGTH chars after trim; default 10)
 *     6. Reply-quote content dropped (we keep msg.text, ignore msg.reply_to_message)
 *
 * Env vars:
 *   INPUT=/path/to/result.json         Override default input location
 *   BLOCKED_SENDERS=alice,bob          Comma-separated sender names to drop
 *   MIN_MESSAGE_LENGTH=10              Drop messages shorter than this after trim
 *
 * Usage:
 *   node scripts/clean_telegram_export.js
 *   INPUT=/path/to/result.json node scripts/clean_telegram_export.js
 *
 * Output: telegram_chats_filtered/ directory in project root, one .txt per
 * kept chat (header + transcript body). The original result.json is NOT
 * touched — delete it manually after verifying the output.
 *
 * Prerequisites: `JSONStream` + `dotenv` (already in devDependencies).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import JSONStream from 'JSONStream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

dotenv.config();

// Configuration
const inputFile = process.env.INPUT || path.join(projectRoot, 'result.json');
const outputDir = path.join(projectRoot, 'telegram_chats_filtered');

// Preprocessing config
// Comma-separated sender names to drop (case-insensitive substring match).
//   e.g. BLOCKED_SENDERS=OrderlyAlertBot,PriceBot
const BLOCKED_SENDERS = (process.env.BLOCKED_SENDERS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
// Messages shorter than this (after trim) get dropped. Set to 0 to disable.
const MIN_MESSAGE_LENGTH = parseInt(process.env.MIN_MESSAGE_LENGTH || '10', 10);

// Stats accumulators
const stats = {
  total: 0,
  kept: 0,
  skipped: {
    nonGroup: 0,
    noOrderly: 0,
    noSpecialChar: 0,
    blockedKeyword: 0,
    noName: 0,
    emptyAfterFilter: 0,
  },
};

// ---------------------------------------------------------------------------
// Message-level preprocessing (runs AFTER chat-level filters keep a chat)
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a Telegram message's `text` field, handling all 3
 * forms the export can produce:
 *   - plain string: "hello"
 *   - array of entities: [{text:"hello "}, {text:"world", type:{@type:"bold"}}]
 *   - legacy single object: {text:"hello"}
 *
 * Returns just the concatenated text, dropping all formatting metadata.
 */
function extractText(message) {
  // Case 1: plain string
  if (typeof message.text === 'string') return message.text;

  // Case 2: array of text entities (most common in real exports)
  if (Array.isArray(message.text)) {
    return message.text
      .map((e) => (typeof e === 'string' ? e : e?.text || ''))
      .join('');
  }

  // Case 3: legacy single-object form
  if (message.text && typeof message.text === 'object') {
    return message.text.text || '';
  }

  return '';
}

/**
 * Compact a date like "2024-01-15T10:30:00" → "2024-01-15 10:30".
 * Falls back to the raw string if parsing fails.
 */
function compactDate(rawDate) {
  if (!rawDate) return 'unknown-date';
  const m = String(rawDate).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : String(rawDate);
}

const URL_ONLY_PATTERN = /^\s*https?:\/\/\S+\s*$/;

/**
 * Apply the 6 preprocessing filters to raw Telegram messages.
 *
 * Returns an object: { kept: [{date, from, text}, ...], stats: {raw, kept, dropped:{...}} }
 */
function preprocessMessages(messages) {
  const result = { kept: [], stats: { raw: 0, kept: 0, dropped: {} } };
  if (!Array.isArray(messages)) return result;

  const dropped = {
    service: 0,
    blockedSender: 0,
    emptyText: 0,
    urlOnly: 0,
    tooShort: 0,
  };

  for (const msg of messages) {
    result.stats.raw++;

    // Filter 1: drop service messages
    if (msg.type === 'service') {
      dropped.service++;
      continue;
    }

    // Filter 2: drop blocked senders (case-insensitive substring)
    const sender = String(msg.from || msg.from_id || '');
    if (BLOCKED_SENDERS.length > 0) {
      const senderLower = sender.toLowerCase();
      if (BLOCKED_SENDERS.some((b) => senderLower.includes(b))) {
        dropped.blockedSender++;
        continue;
      }
    }

    // Extract text (handles string, array-of-entities, single-object)
    const text = extractText(msg).trim();

    // Filter 3: drop empty
    if (!text) {
      dropped.emptyText++;
      continue;
    }

    // Filter 4: drop URL-only
    if (URL_ONLY_PATTERN.test(text)) {
      dropped.urlOnly++;
      continue;
    }

    // Filter 5: drop too short
    if (text.length < MIN_MESSAGE_LENGTH) {
      dropped.tooShort++;
      continue;
    }

    // Filter 6: reply_to_message — deliberately ignored. The original message
    // is already in chat history (if it survived the filters above), so
    // including reply_to_message would duplicate it.

    result.kept.push({
      date: compactDate(msg.date),
      from: sender || 'Unknown',
      text,
    });
  }

  result.stats.kept = result.kept.length;
  result.stats.dropped = dropped;
  return result;
}

/**
 * Render a clean, compact transcript from preprocessed messages.
 *
 *   [2024-01-15 10:30] John Doe: Hey, how do I...?
 *   [2024-01-15 10:32] Alice: Subscribe to the WS topic first.
 *
 * Multi-line messages preserve their newlines, continuation gets no prefix:
 *   [2024-01-15 10:30] John Doe:
 *   Hey, how do I use the orderbook API?
 */
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

// ---------------------------------------------------------------------------
// Chat-level filters
// ---------------------------------------------------------------------------

// Keywords that cause an automatic drop even if all positive filters pass.
// Case-insensitive substring match.
const BLOCKED_KEYWORDS = ['orderly one', 'configuration', 'orderly team'];

/**
 * Keep if name contains "Orderly" (case-insensitive).
 */
function hasOrderly(name) {
  return typeof name === 'string' && name.toLowerCase().includes('orderly');
}

/**
 * Keep if name contains "<>" (literal pair) OR "&" OR "|" OR " x "
 * (substring with surrounding spaces — avoids matching words like "Exchange").
 */
function hasSpecial(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return (
    name.includes('<>') ||
    name.includes('&') ||
    name.includes('|') ||
    lower.includes(' x ')
  );
}

/**
 * Drop if name contains any blocked keyword (case-insensitive substring).
 */
function hasBlockedKeyword(name) {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return BLOCKED_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Sanitize chat name → filename. Replaces spaces with underscores and strips
 * characters not suitable for filenames.
 */
function sanitizeFilename(name) {
  if (typeof name !== 'string' || name.trim() === '') return '';
  return name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '');
}

// ---------------------------------------------------------------------------
// Pre-flight: input file check + output dir setup
// ---------------------------------------------------------------------------

if (!fs.existsSync(inputFile)) {
  console.error(`❌ Input file not found: ${inputFile}`);
  console.error('   Set INPUT env var to override default (result.json in project root).');
  process.exit(1);
}

// Clear output directory (idempotent — re-running produces clean output)
if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
fs.mkdirSync(outputDir, { recursive: true });

console.log('🧹 Telegram Export Cleanup');
console.log(`   Input:  ${inputFile}`);
console.log(`   Output: ${outputDir}\n`);

// ---------------------------------------------------------------------------
// Stream-process the export
// ---------------------------------------------------------------------------

const readStream = fs.createReadStream(inputFile, { encoding: 'utf-8' });
const parser = JSONStream.parse('chats.list.*');
let chatCounter = 0; // for unnamed chats

parser.on('data', (chatObject) => {
  stats.total++;

  const rawName = chatObject.name || '(unnamed)';
  const chatType = String(chatObject.type || '').toLowerCase();

  // Filter 1: type must contain "group"
  if (!chatType.includes('group')) {
    console.log(`   ⏭️  Drop (non-group, type=${chatType || 'unknown'}): "${rawName}"`);
    stats.skipped.nonGroup++;
    return;
  }

  // Filter 2: name must contain "Orderly"
  if (!hasOrderly(rawName)) {
    console.log(`   ⏭️  Drop (no "Orderly" in name): "${rawName}"`);
    stats.skipped.noOrderly++;
    return;
  }

  // Filter 3: name must contain "<>", "&", " x ", or "|"
  if (!hasSpecial(rawName)) {
    console.log(`   ⏭️  Drop (no <>/&/ x /| in name): "${rawName}"`);
    stats.skipped.noSpecialChar++;
    return;
  }

  // Filter 4: name must NOT contain any blocked keyword (final override)
  if (hasBlockedKeyword(rawName)) {
    const matched = BLOCKED_KEYWORDS.find((kw) => rawName.toLowerCase().includes(kw));
    console.log(`   ⏭️  Drop (blocked keyword "${matched}"): "${rawName}"`);
    stats.skipped.blockedKeyword++;
    return;
  }

  // Handle unnamed chats (shouldn't happen post-filter-2, but defensive)
  let chatName = rawName;
  if (!chatName || chatName.trim() === '' || chatName === '(unnamed)') {
    console.log(`   ⏭️  Drop (no name): chat id=${chatObject.id || 'unknown'}`);
    stats.skipped.noName++;
    return;
  }

  // Write the kept chat to its own .txt file (header + clean transcript)
  const sanitizedName = sanitizeFilename(chatName);
  const outputFilename = `${sanitizedName || `chat_${++chatCounter}`}.txt`;
  const outputPath = path.join(outputDir, outputFilename);

  try {
    const messages = Array.isArray(chatObject.messages) ? chatObject.messages : [];
    const preprocessed = preprocessMessages(messages);

    if (preprocessed.stats.kept === 0) {
      stats.skipped.emptyAfterFilter++;
      const d = preprocessed.stats.dropped;
      console.log(
        `   ⏭️  Drop (0 msgs after filter): "${chatName}" ` +
          `(raw ${preprocessed.stats.raw}: ${d.service} service, ${d.blockedSender} blocked-sender, ` +
          `${d.emptyText} empty, ${d.urlOnly} url-only, ${d.tooShort} too-short)`
      );
      return;
    }

    const d = preprocessed.stats.dropped;
    const droppedLine =
      `${d.service} service, ${d.blockedSender} blocked-sender, ` +
      `${d.emptyText} empty, ${d.urlOnly} url-only, ${d.tooShort} too-short`;
    const header =
      `# Chat: ${chatName}\n` +
      `# Source: ${path.basename(inputFile)} (filtered on ${new Date().toISOString().split('T')[0]})\n` +
      `# Stats: ${preprocessed.stats.raw} raw messages → ${preprocessed.stats.kept} kept\n` +
      `#   Dropped: ${droppedLine}\n\n`;
    const transcript = formatChatTranscript(preprocessed.kept);

    fs.writeFileSync(outputPath, header + transcript);
    stats.kept++;
    console.log(
      `   ✅ Kept: "${chatName}" (${preprocessed.stats.raw} → ${preprocessed.stats.kept} msgs) → ${outputFilename}`
    );
  } catch (err) {
    console.error(`   ❌ Error writing ${outputFilename}: ${err.message}`);
  }
});

parser.on('error', (err) => {
  console.error('\n❌ JSONStream parse error:', err.message);
  console.error("   Ensure the input is a valid Telegram Desktop export with 'chats.list' structure.");
  process.exit(1);
});

parser.on('end', () => {
  console.log('\n--------------------------------------------------');
  console.log('Cleanup complete.\n');
  console.log(`   Total chats in export: ${stats.total}`);
  console.log(`   Kept:                  ${stats.kept}`);
  console.log(`   Skipped:`);
  console.log(`     - non-group:           ${stats.skipped.nonGroup}`);
  console.log(`     - no "Orderly":        ${stats.skipped.noOrderly}`);
  console.log(`     - no special char:     ${stats.skipped.noSpecialChar}`);
  console.log(`     - blocked keyword:     ${stats.skipped.blockedKeyword}`);
  console.log(`     - no name:             ${stats.skipped.noName}`);
  console.log(`     - empty after filter:  ${stats.skipped.emptyAfterFilter}`);
  console.log(`\n   Output: ${outputDir}`);
  if (stats.kept > 0) {
    console.log('\nNext: review the kept files, delete any you don\'t want, then run:');
    console.log('   node scripts/analyze_telegram_chats.js');
  }
  console.log('--------------------------------------------------');
});

readStream.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(`❌ Cannot read input file: ${inputFile}`);
  } else {
    console.error('❌ Read stream error:', err.message);
  }
  process.exit(1);
});

readStream.pipe(parser);

console.log('Streaming and filtering...\n');
