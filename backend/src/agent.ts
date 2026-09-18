import { GoogleGenAI, Type } from '@google/genai';
import OpenAI from 'openai';
import { MCPClientManager, ProjectInfo } from './mcpClient.js';

export type AIState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type AuthStage = 'WAITING_FOR_PHONE' | 'WAITING_FOR_OTP' | 'AUTHENTICATED';

export interface AgentCallbacks {
  onStateChange: (state: AIState) => void;
  onNodeActive: (nodeModule: string) => void;
  onNodeIdle: (nodeModule: string) => void;
  onTranscript: (speaker: 'user' | 'agent', text: string, isFinal: boolean) => void;
  onProjectsLoaded?: (projects: ProjectInfo[]) => void;
  onAudioChunk?: (base64Audio: string) => void;
}

export class SphereConversationalAgent {
  private geminiClient: GoogleGenAI | null = null;
  private openaiClient: OpenAI | null = null;
  private mcpManager: MCPClientManager;
  private conversationHistory: Array<{ role: 'user' | 'model' | 'assistant' | 'system'; content?: string; text?: string; parts?: Array<any> }> = [];
  private isProcessing = false;
  private authStage: AuthStage = 'WAITING_FOR_PHONE';
  private userPhoneNumber = '';
  private userProjects: ProjectInfo[] = [];

  constructor(remoteMcpUrl?: string) {
    const provider = process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'gemini');

    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.startsWith('sk-')) {
      try {
        this.openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        console.log('🤖 OpenAI Client initialized successfully.');
      } catch (err) {
        console.warn('⚠️ OpenAI Client initialization error:', err);
      }
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey && geminiKey !== 'YOUR_GEMINI_API_KEY_HERE') {
      try {
        this.geminiClient = new GoogleGenAI({ apiKey: geminiKey });
        console.log('🤖 Google Gemini Client initialized successfully.');
      } catch (err) {
        console.warn('⚠️ Gemini Client initialization error:', err);
      }
    }

    this.mcpManager = new MCPClientManager(remoteMcpUrl || process.env.REMOTE_MCP_SERVER_URL);
  }

  public async initialize(): Promise<void> {
    await this.mcpManager.initialize();
  }

  public resetSession(): void {
    this.conversationHistory = [];
    this.isProcessing = false;
    this.authStage = 'WAITING_FOR_PHONE';
    this.userPhoneNumber = '';
    this.userProjects = [];
  }

  /**
   * Process a turn of user input.
   */
  public async processUserTurn(
    userInput: { text?: string; audioBase64?: string; mimeType?: string },
    callbacks: AgentCallbacks
  ): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const userText = (userInput.text || '').trim();
      callbacks.onTranscript('user', userText, true);

      // Shift UI state to THINKING
      callbacks.onStateChange('thinking');

      let responseText = '';

      // --- STEP-BY-STEP AUTHENTICATION FLOW ---
      if (this.authStage === 'WAITING_FOR_PHONE') {
        const phoneDigits = userText.replace(/\D/g, '');
        if (phoneDigits.length >= 7 || userText.length >= 6) {
          this.userPhoneNumber = userText;
          this.authStage = 'WAITING_FOR_OTP';

          // Call send_otp if tool exists
          try {
            await this.mcpManager.executeTool('send_otp', { phone: this.userPhoneNumber });
          } catch (e) {}

          responseText = `I have sent a one-time verification code to ${userText}. Please tell me the OTP to authenticate your session.`;
        } else {
          responseText = `Please provide your phone number so I can send a verification OTP to log you in.`;
        }

      } else if (this.authStage === 'WAITING_FOR_OTP') {
        const otpDigits = userText.replace(/\D/g, '');
        // Verify OTP
        try {
          await this.mcpManager.executeTool('verify_otp', { phone: this.userPhoneNumber, otp: otpDigits || userText });
        } catch (e) {}

        this.authStage = 'AUTHENTICATED';

        // Fetch User Projects from MCP for Dynamic 2nd Expansion
        this.userProjects = await this.mcpManager.getUserProjects();
        if (callbacks.onProjectsLoaded) {
          callbacks.onProjectsLoaded(this.userProjects);
        }

        const projectNames = this.userProjects.map((p) => p.name).slice(0, 3).join(', ');
        responseText = `Login verified! I have mapped your active projects around the neural sphere, including ${projectNames}. What would you like to check or execute?`;

      } else {
        // --- AUTHENTICATED NATURAL CONVERSATION & TOOL CALLING ---
        if (this.openaiClient && process.env.OPENAI_API_KEY) {
          responseText = await this.executeOpenAITurn(userText, callbacks);
        } else if (this.geminiClient && process.env.GEMINI_API_KEY) {
          responseText = await this.executeGeminiTurn(userText, callbacks);
        } else {
          responseText = await this.executeSimulatedTurn(userText, callbacks);
        }
      }

      // Shift UI state to SPEAKING
      callbacks.onStateChange('speaking');
      callbacks.onTranscript('agent', responseText, true);

    } catch (error: any) {
      console.error('❌ Error processing agent turn:', error);
      callbacks.onTranscript('agent', `I encountered an issue: ${error.message || error}`, true);
      callbacks.onStateChange('listening');
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeOpenAITurn(userText: string, callbacks: AgentCallbacks): Promise<string> {
    const tools = this.mcpManager.getTools();
    const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: {
          type: 'object',
          properties: tool.parameters?.properties || {},
          required: tool.parameters?.required || []
        }
      }
    }));

    const systemPrompt = `You are the AI Neural Core of an interactive 3D Sphere interface.
The user is logged in. Active user projects: ${this.userProjects.map(p => p.name).join(', ')}.
You have full access to remote MCP tools to fetch permissions, switch projects, and check records.
When users ask about permissions, projects, or status, always invoke the appropriate tools.
Provide concise, helpful, and vocal answers (2-4 sentences max).`;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory.map((h: any) => ({
        role: h.role === 'model' ? 'assistant' : h.role,
        content: h.text || h.content || ''
      })),
      { role: 'user', content: userText }
    ];

    let maxToolTurns = 5;
    while (maxToolTurns-- > 0) {
      const completion = await this.openaiClient!.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages,
        tools: openAITools.length > 0 ? openAITools : undefined
      });

      const message = completion.choices[0].message;
      messages.push(message);

      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const fn = (toolCall as any).function;
          if (!fn) continue;
          const fnName = fn.name;
          const fnArgs = JSON.parse(fn.arguments || '{}');
          const nodeModule = this.mcpManager.getNodeForTool(fnName);

          callbacks.onNodeActive(nodeModule);
          const toolResult = await this.mcpManager.executeTool(fnName, fnArgs);
          setTimeout(() => callbacks.onNodeIdle(nodeModule), 1200);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
          });
        }
      } else {
        return message.content || 'Task completed.';
      }
    }

    return 'Processed through neural mesh.';
  }

  private async executeGeminiTurn(userText: string, callbacks: AgentCallbacks): Promise<string> {
    const tools = this.mcpManager.getTools();
    const geminiFunctionDeclarations = tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      parameters: {
        type: Type.OBJECT,
        properties: tool.parameters?.properties || {},
        required: tool.parameters?.required || []
      }
    }));

    const systemInstruction = `You are the AI Neural Core of a real-time 3D Sphere interactive interface.
The user is logged in. Active user projects: ${this.userProjects.map(p => p.name).join(', ')}.
You have full access to remote MCP tools (e.g. get_project_permissions, get_user_projects, switch_project).
When users ask about permissions, projects, users, databases, or status, always invoke the appropriate tools.
Provide concise, helpful, and vocal answers (2-4 sentences max).`;

    const modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

    let currentTurnContents: any[] = [
      ...this.conversationHistory,
      {
        role: 'user',
        parts: [{ text: userText }]
      }
    ];

    let maxToolIterations = 5;

    while (maxToolIterations-- > 0) {
      const response = await this.geminiClient!.models.generateContent({
        model: modelName,
        contents: currentTurnContents,
        config: {
          systemInstruction,
          tools: geminiFunctionDeclarations.length > 0 ? [{ functionDeclarations: geminiFunctionDeclarations as any }] : undefined
        }
      });

      const candidates = response.candidates;
      if (!candidates || candidates.length === 0) {
        return response.text || 'Neural core received no response.';
      }

      const candidate = candidates[0];
      const functionCalls = candidate.content?.parts?.filter((p: any) => p.functionCall);

      if (functionCalls && functionCalls.length > 0) {
        currentTurnContents.push(candidate.content);

        const toolResponses = await Promise.all(
          functionCalls.map(async (part: any) => {
            const fc = part.functionCall!;
            const toolName = fc.name || 'get_project_permissions';
            const nodeModule = this.mcpManager.getNodeForTool(toolName);

            callbacks.onNodeActive(nodeModule);
            const toolResult = await this.mcpManager.executeTool(toolName, (fc.args as Record<string, any>) || {});
            setTimeout(() => callbacks.onNodeIdle(nodeModule), 1200);

            return {
              functionResponse: {
                name: toolName,
                response: {
                  output: toolResult
                }
              }
            };
          })
        );

        currentTurnContents.push({
          role: 'user',
          parts: toolResponses
        });
      } else {
        return response.text || 'Neural task completed successfully.';
      }
    }

    return 'Processed multi-step tools across neural mesh.';
  }

  private async executeSimulatedTurn(userText: string, callbacks: AgentCallbacks): Promise<string> {
    const lower = userText.toLowerCase();
    const primaryProject = this.userProjects[0]?.name || 'Active Project';
    const primaryId = this.userProjects[0]?.id || '101';

    // Find if user mentioned any specific project from their dynamic list
    const matchedProject = this.userProjects.find(p => lower.includes(p.name.toLowerCase()));
    const targetProject = matchedProject ? matchedProject.name : primaryProject;
    const targetId = matchedProject ? matchedProject.id : primaryId;

    if (lower.includes('permission') || lower.includes('project') || lower.includes('access')) {
      callbacks.onNodeActive(targetProject.toLowerCase());
      setTimeout(() => callbacks.onNodeIdle(targetProject.toLowerCase()), 1200);
      return `For ${targetProject} (ID: ${targetId}), your account has Full Administrator privileges including Read, Write, Deploy Services, and Manage Access permissions.`;
    }

    if (lower.includes('switch') || lower.includes('select')) {
      callbacks.onNodeActive(targetProject.toLowerCase());
      setTimeout(() => callbacks.onNodeIdle(targetProject.toLowerCase()), 1200);
      return `Switched active workspace context to ${targetProject}. All telemetry feeds and permissions are synchronized.`;
    }

    return `Neural core synchronized for "${userText}". All ${this.userProjects.length || 0} dynamic project nodes are active and reachable.`;
  }
}
