import Fuse from 'fuse.js';
import documentationData from '../data/documentation.json' with { type: 'json' };

export interface SearchResult {
  content: Array<{ type: 'text'; text: string }>;
}

interface DocChunk {
  id: string;
  title: string;
  content: string;
  category: string;
  keywords: string[];
}

interface DocumentationData {
  chunks: DocChunk[];
  metadata: {
    version: string;
    lastUpdated: string;
    totalChunks: number;
  };
}

// Words that carry no domain meaning in search queries.
// Stripping these lets natural-language questions like "how does the vault work"
// reduce to "vault" — which Fuse matches well.
const STOPWORDS = new Set([
  'how',
  'does',
  'do',
  'did',
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'what',
  'why',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'whose',
  'can',
  'could',
  'should',
  'would',
  'will',
  'shall',
  'may',
  'might',
  'must',
  'i',
  'my',
  'me',
  'we',
  'our',
  'us',
  'you',
  'your',
  'they',
  'their',
  'them',
  'he',
  'she',
  'it',
  'its',
  'his',
  'her',
  'this',
  'that',
  'these',
  'those',
  'for',
  'with',
  'of',
  'on',
  'in',
  'at',
  'by',
  'from',
  'into',
  'about',
  'to',
  'and',
  'or',
  'not',
  'no',
  'if',
  'then',
  'else',
  'so',
  'than',
  'too',
  'very',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'get',
  'got',
  'work',
  'working',
  'works',
  'worked',
  'use',
  'using',
  'used',
  'there',
  'here',
  'out',
  'up',
  'down',
  'over',
  'under',
  'again',
]);

/**
 * Split a raw user query into meaningful search tokens.
 * Lowercases, converts kebab/snake_case to spaces, strips punctuation,
 * removes stopwords, and drops tokens shorter than 2 chars.
 *
 * Examples:
 *   "how does the vault work" → ["vault"]
 *   "how-to-connect-wallet"   → ["connect", "wallet"]
 *   "useOrderEntry"           → ["useorderentry"]
 */
function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// Initialize Fuse.js with configuration.
// We create the Fuse instance lazily to avoid doing heavy work at module load time.
let fuseInstance: Fuse<DocChunk> | null = null;

function getFuseInstance(): Fuse<DocChunk> {
  if (!fuseInstance) {
    const data = documentationData as DocumentationData;

    const fuseOptions = {
      keys: [
        { name: 'title', weight: 0.4 },
        { name: 'content', weight: 0.3 },
        { name: 'keywords', weight: 0.2 },
        { name: 'category', weight: 0.1 },
      ],
      threshold: 0.4,
      distance: 100,
      includeScore: true,
      includeMatches: false,
      minMatchCharLength: 2,
      shouldSort: true,
      findAllMatches: true,
      ignoreLocation: true,
    };

    fuseInstance = new Fuse(data.chunks, fuseOptions);
  }

  return fuseInstance;
}

interface MergedResult {
  chunk: DocChunk;
  score: number;
  hits: number;
}

/**
 * Multi-token search: run Fuse for each token individually, then merge.
 * Chunks matching multiple tokens get a score boost (lower = better).
 */
function multiTokenSearch(fuse: Fuse<DocChunk>, tokens: string[], limit: number): MergedResult[] {
  const resultMap = new Map<string, { chunk: DocChunk; scores: number[]; hits: number }>();

  for (const token of tokens) {
    const results = fuse.search(token, { limit: limit * 4 });
    for (const result of results) {
      const score = result.score ?? 1;
      const id = result.item.id;
      const existing = resultMap.get(id);
      if (existing) {
        existing.scores.push(score);
        existing.hits++;
      } else {
        resultMap.set(id, { chunk: result.item, scores: [score], hits: 1 });
      }
    }
  }

  return [...resultMap.values()]
    .map((entry) => {
      const avgScore = entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length;
      // Divide by hit count so chunks matching more query tokens rank higher
      const boostedScore = avgScore / entry.hits;
      return { chunk: entry.chunk, score: boostedScore, hits: entry.hits };
    })
    .filter((r) => r.score < 0.7)
    .sort((a, b) => {
      // Prioritize coverage (more token hits = more relevant), then score
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.score - b.score;
    })
    .slice(0, limit);
}

export async function searchOrderlyDocs(query: string, limit: number = 5): Promise<SearchResult> {
  const data = documentationData as DocumentationData;

  if (!query.trim()) {
    return {
      content: [
        {
          type: 'text',
          text: 'Please provide a search query.',
        },
      ],
    };
  }

  const tokens = tokenizeQuery(query);

  if (tokens.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `Your query "${query}" contained only common words. Please try a more specific term like "vault", "fees", or "wallet".`,
        },
      ],
    };
  }

  const fuse = getFuseInstance();
  const mergedResults = multiTokenSearch(fuse, tokens, limit);

  if (mergedResults.length === 0) {
    const categories = [...new Set(data.chunks.map((c) => c.category))];

    return {
      content: [
        {
          type: 'text',
          text:
            `No results found for "${query}".\n\nTry searching for:\n` +
            `- SDK hooks (e.g., "useOrderEntry", "usePositionStream")\n` +
            `- Protocol concepts (e.g., "vault", "leverage", "funding rate")\n` +
            `- Available categories: ${categories.join(', ')}\n\n` +
            `Or use specific tools like:\n` +
            `- "get_sdk_pattern" for hook examples\n` +
            `- "explain_workflow" for step-by-step guides`,
        },
      ],
    };
  }

  // Build response
  let text = `# Search Results for "${query}"\n\n`;
  text += `Found ${mergedResults.length} relevant section${mergedResults.length !== 1 ? 's' : ''}:\n\n`;

  for (let i = 0; i < mergedResults.length; i++) {
    const result = mergedResults[i];
    const chunk = result.chunk;
    const relevancePercent = Math.round((1 - result.score) * 100);

    text += `## ${i + 1}. ${chunk.title}\n\n`;
    text += `**Category:** ${chunk.category} | **Relevance:** ${relevancePercent}%`;
    if (result.hits > 1) {
      text += ` | **Matched ${result.hits} terms**`;
    }
    text += `\n\n`;
    text += `${chunk.content}\n\n`;

    if (chunk.keywords.length > 0) {
      text += `*Keywords: ${chunk.keywords.join(', ')}*\n\n`;
    }

    text += `---\n\n`;
  }

  // Add note about SDK patterns
  const hasSdkContent = mergedResults.some((r) => r.chunk.category === 'SDK');
  if (!hasSdkContent && tokens.some((t) => t.includes('use') || t.includes('hook'))) {
    text += `\n**Tip:** For specific SDK hook examples, try using the "get_sdk_pattern" tool with the hook name.\n`;
  }

  return {
    content: [{ type: 'text', text }],
  };
}

// Export a function to clear the Fuse cache (useful for testing or hot reloading)
export function clearSearchCache(): void {
  fuseInstance = null;
}
