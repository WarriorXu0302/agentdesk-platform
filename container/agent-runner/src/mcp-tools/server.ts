/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { MCP_SERVER_NAME } from '../branding.js';
import { context, getTracer, parentContextFromEnv, recordError } from '../observability/tracer.js';
import { mcpSpanName } from '../observability/mcp-span-name.js';
import { redactedParamSummary } from '../observability/redact.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: MCP_SERVER_NAME, version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // TOOL span (ADR-0026). The MCP server is a separate process, so it parents
    // the span under the host trace via OTEL_TRACEPARENT (parentContextFromEnv).
    // The literal `mcp.tool.execute` name is what the static coverage scanner
    // matches; updateName() then sets the real, schema-compliant
    // `mcp.<group>.<tool>` runtime name (low-cardinality, no dynamic values).
    const spanName = mcpSpanName(name);
    const tracer = getTracer();
    const startedAt = Date.now();
    return context.with(parentContextFromEnv(), () =>
      tracer.startActiveSpan('mcp.tool.execute', async (span) => {
        span.updateName(spanName);
        // Inline literal kind so the static coverage scanner detects it.
        span.setAttribute('openinference.span.kind', 'TOOL');
        span.setAttribute('tool.name', name);
        // Desensitized only — never raw argument values (see redact.ts).
        span.setAttribute('tool.parameters', redactedParamSummary(args));
        // Gateway tools front the ERP boundary; surface the coarse operation.
        if (name.startsWith('gateway_') && args && typeof args === 'object') {
          const op = (args as Record<string, unknown>).operation;
          if (typeof op === 'string') span.setAttribute('erp.operation', op);
        }
        try {
          const tool = toolMap.get(name);
          if (!tool) {
            return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
          }
          const result = await tool.handler(args ?? {});
          span.setAttribute('tool.duration_ms', Date.now() - startedAt);
          return result;
        } catch (err) {
          recordError(span, err, 'mcp_tool_error');
          throw err;
        } finally {
          span.end();
        }
      }),
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
