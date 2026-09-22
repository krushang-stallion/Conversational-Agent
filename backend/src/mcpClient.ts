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

  private jwtToken: string | undefined;

  constructor(sseUrl?: string) {
    this.sseUrl = sseUrl;
  }

  public async setJwtToken(token: string): Promise<void> {
    const isNewToken = this.jwtToken !== token;
    this.jwtToken = token;
    if (isNewToken || !this.isConnected) {
      console.log('🔄 Connecting MCP Client with user JWT Token transport headers...');
      await this.initialize();
    }
  }

  public async initialize(): Promise<void> {
    if (this.sseUrl && this.sseUrl.startsWith('http') && !this.sseUrl.includes('your-mcp-server.com')) {
      console.log(`🔌 Connecting to remote MCP Server at ${this.sseUrl}...`);

      const cleanUrl = this.sseUrl.trim();
      const headersOption = this.jwtToken
        ? { headers: { Authorization: `Bearer ${this.jwtToken}`, 'X-JWT-Token': this.jwtToken } }
        : undefined;

      // Priority Strategy: If URL explicitly targets an /sse endpoint, connect via ResilientSSEClientTransport immediately
      if (cleanUrl.endsWith('/sse')) {
        try {
          console.log(`📡 Connecting via SSE transport: ${cleanUrl}`);
          const transport = new ResilientSSEClientTransport(new URL(cleanUrl), headersOption);
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
          const transport = new ResilientSSEClientTransport(new URL(targetUrl), headersOption);
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
          const transport = new StreamableHTTPClientTransport(new URL(targetUrl), {
            fetch: (url: any, init: any) => {
              const headers = new Headers(init?.headers);
              if (this.jwtToken) {
                headers.set('Authorization', `Bearer ${this.jwtToken}`);
                headers.set('X-JWT-Token', this.jwtToken);
              }
              return dedicatedFetch(url, { ...init, headers });
            }
          });
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

      console.warn('⚠️ Could not connect to remote MCP Server using any transport, using default Stallion tool definitions.');
    }

    // Default registered Stallion 8 tools definition
    this.tools = [
      {
        name: 'get_user_profile',
        description: 'Retrieve authenticated user profile, designation & role.',
        parameters: { type: 'OBJECT', properties: { jwt_token: { type: 'STRING' } } }
      },
      {
        name: 'get_project_details',
        description: 'Retrieve comprehensive specs, location & developer metadata.',
        parameters: {
          type: 'OBJECT',
          properties: { project_id: { type: 'STRING' }, jwt_token: { type: 'STRING' } },
          required: ['project_id']
        }
      },
      {
        name: 'get_project_towers',
        description: 'Retrieve tower list, floor count & basement metrics.',
        parameters: {
          type: 'OBJECT',
          properties: { project_id: { type: 'STRING' }, jwt_token: { type: 'STRING' } },
          required: ['project_id']
        }
      },
      {
        name: 'get_assigned_modules',
        description: 'Retrieve licensed modules assigned for current context.',
        parameters: { type: 'OBJECT', properties: { jwt_token: { type: 'STRING' } } }
      },
      {
        name: 'get_developer_users',
        description: 'Retrieve list of employees & users for a developer account.',
        parameters: {
          type: 'OBJECT',
          properties: { parent_developer_id: { type: 'STRING' }, jwt_token: { type: 'STRING' } },
          required: ['parent_developer_id']
        }
      },
      {
        name: 'get_project_users',
        description: 'Retrieve users assigned to a specific project.',
        parameters: {
          type: 'OBJECT',
          properties: { project_id: { type: 'STRING' }, jwt_token: { type: 'STRING' } },
          required: ['project_id']
        }
      },
      {
        name: 'get_project_permissions',
        description: 'Retrieve project permissions, status, attachments & LOD documents with full view URLs.',
        parameters: {
          type: 'OBJECT',
          properties: { project_id: { type: 'STRING' }, jwt_token: { type: 'STRING' } },
          required: ['project_id']
        }
      },
      {
        name: 'view_permission_document',
        description: 'Retrieve view URL reference or metadata for drawing/document files.',
        parameters: {
          type: 'OBJECT',
          properties: {
            project_id: { type: 'STRING' },
            trans_project_per_id: { type: 'STRING' },
            file_id: { type: 'STRING' },
            jwt_token: { type: 'STRING' }
          },
          required: ['project_id', 'trans_project_per_id', 'file_id']
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

  public async executeTool(name: string, args: Record<string, any> = {}): Promise<any> {
    const finalArgs = { ...args };
    if (this.jwtToken) {
      if (!finalArgs.jwt_token) finalArgs.jwt_token = this.jwtToken;
      if (!finalArgs.token) finalArgs.token = this.jwtToken;
    }

    console.log(`⚡ Executing MCP Tool [${name}] with args:`, finalArgs);

    if (this.isConnected && this.client) {
      try {
        const result = await this.client.callTool({
          name,
          arguments: finalArgs
        });
        return result;
      } catch (err: any) {
        console.error(`❌ Remote MCP execution error for ${name}:`, err);
        return { error: err.message || 'Remote tool execution failed' };
      }
    }

    // Local simulated fallback responses (for offline sandbox testing)
    switch (name) {
      case 'get_user_profile':
        return {
          success: true,
          message: "Profile context metrics fetched successfully",
          data: {
            id: "425",
            name: "Amaan Ansari",
            mobile_no: "9136206454",
            email: "amaan@stallion.build",
            role: "developer",
            projects: [
              { id: "238", name: "Anmol" },
              { id: "223", name: "Infinity Castle" },
              { id: "228", name: "Empire States" },
              { id: "229", name: "Stallion" },
              { id: "236", name: "Stark power" }
            ]
          }
        };

      case 'get_project_permissions':
        return {
          status: 'success',
          project_id: finalArgs.project_id || '238',
          total_permissions: 2,
          permissions: [
            {
              id: '1038',
              name: 'Last Approved Plan',
              status: 'Issued',
              view_url: `https://api.dev.batman.co.in/permissions/projects/${finalArgs.project_id || '238'}/1038/documents/946/view`
            }
          ]
        };

      default:
        return { status: 'success', message: `Executed tool ${name}`, args: finalArgs };
    }
  }

  /**
   * Single Initial Tool Call on Landing Wake-Up: Executes strictly `get_user_profile`
   */
  public async loadUserProfileContext(token: string): Promise<{ profile: any; projects: ProjectInfo[] }> {
    await this.setJwtToken(token);
    console.log('👤 Executing single initial tool call: get_user_profile...');

    try {
      const result = await this.executeTool('get_user_profile', { jwt_token: token, token });
      console.log('👤 Raw get_user_profile MCP response:', JSON.stringify(result, null, 2));

      const extractedProjects: ProjectInfo[] = [];
      let profileObj: any = null;

      // Extract JSON content from MCP result
      if (result && result.content && Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === 'text' && typeof item.text === 'string') {
            try {
              profileObj = JSON.parse(item.text);
            } catch (jsonErr) {}
          }
        }
      }

      if (!profileObj && result && typeof result === 'object') {
        profileObj = result;
      }

      const dataContainer = profileObj?.data || profileObj?.result || profileObj?.user || profileObj;

      let rawProjects: any[] = [];
      if (Array.isArray(dataContainer?.projects)) {
        rawProjects = dataContainer.projects;
      } else if (Array.isArray(profileObj?.projects)) {
        rawProjects = profileObj.projects;
      } else if (Array.isArray(profileObj?.assigned_projects)) {
        rawProjects = profileObj.assigned_projects;
      } else if (Array.isArray(dataContainer?.assigned_projects)) {
        rawProjects = dataContainer.assigned_projects;
      }

      for (const p of rawProjects) {
        if (!p) continue;
        const name = String(p.name || p.project_name || p.title || p.label || '').trim();
        if (!name) continue;
        const id = String(p.id || p.project_id || extractedProjects.length + 1);

        if (!extractedProjects.some(existing => existing.id === id)) {
          extractedProjects.push({
            id,
            name: name,
            detail: `ID: ${id} / ACTIVE`,
            hot: true
          });
        }
      }

      console.log(`🌟 User profile loaded successfully. Extracted ${extractedProjects.length} dynamic projects:`, extractedProjects.map(p => p.name).join(', '));
      return { profile: profileObj, projects: extractedProjects };
    } catch (err) {
      console.error('❌ Error executing get_user_profile tool:', err);
      return {
        profile: null,
        projects: []
      };
    }
  }
}

