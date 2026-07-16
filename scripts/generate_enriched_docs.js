#!/usr/bin/env node

/**
 * generate_enriched_docs.js
 *
 * This script reads repo_analysis.json (created by analyze_example_repos.js)
 * and generates new documentation chunks to enrich the existing documentation.json.
 *
 * It creates comprehensive, code-heavy documentation chunks that supplement
 * the existing Q&A-based documentation without replacing it.
 *
 * Usage:
 *   node scripts/generate_enriched_docs.js
 *   USE_AI=true node scripts/generate_enriched_docs.js  # Use AI to enhance content
 *
 * Input:
 *   - repo_analysis.json (from analyze_example_repos.js)
 *   - src/data/documentation.json (existing)
 *
 * Output:
 *   - src/data/documentation.json (enriched with new chunks)
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

// Load environment variables
dotenv.config();

// Configuration
const USE_AI = process.env.USE_AI === 'true';
const FORCE = process.env.FORCE === 'true';
const NEAR_AI_MODEL = 'qwen/qwen3.7-max';

// Initialize OpenAI client (only if USE_AI is enabled)
let openai;
if (USE_AI) {
  openai = new OpenAI({
    baseURL: 'https://cloud-api.near.ai/v1',
    apiKey: process.env.NEAR_AI_API_KEY || process.env.OPENAI_API_KEY,
    timeout: parseInt(process.env.NEAR_AI_TIMEOUT_MS || String(30 * 60 * 1000), 10),
    maxRetries: 0,
  });
}

// File paths
const REPO_ANALYSIS = path.join(projectRoot, 'repo_analysis.json');
const DOCS_FILE = path.join(projectRoot, 'src/data/documentation.json');

console.log('📝 Generating enriched documentation...\n');

if (USE_AI) {
  console.log(`🤖 AI enhancement enabled ${FORCE ? '(FORCE)' : '(incremental)'}\n`);
} else {
  console.log('ℹ️  AI enhancement disabled (set USE_AI=true to enable)\n');
}

// Check prerequisites
if (!fs.existsSync(REPO_ANALYSIS)) {
  console.error(`❌ Missing: ${REPO_ANALYSIS}`);
  console.error('   Run: node scripts/analyze_example_repos.js');
  process.exit(1);
}

if (!fs.existsSync(DOCS_FILE)) {
  console.error(`❌ Missing: ${DOCS_FILE}`);
  process.exit(1);
}

// Load data
const repoAnalysis = JSON.parse(fs.readFileSync(REPO_ANALYSIS, 'utf-8'));
const existingDocs = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf-8'));

console.log(`📊 Loaded:`);
console.log(`   - Existing chunks: ${existingDocs.chunks.length}`);
console.log(`   - Repo analysis: ${repoAnalysis.authentication.typescript.length} TS examples`);
console.log(`   - Helper functions: ${repoAnalysis.helperFunctions.length}`);
console.log(`   - Patterns: ${repoAnalysis.implementationPatterns.length}\n`);

// ---------------------------------------------------------------------------
// Caching helpers
// ---------------------------------------------------------------------------

/**
 * Atomic JSON write — prevents mid-write corruption if killed.
 */
function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Hash a slice of repoAnalysis data so we can detect changes.
 * Pass any JSON-serializable array/object.
 */
function computeSourceFingerprint(sourceData) {
  return crypto.createHash('md5').update(JSON.stringify(sourceData)).digest('hex').substring(0, 12);
}

/**
 * Load the source-fingerprint cache from existing docs. Returns {} if FORCE
 * or missing.
 */
const sourceFingerprints = FORCE ? {} : existingDocs._enrichedFingerprints || {};
if (Object.keys(sourceFingerprints).length > 0) {
  console.log(`📦 Loaded ${Object.keys(sourceFingerprints).length} cached enriched-chunk fingerprints.\n`);
}

/**
 * Returns true if the source slice's fingerprint matches the stored value
 * for this sourceKey. Caller should return early to skip the AI call.
 */
function isCacheHit(sourceKey, fingerprint) {
  return sourceFingerprints[sourceKey] === fingerprint;
}

/**
 * Insert-or-update a chunk in the docs array by stable sourceKey. Replaces
 * in place if found, appends otherwise. Fixes the prior "append-only" bug
 * where running twice would duplicate every enriched chunk.
 */
function upsertChunk(newChunk) {
  const idx = existingDocs.chunks.findIndex((c) => c.sourceKey === newChunk.sourceKey);
  if (idx >= 0) {
    existingDocs.chunks[idx] = newChunk;
    console.log(`   📝 Replaced chunk for sourceKey=${newChunk.sourceKey}`);
  } else {
    existingDocs.chunks.push(newChunk);
    console.log(`   ✅ Added chunk for sourceKey=${newChunk.sourceKey}`);
  }
  // Persist fingerprint + checkpoint
  sourceFingerprints[newChunk.sourceKey] = newChunk.sourceFingerprint;
}

// Track new chunks (still useful for stats)
const newChunks = [];

// Helper to create a documentation chunk
function createChunk(title, category, content, keywords, sourceKey, sourceFingerprint) {
  const chunk = {
    id: `enriched-${sourceKey}`,
    sourceKey,
    sourceFingerprint,
    title,
    category,
    content,
    keywords,
    source: USE_AI
      ? 'Generated from example repositories with AI enhancement'
      : 'Generated from example repositories',
    generatedAt: new Date().toISOString(),
  };
  newChunks.push(chunk);
  upsertChunk(chunk);
  return chunk;
}

// AI enhancement helper
async function enhanceWithAI(content, context) {
  if (!USE_AI) return content;

  try {
    console.log('   🤖 Enhancing with AI...');

    const completion = await openai.chat.completions.create({
      model: NEAR_AI_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are an expert technical documentation writer. Enhance the following documentation about Orderly Network authentication.

Improve the content by:
1. Adding clear explanations of WHY each step is needed
2. Adding inline comments to code examples
3. Including common pitfalls and how to avoid them
4. Adding a "When to use this" section
5. Improving the flow and readability
6. Adding cross-references to related concepts

Keep all code examples intact and working. Only enhance the narrative content around them.`,
        },
        {
          role: 'user',
          content: `Context: ${context}\n\nContent to enhance:\n${content}`,
        },
      ],
      temperature: 0.3,
    });

    return completion.choices[0]?.message?.content || content;
  } catch (error) {
    console.warn('   ⚠️  AI enhancement failed:', error.message);
    return content;
  }
}

// 1. Create comprehensive auth chunk from TypeScript examples
async function generateTSAuthChunk() {
  console.log('📝 Generating: Direct API Authentication (TypeScript)');

  const authExample = repoAnalysis.authentication.typescript.find(
    (ex) => ex.filename === 'authenticationExample.ts'
  );
  const signerExample = repoAnalysis.authentication.typescript.find(
    (ex) => ex.filename === 'signer.ts'
  );

  if (!authExample || !signerExample) {
    console.log('   ⚠️  Missing required examples, skipping');
    return;
  }

  const sourceKey = 'ts-auth';
  const sourceFingerprint = computeSourceFingerprint({ authExample, signerExample });
  if (isCacheHit(sourceKey, sourceFingerprint)) {
    console.log(`   ⏭️  Cache hit for ${sourceKey}, skipping`);
    return;
  }

  let content = `# Direct API Authentication (TypeScript)

This guide shows how to authenticate with Orderly Network using direct API calls without the SDK. This is useful for backend services, trading bots, or when you need full control over the authentication flow.

## Prerequisites

\`\`\`bash
npm install @noble/ed25519 bs58
\`\`\`

## Overview

Orderly uses a two-key system:
1. **Wallet Key** - Your Web3 wallet (Ethereum/EVM) for on-chain operations
2. **Orderly Key** - An Ed25519 keypair for API authentication

## The signAndSendRequest Function

This is the core function for making authenticated API requests:

\`\`\`typescript
${signerExample.content}
\`\`\`

### How it works:
1. Creates a message string: \`timestamp + method + path + body\`
2. Signs with your Ed25519 private key using @noble/ed25519
3. Encodes signature as base64url
4. Adds required headers:
   - \`orderly-key\`: Your Ed25519 public key (with \`ed25519:\` prefix)
   - \`orderly-signature\`: The base64url-encoded signature
   - \`orderly-timestamp\`: Current timestamp in milliseconds
   - \`orderly-account-id\`: Your Orderly account ID

## Complete Example: Placing an Order

\`\`\`typescript
${authExample.content}
\`\`\`

## Key Points

- **Environment Variable**: Store your Orderly secret (private key) securely
- **Node.js Crypto**: The script sets up webcrypto for @noble/ed25519 in Node.js
- **Base58 Decoding**: Orderly keys are base58-encoded and need decoding before use
- **Timestamp**: Must be in milliseconds and recent (within ~1 minute)

## Common Issues

**Error: "Invalid signature"**
- Ensure message format is exactly: \`{timestamp}{method}{path}{body}\`
- No extra spaces or newlines
- Timestamp must be current

**Error: "Unauthorized"**
- Check that your Orderly key is registered and not expired
- Verify account_id matches the key's registered account`;

  if (USE_AI) {
    content = await enhanceWithAI(
      content,
      'Direct API Authentication guide for TypeScript developers'
    );
  }

  createChunk('Direct API Authentication (TypeScript)', 'API', content, [
    'authentication',
    'api',
    'typescript',
    'ed25519',
    'signing',
    'direct integration',
    'backend',
  ], sourceKey, sourceFingerprint);

  console.log('   ✅ Created');
}

// 2. Create account registration chunk
async function generateRegistrationChunk() {
  console.log('📝 Generating: Account Registration with EIP-712');

  const regExample = repoAnalysis.authentication.typescript.find(
    (ex) => ex.filename === 'registerExample.ts'
  );

  if (!regExample) {
    console.log('   ⚠️  Missing registerExample.ts, skipping');
    return;
  }

  const sourceKey = 'registration';
  const sourceFingerprint = computeSourceFingerprint(regExample);
  if (isCacheHit(sourceKey, sourceFingerprint)) {
    console.log(`   ⏭️  Cache hit for ${sourceKey}, skipping`);
    return;
  }

  let content = `# Account Registration with EIP-712

This guide explains how to register a new account on Orderly Network using EIP-712 typed data signing.

## Overview

Before you can trade on Orderly, you need to:
1. Register your wallet address with a broker
2. Receive an Orderly Account ID
3. Create an Orderly key for API authentication

## EIP-712 Domain Configuration

\`\`\`typescript
const OFF_CHAIN_DOMAIN = {
  name: 'Orderly',
  version: '1',
  chainId: 421614, // Arbitrum Sepolia testnet
  verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC'
};
\`\`\`

**Mainnet vs Testnet:**
- Testnet chainId: \`421614\` (Arbitrum Sepolia)
- Mainnet chainId: \`42161\` (Arbitrum One)

## Registration Message Type

\`\`\`typescript
const MESSAGE_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' }
  ],
  Registration: [
    { name: 'brokerId', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'timestamp', type: 'uint64' },
    { name: 'registrationNonce', type: 'uint256' }
  ]
};
\`\`\`

## Complete Registration Example

\`\`\`typescript
${regExample.content}
\`\`\`

## Step-by-Step Breakdown

### 1. Get Registration Nonce

\`\`\`typescript
const nonceRes = await fetch(\`\${BASE_URL}/v1/registration_nonce\`);
const nonceJson = await nonceRes.json();
const registrationNonce = nonceJson.data.registration_nonce;
\`\`\`

**Important:** Nonces expire after 2 minutes. Get a fresh nonce immediately before signing.

### 2. Create Registration Message

\`\`\`typescript
const registerMessage = {
  brokerId: 'woofi_pro',     // Your broker ID
  chainId: 421614,           // Chain ID
  timestamp: Date.now(),     // Current timestamp
  registrationNonce         // From step 1
};
\`\`\`

### 3. Sign with Wallet

\`\`\`typescript
const signature = await wallet.signTypedData(
  OFF_CHAIN_DOMAIN,
  { Registration: MESSAGE_TYPES.Registration },
  registerMessage
);
\`\`\`

### 4. Submit Registration

\`\`\`typescript
const registerRes = await fetch(\`\${BASE_URL}/v1/register_account\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: registerMessage,
    signature,
    userAddress: await wallet.getAddress()
  })
});
\`\`\`

### 5. Receive Account ID

\`\`\`typescript
const registerJson = await registerRes.json();
const orderlyAccountId = registerJson.data.account_id;
// Example: \`0x1234...abcd\`
\`\`\`

## Next Steps

After registration, you need to create an Orderly key for API authentication. See "Creating Orderly Keys" guide.`;

  if (USE_AI) {
    content = await enhanceWithAI(content, 'Account registration process using EIP-712 signing');
  }

  createChunk('Account Registration with EIP-712', 'API', content, [
    'registration',
    'eip-712',
    'authentication',
    'account',
    'wallet',
    'signing',
  ], sourceKey, sourceFingerprint);

  console.log('   ✅ Created');
}

// 3. Create Orderly key creation chunk
async function generateOrderlyKeyChunk() {
  console.log('📝 Generating: Creating Orderly Keys');

  const keyExample = repoAnalysis.authentication.typescript.find(
    (ex) => ex.filename === 'orderlyKeyExample.ts'
  );

  if (!keyExample) {
    console.log('   ⚠️  Missing orderlyKeyExample.ts, skipping');
    return;
  }

  const sourceKey = 'orderly-key';
  const sourceFingerprint = computeSourceFingerprint(keyExample);
  if (isCacheHit(sourceKey, sourceFingerprint)) {
    console.log(`   ⏭️  Cache hit for ${sourceKey}, skipping`);
    return;
  }

  let content = `# Creating Orderly Keys

Orderly keys are Ed25519 keypairs used for API authentication. This guide shows how to generate and register them.

## What are Orderly Keys?

- **Purpose**: Authenticate API requests (trading, account info, etc.)
- **Format**: Ed25519 keypair (public + private key)
- **Storage**: You manage the private key (secure storage recommended)
- **Expiration**: Keys can have expiration dates (optional)

## Prerequisites

\`\`\`bash
npm install @noble/ed25519 ethers
\`\`\`

## Complete Example

\`\`\`typescript
${keyExample.content}
\`\`\`

## Step-by-Step Breakdown

### 1. Generate Ed25519 Keypair

\`\`\`typescript
import { getPublicKeyAsync, utils } from '@noble/ed25519';
import { encodeBase58 } from 'ethers';

// Generate random private key
const privateKey = utils.randomPrivateKey();

// Derive public key
const publicKeyBytes = await getPublicKeyAsync(privateKey);
const orderlyKey = \`ed25519:\${encodeBase58(publicKeyBytes)}\`;

// Store private key securely (e.g., environment variable)
const orderlySecret = encodeBase58(privateKey);
\`\`\`

### 2. Create AddOrderlyKey Message

\`\`\`typescript
const addKeyMessage = {
  brokerId: 'woofi_pro',
  chainId: 421614,
  orderlyKey,                           // ed25519:xxx...
  scope: 'read,trading',               // Permissions
  timestamp: Date.now(),
  expiration: timestamp + (365 * 24 * 60 * 60 * 1000) // 1 year
};
\`\`\`

**Scopes:**
- \`read\`: Read account data only
- \`read,trading\`: Read + place/cancel orders
- \`read,asset\`: Read + deposits/withdrawals
- \`read,trading,asset\`: Full access

### 3. Sign with Wallet

Uses the same EIP-712 domain as registration:

\`\`\`typescript
const signature = await wallet.signTypedData(
  OFF_CHAIN_DOMAIN,
  { AddOrderlyKey: MESSAGE_TYPES.AddOrderlyKey },
  addKeyMessage
);
\`\`\`

### 4. Register Key with Orderly

\`\`\`typescript
const keyRes = await fetch(\`\${BASE_URL}/v1/orderly_key\`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: addKeyMessage,
    signature,
    userAddress: await wallet.getAddress()
  })
});
\`\`\`

### 5. Store Private Key Securely

**⚠️ IMPORTANT: Never expose the private key in client-side code or commit to git**

Options for storage:
- **Backend**: Environment variables, secret managers (AWS Secrets Manager, etc.)
- **Frontend**: localStorage (convenient but less secure), or prompt user each time
- **Mobile**: Keychain/Keystore

\`\`\`typescript
// Example: Save to localStorage (frontend)
localStorage.setItem('orderly_secret', encodeBase58(privateKey));

// Later: Retrieve and decode
const secret = localStorage.getItem('orderly_secret');
const privateKey = decodeBase58(secret);
\`\`\`

## Using the Key

Once registered, use your key to sign API requests:

\`\`\`typescript
// See "Direct API Authentication" guide for signAndSendRequest
const response = await signAndSendRequest(
  orderlyAccountId,
  privateKey,
  'https://testnet-api-evm.orderly.org/v1/order',
  {
    method: 'POST',
    body: JSON.stringify({ /* order data */ })
  }
);
\`\`\`

## Security Best Practices

1. **Never hardcode keys** in source code
2. **Use environment variables** for backend services
3. **Rotate keys regularly** (set expiration dates)
4. **Use minimal scope** (don't use \`read,trading,asset\` if you only need \`read\`)
5. **Monitor key usage** for suspicious activity`;

  if (USE_AI) {
    content = await enhanceWithAI(content, 'Creating and managing Orderly API keys');
  }

  createChunk('Creating Orderly Keys', 'API', content, [
    'orderly key',
    'ed25519',
    'authentication',
    'api key',
    'key management',
    'security',
  ], sourceKey, sourceFingerprint);

  console.log('   ✅ Created');
}

// 4. Create EIP-712 message types reference chunk
async function generateMessageTypesChunk() {
  console.log('📝 Generating: EIP-712 Message Types Reference');

  if (Object.keys(repoAnalysis.messageTypes).length === 0) {
    console.log('   ⚠️  No message types found in analysis, skipping');
    return;
  }

  const sourceKey = 'message-types';
  const sourceFingerprint = computeSourceFingerprint(repoAnalysis.messageTypes);
  if (isCacheHit(sourceKey, sourceFingerprint)) {
    console.log(`   ⏭️  Cache hit for ${sourceKey}, skipping`);
    return;
  }

  let content = `# EIP-712 Message Types Reference

Complete reference of all EIP-712 typed data structures used in Orderly Network.

## Domain Configuration

All Orderly EIP-712 signatures use this domain:

\`\`\`typescript
const OFF_CHAIN_DOMAIN = {
  name: 'Orderly',
  version: '1',
  chainId: 421614, // or 42161 for mainnet
  verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC'
};
\`\`\`

## Message Types

`;

  for (const [typeName, typeData] of Object.entries(repoAnalysis.messageTypes)) {
    content += `### ${typeName}

${typeData.description}

\`\`\`typescript
${typeName}: [
${typeData.fields}
]
\`\`\`

`;
  }

  content += `## Usage Example

\`\`\`typescript
// Example: Signing a Withdraw message
const withdrawMessage = {
  brokerId: 'woofi_pro',
  chainId: 421614,
  receiver: '0x...',
  token: 'USDC',
  amount: 1000000, // 1 USDC (6 decimals)
  withdrawNonce: 123,
  timestamp: Date.now()
};

const signature = await wallet.signTypedData(
  OFF_CHAIN_DOMAIN,
  { Withdraw: MESSAGE_TYPES.Withdraw },
  withdrawMessage
);
\`\`\`

## See Also

- Account Registration guide
- Creating Orderly Keys guide
- Withdrawal workflow`;

  if (USE_AI) {
    content = await enhanceWithAI(content, 'EIP-712 message types reference for Orderly Network');
  }

  createChunk('EIP-712 Message Types Reference', 'API', content, [
    'eip-712',
    'message types',
    'signing',
    'reference',
    'typed data',
  ], sourceKey, sourceFingerprint);

  console.log('   ✅ Created');
}

// 5. Create implementation patterns chunk
async function generatePatternsChunk() {
  console.log('📝 Generating: Common Implementation Patterns');

  if (repoAnalysis.implementationPatterns.length === 0) {
    console.log('   ⚠️  No patterns found, skipping');
    return;
  }

  const sourceKey = 'patterns';
  const sourceFingerprint = computeSourceFingerprint(repoAnalysis.implementationPatterns);
  if (isCacheHit(sourceKey, sourceFingerprint)) {
    console.log(`   ⏭️  Cache hit for ${sourceKey}, skipping`);
    return;
  }

  let content = `# Common Implementation Patterns

Practical patterns for common Orderly integration scenarios.

`;

  for (const pattern of repoAnalysis.implementationPatterns) {
    content += `## ${pattern.name}

${pattern.description}

### Steps

`;
    for (let i = 0; i < pattern.steps.length; i++) {
      content += `${i + 1}. ${pattern.steps[i]}\n`;
    }

    content += `\n**Code Reference:** ${pattern.codeReference}\n\n`;
  }

  content += `## Choosing the Right Pattern

- **New User Onboarding**: Account Registration → Orderly Key Creation → Deposit
- **Trading Bot**: Orderly Key Creation (backend) → Direct API Authentication
- **Multisig/Safe**: Delegate Signer Setup → Delegate Operations
- **Portfolio Management**: Account Registration → Deposit → Trading → Withdrawal`;

  if (USE_AI) {
    content = await enhanceWithAI(
      content,
      'Common implementation patterns for Orderly integration'
    );
  }

  createChunk('Common Implementation Patterns', 'Overview', content, [
    'patterns',
    'implementation',
    'workflow',
    'architecture',
    'integration',
  ], sourceKey, sourceFingerprint);

  console.log('   ✅ Created');
}

// 6. Create Python examples chunk
async function generatePythonChunk() {
  console.log('📝 Generating: Direct API Authentication (Python)');

  if (repoAnalysis.authentication.python.length === 0) {
    console.log('   ⚠️  No Python examples found, skipping');
    return;
  }

  const sourceKey = 'python-auth';
  const sourceFingerprint = computeSourceFingerprint(repoAnalysis.authentication.python);
  if (isCacheHit(sourceKey, sourceFingerprint)) {
    console.log(`   ⏭️  Cache hit for ${sourceKey}, skipping`);
    return;
  }

  let content = `# Direct API Authentication (Python)

Python examples for Orderly Network API authentication.

## Prerequisites

\`\`\`bash
pip install orderly-evm-connector-python
\`\`\`

## Examples from Repository

`;

  for (const pyExample of repoAnalysis.authentication.python) {
    content += `### ${pyExample.filename}

${pyExample.description}

\`\`\`python
${pyExample.content}
\`\`\`

`;
  }

  if (USE_AI) {
    content = await enhanceWithAI(content, 'Python API authentication examples');
  }

  createChunk('Direct API Authentication (Python)', 'API', content, [
    'python',
    'authentication',
    'api',
    'backend',
    'trading bot',
  ], sourceKey, sourceFingerprint);

  console.log('   ✅ Created');
}

// 7. Create Java examples chunk
async function generateJavaChunk() {
  console.log('📝 Generating: Direct API Authentication (Java)');

  if (repoAnalysis.authentication.java.length === 0) {
    console.log('   ⚠️  No Java examples found, skipping');
    return;
  }

  const sourceKey = 'java-auth';
  const sourceFingerprint = computeSourceFingerprint(repoAnalysis.authentication.java);
  if (isCacheHit(sourceKey, sourceFingerprint)) {
    console.log(`   ⏭️  Cache hit for ${sourceKey}, skipping`);
    return;
  }

  let content = `# Direct API Authentication (Java)

Java examples for Orderly Network API authentication.

## Prerequisites

Add the Orderly connector to your project.

## Examples from Repository

`;

  for (const javaExample of repoAnalysis.authentication.java.slice(0, 3)) {
    // Limit to first 3
    content += `### ${javaExample.filename}

${javaExample.description}

\`\`\`java
${javaExample.content.substring(0, 2000)}${javaExample.content.length > 2000 ? '\n// ... (truncated)' : ''}
\`\`\`

`;
  }

  if (USE_AI) {
    content = await enhanceWithAI(content, 'Java API authentication examples');
  }

  createChunk('Direct API Authentication (Java)', 'API', content, [
    'java',
    'authentication',
    'api',
    'backend',
    'enterprise',
  ], sourceKey, sourceFingerprint);

  console.log('   ✅ Created');
}

// Main execution
async function main() {
  // Generate all chunks
  await generateTSAuthChunk();
  await generateRegistrationChunk();
  await generateOrderlyKeyChunk();
  await generateMessageTypesChunk();
  await generatePatternsChunk();
  await generatePythonChunk();
  await generateJavaChunk();

  console.log(`\n📊 Processed ${newChunks.length} documentation chunks this run`);

  // existingDocs.chunks has already been mutated in-place by upsertChunk
  // (replaces by sourceKey if exists, appends otherwise). This fixes the
  // prior append-only bug where running twice would duplicate every chunk.
  const previousTotal = existingDocs.chunks.length - newChunks.length;
  const enrichedDocs = {
    ...existingDocs,
    chunks: existingDocs.chunks,
    _enrichedFingerprints: sourceFingerprints,
    metadata: {
      ...existingDocs.metadata,
      totalChunks: existingDocs.chunks.length,
      enrichedAt: new Date().toISOString(),
      enrichedFrom: USE_AI
        ? `OrderlyNetwork/examples and OrderlyNetwork/broker-registration repos (with AI enhancement${FORCE ? ', FORCE' : ''})`
        : 'OrderlyNetwork/examples and OrderlyNetwork/broker-registration repos',
      enrichmentStats: {
        chunksThisRun: newChunks.length,
        previousTotal: previousTotal < 0 ? 0 : previousTotal,
        aiEnhanced: USE_AI,
        cache: {
          hits: newChunks.length === 0 ? 'all cache hits' : 'see per-chunk logs',
        },
      },
    },
  };

  // Atomic write
  atomicWriteJson(DOCS_FILE, enrichedDocs);

  console.log('\n✅ Documentation enriched successfully!');
  console.log(`📄 Output: ${DOCS_FILE}`);
  console.log(`\nSummary:`);
  console.log(`   - Total chunks: ${existingDocs.chunks.length}`);
  console.log(`   - Processed this run: ${newChunks.length}`);
  if (USE_AI) {
    console.log(`   - AI enhanced: Yes`);
  }
  if (newChunks.length > 0) {
    console.log(`\nChunks processed this run:`);
    newChunks.forEach((chunk) => {
      console.log(`   - ${chunk.title} (${chunk.category}) [${chunk.sourceKey}]`);
    });
  }
  console.log('\nNext: Run generate_enriched_workflows.js to enhance workflows');
}

main();
