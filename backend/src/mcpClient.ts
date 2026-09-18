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
        description: 'Fetch all active projects associated with the user account.',
        parameters: { type: 'OBJECT', properties: {} },
        nodeModule: 'sharda project'
      },
      {
        name: 'get_project_permissions',
        description: 'Get access permissions and user role for a project.',
        parameters: {
          type: 'OBJECT',
          properties: {
            project_id: { type: 'STRING', description: 'ID of the project' }
          },
          required: ['project_id']
        },
        nodeModule: 'sharda project'
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
        },
        nodeModule: 'sharda project'
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
            { id: '195', name: 'Stallion Alpha', description: 'Infrastructure Cluster', status: 'ACTIVE' }
          ]
        };

      case 'get_project_permissions':
        return {
          status: 'success',
          project_id: args.project_id || '194',
          project_name: 'Sharda Project',
          role: 'Admin / Owner',
          permissions: ['READ_RECORDS', 'WRITE_DATA', 'DEPLOY_SERVICES', 'MANAGE_ACCESS'],
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

      const processRawProject = (p: any) => {
        if (!p) return;
        const name = String(p.name || p.project_name || p.title || p.label || (p.id ? `Project ${p.id}` : '')).trim();
        if (!name) return;

        // Skip non-project generic system terms if any
        const lower = name.toLowerCase();
        if (lower === 'vector store' || lower === 'database cluster' || lower === 'system' || lower === 'null') return;

        const id = String(p.id || p.project_id || p.key || extractedProjects.length + 1);
        extractedProjects.push({
          id,
          name: name.toUpperCase(),
          detail: `ID: ${id} / ${p.status || 'ACTIVE'}`,
          hot: Boolean(p.status === 'ACTIVE' || lower.includes('sharda'))
        });
      };

      // 1. If result has MCP content array
      if (result && result.content && Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === 'text' && typeof item.text === 'string') {
            try {
              const parsed = JSON.parse(item.text);
              const list = Array.isArray(parsed) ? parsed : (parsed.projects || parsed.data || parsed.rows || parsed.result || []);
              if (Array.isArray(list)) {
                list.forEach(processRawProject);
              } else if (typeof list === 'object') {
                processRawProject(list);
              }
            } catch (jsonErr) {
              // Parse plain-text lines with project identifiers
              const lines = item.text.split('\n');
              for (const line of lines) {
                const match = line.match(/(?:^|\d+[\.\)]\s*|\-\s*)([A-Za-z0-9_\- ]{3,})/);
                if (match && match[1]) {
                  processRawProject({ name: match[1].trim() });
                }
              }
            }
          }
        }
      }

      // 2. If result has direct projects array or data
      if (result && Array.isArray(result.projects)) {
        result.projects.forEach(processRawProject);
      } else if (result && Array.isArray(result.data)) {
        result.data.forEach(processRawProject);
      } else if (Array.isArray(result)) {
        result.forEach(processRawProject);
      }

      if (extractedProjects.length > 0) {
        console.log(`📦 Extracted exactly ${extractedProjects.length} dynamic user projects.`);
        return extractedProjects;
      }
    } catch (err) {
      console.warn('Could not fetch projects from remote MCP tool:', err);
    }

    // Default fallback strictly containing ONLY user projects
    return [
      { id: '194', name: 'SHARDA PROJECT', detail: 'ID: 194 / ACTIVE', hot: true },
      { id: '195', name: 'STALLION ALPHA', detail: 'ID: 195 / ACTIVE', hot: true }
    ];
  }

  private mapToolToNode(toolName: string): string {
    const lower = toolName.toLowerCase();
    if (lower.includes('sharda')) return 'sharda project';
    if (lower.includes('project')) return 'sharda project';
    if (lower.includes('permission')) return 'sharda project';
    return 'sharda project';
  }
}
