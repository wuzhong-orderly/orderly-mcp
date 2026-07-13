import Fuse from 'fuse.js';
import svApiData from '../data/sv-api.json' with { type: 'json' };

export interface SvApiInfoResult {
  content: Array<{ type: 'text'; text: string }>;
}

interface SvEndpoint {
  path: string;
  method: string;
  summary: string;
  description: string;
  tags: string[];
  parameters?: Array<{
    name: string;
    in: string;
    type: string;
    required: boolean;
    description: string;
    example?: unknown;
  }>;
  responses?: Array<{
    code: number | string;
    description: string;
    schema: string | null;
  }>;
  example?: string;
}

interface SvCategory {
  name: string;
  description: string;
  endpoints: SvEndpoint[];
}

interface SvApiData {
  version: string;
  title: string;
  description: string;
  baseUrl: string;
  categories: SvCategory[];
  endpoints: SvEndpoint[];
  schemas: Array<{
    name: string;
    description: string;
    type: string;
    properties?: Array<{
      name: string;
      type: string;
      description: string;
      required: boolean;
      example?: unknown;
      enum?: string[] | null;
    }>;
    required?: string[];
  }>;
  commonErrors: Array<{
    code: number;
    message: string;
    description: string;
  }>;
}

let fuseInstance: Fuse<SvEndpoint> | null = null;

function getFuseInstance(): Fuse<SvEndpoint> {
  if (!fuseInstance) {
    const data = svApiData as SvApiData;
    const fuseOptions = {
      keys: [
        { name: 'path', weight: 0.4 },
        { name: 'summary', weight: 0.3 },
        { name: 'description', weight: 0.2 },
      ],
      threshold: 0.4,
      distance: 100,
      includeScore: true,
      minMatchCharLength: 2,
      shouldSort: true,
    };
    fuseInstance = new Fuse(data.endpoints, fuseOptions);
  }
  return fuseInstance;
}

export async function getSvApiInfo(endpoint?: string, category?: string): Promise<SvApiInfoResult> {
  const data = svApiData as SvApiData;

  if (category) {
    const normalizedCategory = category.toLowerCase().trim();
    const matchingCategory = data.categories.find(
      (c) =>
        c.name.toLowerCase().includes(normalizedCategory) ||
        c.description.toLowerCase().includes(normalizedCategory)
    );

    if (matchingCategory) {
      let text = `# ${matchingCategory.name}\n\n`;
      text += `${matchingCategory.description}\n\n`;
      text += `## Endpoints\n\n`;

      matchingCategory.endpoints.forEach((ep) => {
        text += `### ${ep.method} ${ep.path}\n\n`;
        text += `**Summary:** ${ep.summary}\n\n`;
        if (ep.description) {
          text += `${ep.description}\n\n`;
        }
        if (ep.parameters && ep.parameters.length > 0) {
          text += `**Parameters:**\n\n`;
          ep.parameters.forEach((param) => {
            text += `- **${param.name}** (${param.in}, ${param.type})${param.required ? ' *required*' : ''}\n`;
            if (param.description) {
              text += `  ${param.description}\n`;
            }
            text += '\n';
          });
        }
        if (ep.example) {
          text += `**Example:**\n\n\`\`\`typescript\n${ep.example}\n\`\`\`\n\n`;
        }
        text += '---\n\n';
      });

      return {
        content: [{ type: 'text', text }],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Category "${category}" not found. Available categories: ${data.categories.map((c) => c.name).join(', ')}`,
        },
      ],
    };
  }

  if (!endpoint) {
    let text = `# Orderly Strategy Vault API\n\n`;
    text += `## Overview\n\n`;
    text += `${data.description}\n\n`;

    text += `## Base URL\n\n`;
    text += `- **Mainnet:** ${data.baseUrl}\n\n`;

    text += `## How to Navigate This API\n\n`;
    text += `### 1. Browse by Category\n\n`;
    text += `Use the "category" parameter to see all endpoints in a specific area:\n\n`;
    text += `\`\`\`\n`;
    data.categories.forEach((cat) => {
      text += `get_strategy_vault_api_info category="${cat.name.toLowerCase().replace(/\s+/g, '_')}"\n`;
    });
    text += `\`\`\`\n\n`;

    text += `### 2. Search by Endpoint\n\n`;
    text += `Use the "endpoint" parameter to find specific endpoints:\n\n`;
    text += `\`\`\`\n`;
    text += `get_strategy_vault_api_info endpoint="/v1/public/strategy_vault/vault/info"\n`;
    text += `get_strategy_vault_api_info endpoint="sp/info"\n`;
    text += `get_strategy_vault_api_info endpoint="lp/performance"\n`;
    text += `\`\`\`\n\n`;

    text += `## Available Categories\n\n`;
    data.categories.forEach((cat) => {
      text += `### ${cat.name}\n\n`;
      text += `${cat.description}\n\n`;
      text += `**${cat.endpoints.length} Endpoints:**\n\n`;
      cat.endpoints.forEach((ep) => {
        text += `- **${ep.method} ${ep.path}** - ${ep.summary}\n`;
      });
      text += '\n';
    });

    text += `## Common Errors\n\n`;
    data.commonErrors.forEach((err) => {
      text += `- **${err.code}** - ${err.message}: ${err.description}\n`;
    });

    text += `\n## Tips for Using the Strategy Vault API\n\n`;
    text += `1. **No Authentication Required**: All Strategy Vault endpoints are public\n`;
    text += `2. **Rate Limits**: 10 requests per second per IP address\n`;
    text += `3. **Read-Only**: All endpoints are GET requests (query historical/aggregated data)\n`;
    text += `4. **Categories**: Organized by role (vault, strategy provider, liquidity provider, fund, user)\n`;

    return {
      content: [{ type: 'text', text }],
    };
  }

  const normalizedEndpoint = endpoint.toLowerCase().trim();
  const fuse = getFuseInstance();
  const searchResults = fuse.search(normalizedEndpoint, { limit: 5 });
  const qualityResults = searchResults.filter((result) => (result.score ?? 1) < 0.6);

  if (qualityResults.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `Endpoint "${endpoint}" not found. Use without endpoint parameter to see all available endpoints and categories.`,
        },
      ],
    };
  }

  const match = qualityResults[0].item;

  let text = `# ${match.method} ${match.path}\n\n`;
  text += `**Summary:** ${match.summary}\n\n`;

  if (match.description) {
    text += `${match.description}\n\n`;
  }

  if (match.parameters && match.parameters.length > 0) {
    text += `## Parameters\n\n`;
    match.parameters.forEach((param) => {
      text += `### ${param.name}\n\n`;
      text += `- **Location:** ${param.in}\n`;
      text += `- **Type:** ${param.type}\n`;
      text += `- **Required:** ${param.required ? 'Yes' : 'No'}\n`;
      if (param.description) {
        text += `- **Description:** ${param.description}\n`;
      }
      if (param.example !== null && param.example !== undefined) {
        text += `- **Example:** \`${JSON.stringify(param.example)}\`\n`;
      }
      text += '\n';
    });
  }

  if (match.responses && match.responses.length > 0) {
    text += `## Responses\n\n`;
    match.responses.forEach((resp) => {
      text += `### ${resp.code}\n\n`;
      text += `${resp.description}\n\n`;
      if (resp.schema) {
        text += `**Schema:**\n\n\`\`\`json\n${resp.schema}\n\`\`\`\n\n`;
      }
    });
  }

  if (match.example) {
    text += `## Example\n\n\`\`\`typescript\n${match.example}\n\`\`\``;
  }

  return {
    content: [{ type: 'text', text }],
  };
}

export function clearSvApiInfoCache(): void {
  fuseInstance = null;
}
