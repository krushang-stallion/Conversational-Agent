import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export interface MCPToolDeclaration {
  name: string;
  description?: string;
  parameters?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  nodeModule: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  detail: string;
  hot?: boolean;
}

export class MCPClientManager {
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private sseUrl: string | undefined;
  private tools: MCPToolDeclaration[] = [];
  private isConnected = false;

  constructor(sseUrl?: string) {
    this.sseUrl = sseUrl;
  }

  public async initialize(): Promise<void> {
    if (this.sseUrl && this.sseUrl.startsWith('http') && !this.sseUrl.includes('your-mcp-server.com')) {
      try {
        console.log(`🔌 Connecting to remote MCP Server at ${this.sseUrl}...`);
        this.transport = new SSEClientTransport(new URL(this.sseUrl));
        this.client = new Client(
          { name: 'sphere-agent-client', version: '1.0.0' },
          { capabilities: {} }
        );

        await this.client.connect(this.transport);
        this.isConnected = true;
        console.log('✅ Connected to remote MCP Server');

        // Discover remote tools
        const remoteTools = await this.client.listTools();
        this.tools = remoteTools.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: {
            type: 'OBJECT',
            properties: t.inputSchema?.properties || {},
            required: (t.inputSchema?.required as string[]) || [],
          },
          nodeModule: this.mapToolToNode(t.name)
        }));
        console.log(`🛠️ Discovered ${this.tools.length} remote MCP tools.`);
        return;
      } catch (err) {
        console.warn('⚠️ Could not connect to remote MCP Server, falling back to local registered tools:', err);
      }
    }

    // Default registered tools
    this.tools = [
      {
        name: 'get_user_projects',
        description: 'Fetch all active projects and workspaces associated with the logged-in user.',
        parameters: { type: 'OBJECT', properties: {} },
        nodeModule: 'sharda project'
      },
      {
        name: 'get_project_permissions',
        description: 'Get detailed role, access permissions, and privileges for a specific project.',
        parameters: {
          type: 'OBJECT',
          properties: {
            project_id: { type: 'STRING', description: 'ID of the project' },
            project_name: { type: 'STRING', description: 'Name of the project' }
          }
        },
        nodeModule: 'sharda project'
      },
      {
        name: 'switch_project',
        description: 'Switch the active workspace session context to a target project.',
        parameters: {
          type: 'OBJECT',
          properties: {
            project_id: { type: 'STRING', description: 'ID of the project to activate' }
          },
          required: ['project_id']
        },
        nodeModule: 'sharda project'
      },
      {
        name: 'get_notifications',
        description: 'Get recent system notifications and audit alerts.',
        parameters: {
          type: 'OBJECT',
          properties: {
            limit: { type: 'NUMBER', description: 'Max items' }
          }
        },
        nodeModule: 'notifications'
      }
    ];
  }

  public getTools(): MCPToolDeclaration[] {
    return this.tools;
  }

  public getNodeForTool(toolName: string): string {
    const tool = this.tools.find((t) => t.name === toolName);
    return tool ? tool.nodeModule : 'sharda project';
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

    // Local fallback data
    switch (name) {
      case 'get_user_projects':
        return {
          status: 'success',
          projects: [
            { id: '194', name: 'Sharda Project', description: 'Enterprise Neural Engine', status: 'ACTIVE' },
            { id: '195', name: 'Alpha Tower', description: 'Infrastructure Cluster', status: 'ACTIVE' },
            { id: '196', name: 'Matrix Mesh', description: 'Distributed Gateway', status: 'READY' },
            { id: '197', name: 'Titan Core', description: 'High Performance Compute', status: 'READY' },
            { id: '198', name: 'Edge Pipeline', description: 'Real-time Streaming Mesh', status: 'ACTIVE' },
            { id: '199', name: 'Identity Gateway', description: 'Security & Auth Mesh', status: 'ACTIVE' }
          ]
        };

      case 'get_project_permissions':
        return {
          status: 'success',
          project_id: args.project_id || '194',
          project_name: 'Sharda Project',
          role: 'Admin / Owner',
          permissions: ['READ_RECORDS', 'WRITE_DATA', 'DEPLOY_SERVICES', 'MANAGE_ACCESS', 'AUDIT_LOGS'],
          accessLevel: 'FULL_PRIVILEGE'
        };

      case 'switch_project':
        return {
          status: 'success',
          activeProjectId: args.project_id || '194',
          message: `Switched active context to project ${args.project_id || '194'}.`
        };

      default:
        return { status: 'success', message: `Executed tool ${name}`, args };
    }
  }

  public async getUserProjects(): Promise<ProjectInfo[]> {
    try {
      const result = await this.executeTool('get_user_projects', {});
      const extractedProjects: ProjectInfo[] = [];

      // Parse structured formats returned from MCP
      if (result && result.content && Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === 'text') {
            try {
              const parsed = JSON.parse(item.text);
              const list = Array.isArray(parsed) ? parsed : parsed.projects || parsed.data || [];
              list.forEach((p: any) => {
                extractedProjects.push({
                  id: String(p.id || p.project_id || Math.floor(Math.random() * 900 + 100)),
                  name: String(p.name || p.project_name || p.title || 'Project ' + p.id).toUpperCase(),
                  detail: `ID: ${p.id || '194'} / ${p.status || 'ACTIVE'}`,
                  hot: Boolean(p.status === 'ACTIVE' || String(p.name).toLowerCase().includes('sharda'))
                });
              });
            } catch (e) {}
          }
        }
      } else if (result && result.projects && Array.isArray(result.projects)) {
        result.projects.forEach((p: any) => {
          extractedProjects.push({
            id: String(p.id || '194'),
            name: String(p.name || 'Project').toUpperCase(),
            detail: `ID: ${p.id} / ${p.status || 'ACTIVE'}`,
            hot: Boolean(p.status === 'ACTIVE' || String(p.name).toLowerCase().includes('sharda'))
          });
        });
      }

      if (extractedProjects.length > 0) {
        return extractedProjects;
      }
    } catch (err) {
      console.warn('Could not fetch projects from MCP tool, using default project schema:', err);
    }

    // Default project node set
    return [
      { id: '194', name: 'SHARDA PROJECT', detail: 'ID: 194 / ACTIVE', hot: true },
      { id: '195', name: 'ALPHA TOWER', detail: 'ID: 195 / ACTIVE', hot: true },
      { id: '196', name: 'MATRIX MESH', detail: 'ID: 196 / READY' },
      { id: '197', name: 'TITAN CORE', detail: 'ID: 197 / READY' },
      { id: '198', name: 'EDGE PIPELINE', detail: 'ID: 198 / STREAM', hot: true },
      { id: '199', name: 'IDENTITY GATEWAY', detail: 'ID: 199 / TLS' },
      { id: '200', name: 'DATABASE CLUSTER', detail: 'ID: 200 / POSTGRES' },
      { id: '201', name: 'VECTOR STORE', detail: 'ID: 201 / EMBEDDINGS', hot: true }
    ];
  }

  private mapToolToNode(toolName: string): string {
    const lower = toolName.toLowerCase();
    if (lower.includes('sharda')) return 'sharda project';
    if (lower.includes('project')) return 'sharda project';
    if (lower.includes('permission')) return 'sharda project';
    if (lower.includes('notification')) return 'notifications';
    if (lower.includes('user')) return 'identity gateway';
    return 'sharda project';
  }
}
