import { describe, it, expect } from 'vitest';
import { getSvApiInfo } from '../tools/svApi.js';

describe('getSvApiInfo', () => {
  it('should render the overview when no args given', async () => {
    const result = await getSvApiInfo();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const text = result.content[0].text;
    expect(text).toContain('Orderly Strategy Vault API');
    expect(text).toContain('## Overview');
    expect(text).toContain('Strategy Vault Info');
  });

  it('should browse a category by exact name', async () => {
    const result = await getSvApiInfo(undefined, 'Strategy Vault Info');
    const text = result.content[0].text;
    expect(text).toContain('# Strategy Vault Info');
    expect(text).toContain('## Endpoints');
  });

  it('should match categories case-insensitively with underscore normalization', async () => {
    const result = await getSvApiInfo(undefined, 'STRATEGY_VAULT_INFO');
    const text = result.content[0].text;
    expect(text).toContain('# Strategy Vault Info');
    expect(text).toContain('## Endpoints');
  });

  it('should match a category by description keyword', async () => {
    const result = await getSvApiInfo(undefined, 'liquidity_provider');
    const text = result.content[0].text;
    expect(text).toContain('# Liquidity Provider');
  });

  it('should return a specific endpoint', async () => {
    const result = await getSvApiInfo('sp/info');
    const text = result.content[0].text;
    expect(text).toMatch(/^# (GET|POST|PUT|DELETE) /);
  });

  it('should report not-found for an unknown category', async () => {
    const result = await getSvApiInfo(undefined, 'nonexistent');
    const text = result.content[0].text;
    expect(text).toContain('not found');
    expect(text).toContain('Strategy Vault Info');
  });
});
