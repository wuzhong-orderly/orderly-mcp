import { describe, it, expect } from 'vitest';
import { getPublicInfoApiInfo } from '../tools/publicInfoApi.js';

describe('getPublicInfoApiInfo', () => {
  it('should render the overview when no args given', async () => {
    const result = await getPublicInfoApiInfo();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    expect(text).toContain('Orderly Network Public Info API');
    expect(text).toContain('POST https://api.orderly.org/v1/public/query');
    expect(text).toContain('Weight per query type');
    expect(text).toContain('marketSummary');
  });

  it('should browse a category by name', async () => {
    const result = await getPublicInfoApiInfo(undefined, 'market');
    const text = result.content[0].text;
    expect(text).toContain('Market data');
    expect(text).toContain('`orderbook`');
    expect(text).toContain('`candles`');
  });

  it('should resolve category by title substring', async () => {
    const result = await getPublicInfoApiInfo(undefined, 'account');
    const text = result.content[0].text;
    expect(text).toContain('Account data');
    expect(text).toContain('`accountState`');
  });

  it('should resolve category case-insensitively with underscore/dash normalization', async () => {
    const result = await getPublicInfoApiInfo(undefined, 'MARKET_DATA');
    const text = result.content[0].text;
    expect(text).toContain('Market data');
    expect(text).toContain('`orderbook`');
  });

  it('should return full detail for an exact query type', async () => {
    const result = await getPublicInfoApiInfo('accountState');
    const text = result.content[0].text;
    expect(text).toContain('# Account state');
    expect(text).toContain('type: "accountState"');
    expect(text).toContain('category: **account**');
    expect(text).toContain('curl -s -XPOST');
    expect(text).toContain('## Request');
    expect(text).toContain('## Response fields');
    expect(text).toContain('## Notes');
  });

  it('should render request params as a markdown table', async () => {
    const result = await getPublicInfoApiInfo('candles');
    const text = result.content[0].text;
    expect(text).toContain('| Field | Type | Required | Default | Notes |');
    expect(text).toContain('`symbol`');
    expect(text).toContain('`interval`');
  });

  it('should handle query types with no response table (marketDetail)', async () => {
    const result = await getPublicInfoApiInfo('marketDetail');
    const text = result.content[0].text;
    expect(text).toContain('# Market detail');
    expect(text).toContain('marketDetail');
    // marketDetail has no inline response fields table but does have notes
    expect(text).toContain('## Notes');
  });

  it('should find the synthetic rateLimitStatus under system', async () => {
    const result = await getPublicInfoApiInfo('rateLimitStatus');
    const text = result.content[0].text;
    expect(text).toContain('Rate limit status');
    expect(text).toContain('category: **system**');
    expect(text).toContain('(free)');
  });

  it('should support partial / slug lookup', async () => {
    const result = await getPublicInfoApiInfo('top-addresses');
    const text = result.content[0].text;
    expect(text).toContain('Top addresses');
    expect(text).toContain('topAddresses');
  });

  it('should fuzzy match on title/description', async () => {
    const result = await getPublicInfoApiInfo('whale research');
    const text = result.content[0].text;
    expect(text).toContain('Whale context');
  });

  it('should report not-found with the list of available types', async () => {
    const result = await getPublicInfoApiInfo('totallyBogusType');
    const text = result.content[0].text;
    expect(text).toContain('not found');
    expect(text).toContain('marketSummary');
  });

  it('should report not-found for an unknown category', async () => {
    const result = await getPublicInfoApiInfo(undefined, 'nonexistent');
    const text = result.content[0].text;
    expect(text).toContain('not found');
    expect(text).toContain('market');
  });

  it('should prefer queryType over category when both are passed', async () => {
    const result = await getPublicInfoApiInfo('orderbook', 'market');
    const text = result.content[0].text;
    expect(text).toContain('# Orderbook');
  });
});
