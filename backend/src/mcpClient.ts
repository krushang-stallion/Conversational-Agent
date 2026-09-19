import http from 'http';
import https from 'https';
import { Readable } from 'stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface MCPToolDeclaration {
  name: string;
  description?: string;
  parameters?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  nodeModule?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  detail: string;
  hot?: boolean;
}

/**
 * Dedicated fetch implementation using agent: false to force a new TCP connection,
 * preventing socket lockup / pooling deadlocks when an SSE stream is open on the same host.
 */
function dedicatedFetch(url: string | URL, init?: any): Promise<Response> {
  return new Promise((resolve, reject) => {
    try {
      const urlObj = typeof url === 'string' ? new URL(url) : url;
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const rawHeaders = init?.headers ? new Headers(init.headers) : new Headers();
      const headersObj: Record<string, string> = {};
      rawHeaders.forEach((v, k) => {
        headersObj[k] = v;
      });

      const req = client.request(urlObj, {
        method: init?.method || 'GET',
        headers: headersObj,
        agent: false,
        signal: init?.signal
      }, (res) => {
        const resHeaders = new Headers();
        Object.entries(res.headers).forEach(([k, v]) => {
          if (Array.isArray(v)) {
            v.forEach(val => resHeaders.append(k, val));
          } else if (v) {
            resHeaders.set(k, v);
          }
        });

        const contentType = res.headers['content-type'] || '';
        const method = (init?.method || 'GET').toUpperCase();
        const isStreaming = contentType.includes('text/event-stream') || method === 'GET';

        if (isStreaming) {
          const webStream = Readable.toWeb(res) as ReadableStream;
          const responseObj = new Response(webStream, {
            status: res.statusCode || 200,
            statusText: res.statusMessage || 'OK',
            headers: resHeaders
          });
          resolve(responseObj);
        } else {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const bodyBuffer = Buffer.concat(chunks);
            const responseObj = new Response(bodyBuffer, {
              status: res.statusCode || 200,
              statusText: res.statusMessage || 'OK',
              headers: resHeaders
            });
            resolve(responseObj);
          });
        }
      });

      req.on('error', reject);
      if (init?.body) {
        req.write(init.body);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

class ResilientSSEClientTransport extends SSEClientTransport {
  constructor(url: URL, opts?: any) {
    super(url, { ...opts, fetch: dedicatedFetch });
  }

  override async start(): Promise<void> {
    await super.start();
    const evSource = (this as any)._eventSource;
    if (evSource && typeof evSource.addEventListener === 'function') {
      const handleEvent = (event: any) => {
        try {
          if (event && event.data && this.onmessage) {
            const parsed = JSON.parse(event.data);
            if (parsed && (parsed.jsonrpc || parsed.result || parsed.error || parsed.id !== undefined)) {
              this.onmessage(parsed);
            }
          }
        } catch (e) {}
      };

      ['message', 'jsonrpc', 'mcp', 'response', 'data'].forEach((evtType) => {
        evSource.addEventListener(evtType, handleEvent);
      });
    }
  }
}

export class MCPClientManager {
  private client: Client | null = null;
  private transport: any = null;
  private sseUrl: string | undefined;
  private tools: MCPToolDeclaration[] = [];
  private isConnected = false;

  constructor(sseUrl?: string) {
    this.sseUrl = sseUrl;
  }

  public async initialize(): Promise<void> {
    if (this.sseUrl && this.sseUrl.startsWith('http') && !this.sseUrl.includes('your-mcp-server.com')) {
      console.log(`🔌 Connecting to remote MCP Server at ${this.sseUrl}...`);

      const cleanUrl = this.sseUrl.trim();

      // Priority Strategy: If URL explicitly targets an /sse endpoint, connect via ResilientSSEClientTransport immediately
      if (cleanUrl.endsWith('/sse')) {
        try {
          console.log(`📡 Connecting via SSE transport: ${cleanUrl}`);
          const transport = new ResilientSSEClientTransport(new URL(cleanUrl));
          const client = new Client(
            { name: 'sphere-agent-client', version: '1.0.0' },
            { capabilities: {} }
          );

          await client.connect(transport);
          this.client = client;
          this.transport = transport;
          this.isConnected = true;
          console.log(`✅ Connected to remote MCP Server via SSE (${cleanUrl})`);

          const remoteTools = await this.client.listTools();
          this.tools = remoteTools.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: {
              type: 'OBJECT',
              properties: t.inputSchema?.properties || {},
              required: (t.inputSchema?.required as string[]) || [],
            }
          }));
          console.log(`🛠️ Discovered ${this.tools.length} remote MCP tools:`, this.tools.map(t => t.name).join(', '));
          console.log('📋 Full Remote Tool Declarations:', JSON.stringify(this.tools, null, 2));
          return;
        } catch (err: any) {
          console.log(`ℹ️ Direct SSE connection attempt failed (${err?.message || err}). Trying fallback transport strategies...`);
        }
      }

      // Fallback transport options if direct SSE connection was not successful
      const urlCandidates: string[] = [cleanUrl];
      if (cleanUrl.endsWith('/sse')) {
        urlCandidates.push(cleanUrl.replace(/\/sse$/, ''));
        urlCandidates.push(cleanUrl.replace(/\/sse$/, '/mcp'));
        urlCandidates.push(cleanUrl.replace(/\/sse$/, '/messages'));
      } else {
        const base = cleanUrl.replace(/\/$/, '');
        urlCandidates.push(`${base}/sse`);
        urlCandidates.push(`${base}/mcp`);
      }

      const uniqueCandidates = Array.from(new Set(urlCandidates));

      // Try SSE transport on candidates
      for (const targetUrl of uniqueCandidates) {
        try {
          console.log(`📡 Trying SSE transport: ${targetUrl}`);
          const transport = new ResilientSSEClientTransport(new URL(targetUrl));
          const client = new Client(
            { name: 'sphere-agent-client', version: '1.0.0' },
            { capabilities: {} }
          );

          await client.connect(transport);
          this.client = client;
          this.transport = transport;
          this.isConnected = true;
          console.log(`✅ Connected to remote MCP Server via SSE (${targetUrl})`);

          const remoteTools = await this.client.listTools();
          this.tools = remoteTools.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: {
              type: 'OBJECT',
              properties: t.inputSchema?.properties || {},
              required: (t.inputSchema?.required as string[]) || [],
            }
          }));
          console.log(`🛠️ Discovered ${this.tools.length} remote MCP tools.`);
          return;
        } catch (err: any) {
          console.log(`ℹ️ SSE connection attempt (${targetUrl}) failed: ${err?.message || err}`);
        }
      }

      // Try Streamable HTTP transport on candidates
      for (const targetUrl of uniqueCandidates) {
        try {
          console.log(`📡 Trying Streamable HTTP transport: ${targetUrl}`);
          const transport = new StreamableHTTPClientTransport(new URL(targetUrl), { fetch: dedicatedFetch });
          const client = new Client(
            { name: 'sphere-agent-client', version: '1.0.0' },
            { capabilities: {} }
          );

          await client.connect(transport);
          this.client = client;
          this.transport = transport;
          this.isConnected = true;
          console.log(`✅ Connected to remote MCP Server via Streamable HTTP (${targetUrl})`);

          const remoteTools = await this.client.listTools();
          this.tools = remoteTools.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: {
              type: 'OBJECT',
              properties: t.inputSchema?.properties || {},
              required: (t.inputSchema?.required as string[]) || [],
            }
          }));
          console.log(`🛠️ Discovered ${this.tools.length} remote MCP tools.`);
          return;
        } catch (err: any) {
          console.log(`ℹ️ Streamable HTTP connection attempt (${targetUrl}) failed: ${err?.message || err}`);
        }
      }

      console.warn('⚠️ Could not connect to remote MCP Server using any transport, using local tool definitions.');
    }

    // Default tool declarations when running in offline mode
    this.tools = [
      {
        name: 'get_user_projects',
        description: 'Fetch all active projects associated with the user account.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_project_permissions',
        description: 'Get access permissions and user role for a project.',
        parameters: {
          type: 'OBJECT',
          properties: {
            project_id: { type: 'STRING', description: 'ID of the project' },
            project_name: { type: 'STRING', description: 'Name of the project' }
          }
        }
      },
      {
        name: 'switch_project',
        description: 'Switch active workspace project context.',
        parameters: {
          type: 'OBJECT',
          properties: {
            project_id: { type: 'STRING', description: 'Project ID' }
          },
          required: ['project_id']
        }
      }
    ];
  }

  public getTools(): MCPToolDeclaration[] {
    return this.tools;
  }

  public getNodeForTool(toolName: string, args?: Record<string, any>): string {
    if (args?.project_name) return String(args.project_name);
    if (args?.project_id) return String(args.project_id);
    return toolName;
  }

  public async executeTool(name: string, args: Record<string, any>): Promise<any> {
    console.log(`⚡ Executing MCP Tool [${name}] with args:`, args);

    if (this.isConnected && this.client) {
      try {
        const result = await this.client.callTool({
          name,
          arguments: args
        });
        return result;
      } catch (err: any) {
        console.error(`❌ Remote MCP execution error for ${name}:`, err);
        return { error: err.message || 'Remote tool execution failed' };
      }
    }

    // Local simulated responses for offline testing
    switch (name) {
      case 'get_user_projects':
        return {
          status: 'success',
          projects: [
            { id: '101', name: 'Project Alpha', description: 'Production Workspace', status: 'ACTIVE' },
            { id: '102', name: 'Project Beta', description: 'Development Cluster', status: 'ACTIVE' }
          ]
        };

      case 'get_project_permissions':
        return {
          status: 'success',
          project_id: args.project_id || '101',
          project_name: args.project_name || 'Project Alpha',
          role: 'Admin / Owner',
          permissions: ['READ_RECORDS', 'WRITE_DATA', 'DEPLOY_SERVICES', 'MANAGE_ACCESS'],
          accessLevel: 'FULL_PRIVILEGE'
        };

      case 'switch_project':
        return {
          status: 'success',
          activeProjectId: args.project_id || '101',
          message: `Switched active context to project ${args.project_id || '101'}.`
        };

      default:
        return { status: 'success', message: `Executed tool ${name}`, args };
    }
  }

  public async getUserProjects(args: Record<string, any> = {}): Promise<ProjectInfo[]> {
    try {
      const result = await this.executeTool('get_user_projects', args);
      console.log('📦 Raw get_user_projects MCP result:', JSON.stringify(result, null, 2));

      if (result && (result.isError || (result.error && typeof result.error === 'string'))) {
        console.warn('⚠️ get_user_projects returned error from remote MCP server.');
        return [];
      }

      const extractedProjects: ProjectInfo[] = [];

      const processRawProject = (p: any) => {
        if (!p) return;
        if (typeof p === 'string') {
          const trimmed = p.trim();
          const lower = trimmed.toLowerCase();
          if (
            !trimmed ||
            lower === 'system' ||
            lower === 'null' ||
            lower.includes('error') ||
            lower.includes('not authenticated') ||
            lower.includes('call send_otp') ||
            lower.includes('failed')
          ) {
            return;
          }
          const id = String(extractedProjects.length + 1);
          extractedProjects.push({
            id,
            name: trimmed.toUpperCase(),
            detail: `ID: ${id} / ACTIVE`,
            hot: true
          });
          return;
        }

        const name = String(p.name || p.project_name || p.title || p.label || p.projectName || (p.id ? `Project ${p.id}` : '')).trim();
        if (!name) return;

        const lower = name.toLowerCase();
        if (
          lower === 'system' ||
          lower === 'null' ||
          lower.includes('error') ||
          lower.includes('not authenticated')
        ) {
          return;
        }

        const id = String(p.id || p.project_id || p.key || p.projectId || extractedProjects.length + 1);
        extractedProjects.push({
          id,
          name: name.toUpperCase(),
          detail: `ID: ${id} / ${p.status || 'ACTIVE'}`,
          hot: Boolean(p.status === 'ACTIVE' || p.active !== false)
        });
      };

      const findProjectArray = (obj: any): any[] => {
        if (!obj) return [];
        if (Array.isArray(obj)) return obj;
        if (typeof obj === 'object') {
          if (Array.isArray(obj.projects)) return obj.projects;
          if (Array.isArray(obj.data)) return obj.data;
          if (Array.isArray(obj.rows)) return obj.rows;
          if (Array.isArray(obj.result)) return obj.result;
          if (obj.data && typeof obj.data === 'object') return findProjectArray(obj.data);
          if (obj.result && typeof obj.result === 'object') return findProjectArray(obj.result);
        }
        return [];
      };

      // 1. If result has MCP content array
      if (result && result.content && Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === 'text' && typeof item.text === 'string') {
            try {
              const parsed = JSON.parse(item.text);
              const list = findProjectArray(parsed);
              if (Array.isArray(list) && list.length > 0) {
                list.forEach(processRawProject);
              }
            } catch (jsonErr) {
              const lines = item.text.split('\n');
              for (const line of lines) {
                const match = line.match(/(?:^|\d+[\.\)]\s*|\-\s*)([A-Za-z0-9_\- ]{3,})/);
                if (match && match[1]) {
                  processRawProject(match[1].trim());
                }
              }
            }
          }
        }
      }

      // 2. Direct result parsing
      const directList = findProjectArray(result);
      if (directList.length > 0) {
        directList.forEach(processRawProject);
      }

      if (extractedProjects.length > 0) {
        console.log(`📦 Extracted exactly ${extractedProjects.length} dynamic user projects:`, extractedProjects.map(p => p.name).join(', '));
        return extractedProjects;
      }
    } catch (err) {
      console.warn('Could not fetch projects from remote MCP tool:', err);
    }

    return [];
  }
}
