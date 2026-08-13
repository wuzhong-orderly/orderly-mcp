const TRADING_FEES_URL =
  'https://orderly.network/docs/introduction/trade-on-orderly/trading-basics/trading-fees';
const REQUIRED_TIERS = ['Public', 'Silver', 'Gold', 'Platinum', 'Diamond'] as const;

const FEE_TERMS = new Set(['fee', 'fees', 'rate', 'rates', 'pricing']);
const TIER_TERMS = new Set([
  'tier',
  'tiers',
  'broker',
  'builder',
  'staking',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'rwa',
]);

export function isBuilderFeeTierQuery(query: string): boolean {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return (
    tokens.some((token) => FEE_TERMS.has(token)) && tokens.some((token) => TIER_TERMS.has(token))
  );
}

function extractBuilderFeeSection(markdown: string): string {
  const heading = '### Builder Staking programme';
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`missing heading "${heading}"`);

  const section = markdown.slice(start).trim();
  for (const tier of REQUIRED_TIERS) {
    if (!section.includes(`<Tab title="${tier}">`)) {
      throw new Error(`missing ${tier} tier`);
    }
  }
  if (!section.includes('Base taker fee (crypto and RWA)')) {
    throw new Error('missing shared crypto and RWA base taker fee');
  }
  if (!section.includes('Maker rebate cap (crypto and RWA)')) {
    throw new Error('missing shared crypto and RWA maker rebate cap');
  }
  return section;
}

export async function renderBuilderFeeTiers(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(TRADING_FEES_URL, {
      headers: { Accept: 'text/markdown' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `Unable to fetch the canonical Orderly Trading Fees document: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Unable to fetch the canonical Orderly Trading Fees document: HTTP ${response.status}`
    );
  }

  try {
    const section = extractBuilderFeeSection(await response.text());
    return `${section}\n\nSource: ${TRADING_FEES_URL}\n`;
  } catch (error) {
    throw new Error(
      `The canonical Orderly Trading Fees document has an unexpected format: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
