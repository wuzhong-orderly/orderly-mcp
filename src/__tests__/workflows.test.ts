import { describe, it, expect, beforeEach, vi } from 'vitest';
import { explainWorkflow, clearWorkflowCache } from '../tools/workflows.js';

describe('explainWorkflow', () => {
  it('should use canonical data for builder fee tiers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(`### Builder Staking programme
<Tab title="Public">Base taker fee (crypto and RWA) | 3.00; Maker rebate cap (crypto and RWA) | 0.00</Tab>
<Tab title="Silver">≥ $50M / 100K ORDER / 2.75 / -0.05</Tab>
<Tab title="Gold">≥ $200M / 300K ORDER / 2.50 / -0.10</Tab>
<Tab title="Platinum">≥ $750M / 3M ORDER / 2.00 / -0.15</Tab>
<Tab title="Diamond">≥ $2B / 7M ORDER / 1.00 / -0.20</Tab>`)
      )
    );
    const result = await explainWorkflow('builder staking fee tiers');
    const text = result.content[0].text;

    expect(text).toContain('≥ $200M / 300K ORDER / 2.50 / -0.10');
    expect(text).toContain('≥ $750M / 3M ORDER / 2.00 / -0.15');
    expect(text).not.toContain('$10B');
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    clearWorkflowCache();
  });

  it('should find workflow by kebab-case query', async () => {
    // "wallet-connection" → tokens: wallet, connection
    const result = await explainWorkflow('wallet-connection');
    const text = result.content[0].text;
    expect(text).not.toContain('not found');
    // Should match a wallet-related workflow
    expect(text.toLowerCase()).toContain('wallet');
  });

  it('should find workflow by natural language query', async () => {
    const result = await explainWorkflow('how to set up react sdk');
    const text = result.content[0].text;
    expect(text).not.toContain('not found');
  });

  it('should find workflow by deposit query', async () => {
    const result = await explainWorkflow('deposit-withdraw');
    const text = result.content[0].text;
    expect(text).not.toContain('not found');
  });

  it('should find workflow by single keyword', async () => {
    const result = await explainWorkflow('websocket');
    const text = result.content[0].text;
    expect(text).not.toContain('not found');
    expect(text.toLowerCase()).toContain('websocket');
  });

  it('should find workflow by exact full name', async () => {
    const result = await explainWorkflow('Setting Up the Orderly React SDK with Wallet Connection');
    const text = result.content[0].text;
    expect(text).not.toContain('not found');
    expect(text).toContain('Setting Up the Orderly React SDK with Wallet Connection');
  });

  it('should return available list for truly unmatched queries', async () => {
    const result = await explainWorkflow('zzzqqqxxx12345nonexistent');
    expect(result.content[0].text).toContain('not found');
    expect(result.content[0].text).toContain('Available workflows');
  });

  it('should handle empty query', async () => {
    const result = await explainWorkflow('');
    expect(result.content[0].text).toBe('Please provide a workflow name to search for.');
  });

  it('should reject queries with only stopwords', async () => {
    const result = await explainWorkflow('the and of');
    expect(result.content[0].text).toContain('contained only common words');
  });
});
