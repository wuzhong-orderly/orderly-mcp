import { describe, it, expect } from 'vitest';
import { getIndexerApiInfo } from '../tools/indexerApi.js';

describe('getIndexerApiInfo', () => {
  it('should render the overview when no args given', async () => {
    const result = await getIndexerApiInfo();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    expect(text).toContain('Orderly Network Indexer API');
    expect(text).toContain('## Available Categories');
    expect(text).toContain('trading metrics');
  });

  it('should browse a category by exact name', async () => {
    const result = await getIndexerApiInfo(undefined, 'trading metrics');
    const text = result.content[0].text;
    expect(text).toContain('# trading metrics');
    expect(text).toContain('## Endpoints');
  });

  it('should match categories case-insensitively with underscore normalization', async () => {
    const result = await getIndexerApiInfo(undefined, 'TRADING_METRICS');
    const text = result.content[0].text;
    expect(text).toContain('# trading metrics');
    expect(text).toContain('## Endpoints');
  });

  it('should match a namespaced category via underscore normalization', async () => {
    const result = await getIndexerApiInfo(undefined, 'events::events_api');
    const text = result.content[0].text;
    expect(text).toContain('# events::events api');
    expect(text).toContain('## Endpoints');
  });

  it('should return a specific endpoint', async () => {
    const result = await getIndexerApiInfo('/daily_volume');
    const text = result.content[0].text;
    expect(text).toMatch(/^# (GET|POST|PUT|DELETE) /);
  });

  it('should report not-found for an unknown category', async () => {
    const result = await getIndexerApiInfo(undefined, 'nonexistent');
    const text = result.content[0].text;
    expect(text).toContain('not found');
    expect(text).toContain('trading metrics');
  });
});
