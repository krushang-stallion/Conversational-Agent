import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { Readable } from 'stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sanitizePermissionsPayload } from './payloadSanitizer.js';

function getScriptPath(scriptName: string): string {
  const candidates = [
    path.join(process.cwd(), 'scripts', scriptName),
    path.join(process.cwd(), '..', 'scripts', scriptName),
    path.join(__dirname, '..', '..', 'scripts', scriptName),
    path.join(__dirname, '..', 'scripts', scriptName),
    path.join('/app', 'scripts', scriptName)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const SPECIALIZED_PERMISSION_TOOLS: MCPToolDeclaration[] = [
  {
    name: 'inspect_document_attachment',
    description: 'MANDATORY FOR AUDITS: Read and extract municipal conditions, sanction clauses, and NOC requirements directly from an approval PDF (IOD, Amendment letter, CC, NOC) using the pre-signed S3 URL in "ai_view_url" from get_project_permissions (requires ZERO authentication). When performing a permission audit, ALWAYS call this tool on the attached sanction PDF(s) to extract the actual conditions.',
    parameters: {
      type: 'object',
      properties: {
        ai_view_url: { type: 'string', description: 'The direct pre-signed S3 URL from get_project_permissions (ai_view_url parameter, no authentication required).' },
        document_url: { type: 'string', description: 'Alias for ai_view_url or PDF document URL' }
      }
    }
  },
  {
    name: 'draft_permission_followup',
    description: 'Draft a structured human-in-the-loop follow-up reminder for a pending clearance with due timestamp and milestone blocker.',
    parameters: {
      type: 'object',
      properties: {
        permission_name: { type: 'string', description: 'Name of the clearance (e.g. CFO NOC)' },
        assigned_to: { type: 'string', description: 'Name of the responsible person (e.g. Rajesh Sharma)' },
        role: { type: 'string', description: 'Role or designation (e.g. Liaison Architect)' },
        phone: { type: 'string', description: 'Phone number for WhatsApp dispatch' },
        due_time: { type: 'string', description: 'Target due time/date (e.g. 11:45 PM)' },
        blocks_stage: { type: 'string', description: 'Construction milestone blocked (e.g. Further CC)' },
        latest_update: { type: 'string', description: 'Latest progress note' }
      },
      required: ['permission_name', 'assigned_to', 'role']
    }
  }
];

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
export function dedicatedFetch(url: string | URL, init?: any): Promise<Response> {
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

async function extractPdfTextFromUrl(docUrl: string, token?: string): Promise<any> {
  let cleanUrl = (docUrl || '').trim();
  if (!cleanUrl) {
    return { status: 'error', message: 'No document URL provided to inspect.' };
  }

  // Handle relative API path
  if (cleanUrl.startsWith('/')) {
    cleanUrl = `https://api.dev.batman.co.in${cleanUrl}`;
  }

  const lowerUrl = cleanUrl.toLowerCase();
  if (lowerUrl.endsWith('.dwg') || lowerUrl.includes('.dwg?')) {
    return {
      status: 'cad_binary',
      file_type: 'dwg',
      message: 'AutoCAD DWG file. CAD vector files cannot be parsed as plain text. View directly in AutoCAD or Stallion Blueprint Viewer.',
      direct_url: cleanUrl
    };
  }

  try {
    const isS3Url = lowerUrl.includes('amazonaws.com') || lowerUrl.includes('x-amz-');
    const headers: Record<string, string> = {};

    // Pass Authorization ONLY on internal API endpoints, NEVER on public S3 pre-signed URLs
    if (!isS3Url && token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['X-JWT-Token'] = token;
    }

    const resp = await dedicatedFetch(cleanUrl, { headers });
    if (!resp.ok) {
      return { status: 'error', message: `HTTP fetch failed: ${resp.status} ${resp.statusText}`, direct_url: cleanUrl };
    }
    const ab = await resp.arrayBuffer();
    const pdfParseMod = await import('pdf-parse');
    const PDFParse = (pdfParseMod as any).PDFParse || (pdfParseMod as any).default?.PDFParse || (pdfParseMod as any).default;
    const parser = new PDFParse(new Uint8Array(ab));
    await parser.load();
    const parsed = await parser.getText();
    const rawText = parsed.text || '';
    const totalPages = parsed.total || (parsed.pages ? parsed.pages.length : 1);

    if (rawText.trim().length === 0) {
      return {
        status: 'scanned_image_pdf',
        total_pages: totalPages,
        message: 'This PDF consists of scanned image pages without a digital text layer. Visual inspection of the physical scan via the direct link is required.',
        direct_url: cleanUrl
      };
    }

    const truncated = rawText.length > 10000;
    const content = truncated ? rawText.slice(0, 10000) + '\n... [TRUNCATED FOR CONTEXT WINDOW]' : rawText;

    return {
      status: 'success',
      total_pages: totalPages,
      characters_extracted: rawText.length,
      truncated,
      extracted_content: content,
      direct_url: cleanUrl
    };
  } catch (err: any) {
    console.error('Error parsing PDF in extractPdfTextFromUrl:', err);
    return { status: 'error', message: `Failed to extract PDF text: ${err?.message || err}`, direct_url: cleanUrl };
  }
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
              type: 'object',
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
              type: 'object',
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
              type: 'object',
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
        parameters: { type: 'object', properties: { jwt_token: { type: 'string' } } }
      },
      {
        name: 'get_project_details',
        description: 'Retrieve comprehensive specs, location & developer metadata.',
        parameters: {
          type: 'object',
          properties: { project_id: { type: 'string' }, jwt_token: { type: 'string' } },
          required: ['project_id']
        }
      },
      {
        name: 'get_project_towers',
        description: 'Retrieve tower list, floor count & basement metrics.',
        parameters: {
          type: 'object',
          properties: { project_id: { type: 'string' }, jwt_token: { type: 'string' } },
          required: ['project_id']
        }
      },
      {
        name: 'get_assigned_modules',
        description: 'Retrieve licensed modules assigned for current context.',
        parameters: { type: 'object', properties: { jwt_token: { type: 'string' } } }
      },
      {
        name: 'get_developer_users',
        description: 'Retrieve list of employees & users for a developer account.',
        parameters: {
          type: 'object',
          properties: { parent_developer_id: { type: 'string' }, jwt_token: { type: 'string' } },
          required: ['parent_developer_id']
        }
      },
      {
        name: 'get_project_users',
        description: 'Retrieve users assigned to a specific project.',
        parameters: {
          type: 'object',
          properties: { project_id: { type: 'string' }, jwt_token: { type: 'string' } },
          required: ['project_id']
        }
      },
      {
        name: 'get_project_permissions',
        description: 'Retrieve project permissions, status, attachments & LOD documents with full view URLs.',
        parameters: {
          type: 'object',
          properties: { project_id: { type: 'string' }, jwt_token: { type: 'string' } },
          required: ['project_id']
        }
      },
      {
        name: 'view_permission_document',
        description: 'Retrieve view URL reference or metadata for drawing/document files.',
        parameters: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            trans_project_per_id: { type: 'string' },
            file_id: { type: 'string' },
            jwt_token: { type: 'string' }
          },
          required: ['project_id', 'trans_project_per_id', 'file_id']
        }
      }
    ];
  }

  public getTools(): MCPToolDeclaration[] {
    const existingNames = new Set(this.tools.map(t => t.name));
    const merged = [...this.tools];
    for (const tool of SPECIALIZED_PERMISSION_TOOLS) {
      if (!existingNames.has(tool.name)) {
        merged.push(tool);
      }
    }
    return merged;
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

    if (name === 'inspect_document_attachment' || name === 'view_permission_document') {
      let docUrl = String(finalArgs.ai_view_url || finalArgs.document_url || finalArgs.url || '');

      // Auto-resolution fallback: if no direct URL was passed, lookup from project permissions
      if (!docUrl && (finalArgs.permission_name || finalArgs.permission_id || finalArgs.file_id)) {
        try {
          const projectId = finalArgs.project_id || '238';
          const permsResult: any = await this.executeTool('get_project_permissions', { project_id: projectId });
          const permsList = permsResult?.permissions || permsResult?.data?.permissions || (Array.isArray(permsResult) ? permsResult : []);
          
          const targetPerm = permsList.find((p: any) => {
            if (finalArgs.permission_id && String(p.id) === String(finalArgs.permission_id)) return true;
            if (finalArgs.permission_name && p.name && p.name.toLowerCase().includes(String(finalArgs.permission_name).toLowerCase())) return true;
            return false;
          });

          if (targetPerm?.ai_view_url) {
            docUrl = targetPerm.ai_view_url;
          } else if (targetPerm?.documents?.permission_plan?.[0]?.ai_view_url) {
            docUrl = targetPerm.documents.permission_plan[0].ai_view_url;
          }
        } catch (lookupErr) {
          console.warn('⚠️ Could not auto-resolve document URL from permissions:', lookupErr);
        }
      }

      if (docUrl) {
        return extractPdfTextFromUrl(docUrl, this.jwtToken);
      }

      return {
        status: 'no_document',
        message: `No attached approval document or PDF was found for "${finalArgs.permission_name || finalArgs.permission_id || 'the requested permission'}". Please verify if a sanction PDF or clearance file has been uploaded to Stallion for this milestone.`,
        permission_name: finalArgs.permission_name,
        permission_id: finalArgs.permission_id
      };
    }

    if (name === 'draft_permission_followup') {
      const scriptPath = getScriptPath('permission_followup.py');
      const cmdArgs = [
        scriptPath,
        'draft-reminder',
        '--permission', finalArgs.permission_name || 'Clearance',
        '--assigned-to', finalArgs.assigned_to || 'Assigned Person',
        '--role', finalArgs.role || 'Consultant',
        '--phone', finalArgs.phone || '919999999999',
        '--due-time', finalArgs.due_time || 'Immediate',
        '--blocks-stage', finalArgs.blocks_stage || 'Further Construction'
      ];
      if (finalArgs.latest_update) {
        cmdArgs.push('--latest-update', finalArgs.latest_update);
      }
      return new Promise((resolve) => {
        execFile('python3', cmdArgs, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
          if (err) {
            resolve({ error: err.message, status: 'error' });
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve({ output: stdout });
          }
        });
      });
    }

    if (this.isConnected && this.client) {
      try {
        const result = await this.client.callTool({
          name,
          arguments: finalArgs
        });
        if (name === 'get_project_permissions') {
          return sanitizePermissionsPayload(result);
        }
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

