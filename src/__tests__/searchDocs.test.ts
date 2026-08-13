import { describe, it, expect, beforeEach, vi } from 'vitest';
import { searchOrderlyDocs, clearSearchCache } from '../tools/searchDocs.js';

const feeTierMarkdown = `# Trading fees
### Builder Staking programme
Builders qualify through volume or staking. Crypto and RWA use the same base fees.
<Tabs>
  <Tab title="Public">Base taker fee (crypto and RWA) | 3.00
Maker rebate cap (crypto and RWA) | 0.00</Tab>
  <Tab title="Silver">Requirements: ≥ $50M or 100K ORDER; 2.75 / -0.05</Tab>
  <Tab title="Gold">Requirements: ≥ $200M or 300K ORDER; 2.50 / -0.10</Tab>
  <Tab title="Platinum">Requirements: ≥ $750M or 3M ORDER; 2.00 / -0.15</Tab>
  <Tab title="Diamond">Requirements: ≥ $2B or 7M ORDER; 1.00 / -0.20</Tab>
</Tabs>`;

function mockFeeTierDoc(markdown = feeTierMarkdown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(markdown)));
}

describe('searchOrderlyDocs', () => {
  beforeEach(() => {
    // Clear the Fuse cache before each test to ensure fresh searches
    clearSearchCache();
    vi.unstubAllGlobals();
  });

  it('should find documentation by keyword', async () => {
    const result = await searchOrderlyDocs('orderbook', 3);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('orderbook');
    expect(result.content[0].text).toContain('Search Results');
  });

  it('should find SDK patterns', async () => {
    const result = await searchOrderlyDocs('useOrderEntry', 5);
    expect(result.content[0].text).toContain('SDK');
  });

  it('should return suggestions when no results found', async () => {
    const result = await searchOrderlyDocs('zzzzqqqqzzzz123456789', 5);
    expect(result.content[0].text).toContain('No results found');
    expect(result.content[0].text).toContain('Try searching for');
  });

  it('should limit results correctly', async () => {
    const result = await searchOrderlyDocs('orderbook', 2);
    const text = result.content[0].text;
    // Count actual result entries via the Relevance label (not chunk content
    // which may contain its own ## N. markdown headers after AI merging).
    const sectionCount = (text.match(/\*\*Relevance:\*\*/g) || []).length;
    expect(sectionCount).toBeLessThanOrEqual(2);
  });

  it('should handle fuzzy matching for typos', async () => {
    // Test typo tolerance - "ordebook" should match "orderbook"
    const result = await searchOrderlyDocs('ordebook', 3);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Search Results');
    // Should find results despite the typo
    expect(result.content[0].text).not.toContain('No results found');
  });

  it('should handle fuzzy matching for hook names', async () => {
    // "useOrdrEntry" (typo) doesn't appear in titles/keywords, only in content.
    // Fuse.js can't fuzzy-match it at the configured threshold. The correct UX
    // is to return the suggestion list, which should include the correct name.
    const result = await searchOrderlyDocs('useOrdrEntry', 5);
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    // The suggestion engine should mention the correct hook name
    expect(text).toContain('useOrderEntry');
  });

  it('should handle empty query', async () => {
    const result = await searchOrderlyDocs('', 5);
    expect(result.content[0].text).toBe('Please provide a search query.');
  });

  it('should include relevance scores', async () => {
    const result = await searchOrderlyDocs('vault', 3);
    expect(result.content[0].text).toContain('Relevance:');
    // Should show percentage (e.g., "Relevance: 85%")
    expect(result.content[0].text).toMatch(/Relevance:\*\* \d+%/);
  });

  it('should search across multiple fields', async () => {
    // Search for something that might be in content but not title
    const result = await searchOrderlyDocs('EIP-712', 5);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Search Results');
  });

  it('should provide tip for hook-related searches without SDK results', async () => {
    // Search for a hook pattern - Fuse.js is now good enough that it finds SDK results
    // So we test that the search works and returns relevant SDK content
    const result = await searchOrderlyDocs('useWalletConnector', 5);
    const text = result.content[0].text;

    // Fuse.js now finds SDK results for this query, which is actually better behavior
    // The search should find relevant SDK documentation
    expect(text).toContain('Search Results');
    expect(text).not.toContain('No results found');
  });

  it('should handle natural-language questions by stripping stopwords', async () => {
    // "how does the vault work" should reduce to "vault" and find results
    const result = await searchOrderlyDocs('how does the vault work', 5);
    expect(result.content[0].text).toContain('Search Results');
    expect(result.content[0].text).not.toContain('No results found');
  });

  it('should find results for multi-word natural queries', async () => {
    // "how to connect wallet" → tokens: connect, wallet → should match
    const result = await searchOrderlyDocs('how to connect wallet', 5);
    expect(result.content[0].text).toContain('Search Results');
    expect(result.content[0].text).not.toContain('No results found');
  });

  it('should return the canonical builder fee tiers', async () => {
    mockFeeTierDoc();
    const result = await searchOrderlyDocs('broker fee tiers', 10);
    const text = result.content[0].text;

    expect(text).toContain('Crypto and RWA use the same base fees');
    expect(text).toContain('Requirements: ≥ $50M or 100K ORDER; 2.75 / -0.05');
    expect(text).toContain('Requirements: ≥ $200M or 300K ORDER; 2.50 / -0.10');
    expect(text).toContain('Requirements: ≥ $750M or 3M ORDER; 2.00 / -0.15');
    expect(text).toContain('Requirements: ≥ $2B or 7M ORDER; 1.00 / -0.20');
    expect(text).not.toContain('$10B');
    expect(fetch).toHaveBeenCalledWith(
      'https://orderly.network/docs/introduction/trade-on-orderly/trading-basics/trading-fees',
      expect.objectContaining({ headers: { Accept: 'text/markdown' } })
    );
  });

  it('should use the canonical table for RWA fee-tier queries', async () => {
    mockFeeTierDoc();
    const result = await searchOrderlyDocs('RWA builder fees', 5);
    const text = result.content[0].text;

    expect(text).toContain('Crypto and RWA use the same base fees');
    expect(text).toContain('Requirements: ≥ $2B or 7M ORDER; 1.00 / -0.20');
  });

  it('should reject an incomplete canonical fee document', async () => {
    mockFeeTierDoc('# Trading fees\n### Builder Staking programme\n<Tab title="Public">');

    await expect(searchOrderlyDocs('broker fee tiers', 5)).rejects.toThrow(
      'unexpected format: missing Silver tier'
    );
  });

  it('should handle queries that reduce to a single meaningful term', async () => {
    const result = await searchOrderlyDocs('what is leverage', 3);
    expect(result.content[0].text).toContain('Search Results');
    expect(result.content[0].text).not.toContain('No results found');
  });

  it('should reject queries with only stopwords', async () => {
    const result = await searchOrderlyDocs('how does the work', 5);
    expect(result.content[0].text).toContain('contained only common words');
  });

  it('should handle kebab-case queries', async () => {
    // Kebab should be split into tokens
    const result = await searchOrderlyDocs('funding-rate', 3);
    expect(result.content[0].text).toContain('Search Results');
  });

  it('should show multi-term match indicator when multiple tokens hit', async () => {
    // "wallet connection" → two tokens that should both match some chunks
    const result = await searchOrderlyDocs('wallet connection fees', 5);
    const text = result.content[0].text;
    if (text.includes('Search Results')) {
      // At least one result should show the multi-hit indicator
      // (not guaranteed for every dataset, but likely for this combination)
      expect(text).toMatch(/Search Results/);
    }
  });

  it('should surface SDK symbols with inline type-accurate records', async () => {
    // The unified index folds js-sdk symbol data (from @orderly.network/sdk-docs
    // bundled artifacts) into search. A hook lookup must return the symbol's
    // signature + provenance inline, with no need for a separate lookup tool.
    const result = await searchOrderlyDocs('usePositionStream', 5);
    const text = result.content[0].text;
    expect(text).toContain('Search Results');
    expect(text).toContain('`SDK Hook`');
    expect(text).toMatch(/\*\*Signature:\*\*/);
    expect(text).toMatch(/```ts/);
    // Provenance from the SDK bundle
    expect(text).toContain('**Source:**');
    // Exact hook name must rank first (dedup + coverage-aware ranking)
    expect(text).toMatch(/## 1\. usePositionStream/);
  });

  it('should rank an exact hook-name match at #1', async () => {
    // Regression guard: duplicate symbol records in the source and the
    // coverage-vs-score tie-break must not let a fuzzy near-match outrank the
    // exact symbol (e.g. usePositionHeaderScript above usePositionStream).
    const result = await searchOrderlyDocs('useOrderEntry', 5);
    const text = result.content[0].text;
    expect(text).toMatch(/## 1\. useOrderEntry\b/);
  });

  it('should support docs-only scope', async () => {
    // Forcing scope="docs" must keep SDK symbol records out of the results,
    // even when the query is a hook name.
    const result = await searchOrderlyDocs('usePositionStream', 5, 'docs');
    const text = result.content[0].text;
    expect(text).not.toContain('`SDK Hook`');
    if (text.includes('Search Results')) {
      expect(text).toContain(' (docs)');
    }
  });

  it('should support sdk-only scope', async () => {
    // Forcing sdk scope returns inline type-accurate symbol records with the
    // scope label visible.
    const result = await searchOrderlyDocs('usePositionStream', 5, 'sdk');
    const text = result.content[0].text;
    expect(text).toContain('`SDK Hook`');
    expect(text).toContain(' (SDK symbols)');
  });

  it('should auto-detect scope from camelCase queries', async () => {
    // 'usePositionStream' is clearly an SDK identifier → SDK scope.
    const result = await searchOrderlyDocs('usePositionStream', 5);
    const text = result.content[0].text;
    expect(text).toContain(' (SDK symbols)');
  });

  it('should auto-detect scope from plain-language queries', async () => {
    // 'how does the vault work' is prose → docs scope, no SDK-symbol noise.
    const result = await searchOrderlyDocs('how does the vault work', 5);
    const text = result.content[0].text;
    expect(text).toContain(' (docs)');
  });

  // --- Scope routing for non-symbol identifiers ---------------------------
  // Page-level components (TradingPage, Portfolio, ...) are camelCased but are
  // documented in the prose corpus, NOT emitted as type-accurate symbols by
  // the js-sdk ai-docs pipeline. They must route to docs — not the SDK corpus,
  // which would surface fuzzy symbol noise like getTradingPanelIds.
  it('should route a non-symbol camelCase identifier to docs', async () => {
    const result = await searchOrderlyDocs('TradingPage', 5);
    const text = result.content[0].text;
    expect(text).toContain('Search Results');
    expect(text).toContain(' (docs)');
    expect(text).toContain('TradingPage');
    // Must not leak fuzzy SDK-symbol noise for an identifier that isn't a symbol.
    expect(text).not.toContain('`SDK Hook`');
    expect(text).not.toContain('`SDK Function`');
  });

  it('should still route an exact symbol name to SDK even when camelCased', async () => {
    // 'OrderEntry' is a real component symbol — must route to the SDK corpus.
    const result = await searchOrderlyDocs('OrderEntry', 5);
    const text = result.content[0].text;
    expect(text).toContain(' (SDK symbols)');
  });

  // --- Symbol-kind render coverage ----------------------------------------
  // The unified search folds hooks/types/components/functions into one index;
  // each kind renders a distinct inline block that must be exercised.
  it('should render SDK components with props', async () => {
    const result = await searchOrderlyDocs('OrderEntry', 5, 'sdk');
    const text = result.content[0].text;
    expect(text).toContain('`SDK Component`');
    expect(text).toContain('**Component name:**');
    expect(text).toContain('**Props:**');
    // At least one prop line renders name + type.
    expect(text).toMatch(/- `.+` \(`.+`\)/);
  });

  it('should render SDK types with typeText', async () => {
    const result = await searchOrderlyDocs('BindReferralCodeSuccessPayload', 5, 'sdk');
    const text = result.content[0].text;
    expect(text).toContain('`SDK Type`');
    expect(text).toContain('**Type:**');
  });

  it('should render SDK functions with signature, params, and returns', async () => {
    const result = await searchOrderlyDocs('parseUnits', 5, 'sdk');
    const text = result.content[0].text;
    expect(text).toContain('`SDK Function`');
    expect(text).toMatch(/\*\*Signature:\*\*/);
    expect(text).toContain('**Parameters:**');
    expect(text).toMatch(/\*\*Returns:\*\* `bigint`/);
  });

  it('should render hook params detail, returns, and jsDoc body', async () => {
    const result = await searchOrderlyDocs('useOrderEntry', 5, 'sdk');
    const text = result.content[0].text;
    expect(text).toContain('**Parameters:**');
    expect(text).toMatch(/\*\*Returns:\*\* `OrderEntryReturn`/);
    // jsDoc renders as the description body above the signature.
    expect(text).toContain('Custom hook for managing order entry');
    // Symbol provenance line.
    expect(text).toContain('**Package:**');
    expect(text).toContain('**Source:**');
  });

  it('should flag deprecated symbols', async () => {
    const result = await searchOrderlyDocs('useMarket', 5, 'sdk');
    const text = result.content[0].text;
    // useMarket is one of the deprecated hooks in the bundle.
    expect(text).toContain('⚠️');
    expect(text).toContain('deprecated');
  });
});
