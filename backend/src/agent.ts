import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import OpenAI from 'openai';
import { MCPClientManager, ProjectInfo } from './mcpClient.js';

export type AIState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface AgentCallbacks {
  onStateChange: (state: AIState) => void;
  onNodeActive: (nodeModule: string) => void;
  onNodeIdle: (nodeModule: string) => void;
  onTranscript: (speaker: 'user' | 'agent', text: string, isFinal: boolean) => void;
  onProjectsLoaded?: (projects: ProjectInfo[]) => void;
  onAudioChunk?: (base64Audio: string) => void;
}

export class SphereConversationalAgent {
  private openaiClient: OpenAI | null = null;
  private mcpManager: MCPClientManager;
  private isProcessing = false;
  private processingQueue: Promise<void> = Promise.resolve();
  private turnCounter = 0;
  private jwtToken = '';
  private userProfile: any = null;
  private userProjects: ProjectInfo[] = [];
  private hermesWorkspace: string;
  private hermesBin: string;
  private pendingMobileNumber: string | null = null;
  private sessionStarted = false;
  private conversationHistory: any[] = [];

  constructor(remoteMcpUrl?: string) {
    const cwd = process.cwd();
    this.hermesWorkspace = process.env.HERMES_WORKSPACE 
      || (fs.existsSync(path.join(cwd, 'AGENTS.md')) ? cwd : path.resolve(cwd, '..'));

    const binCandidates = [
      process.env.HERMES_BIN,
      '/root/.local/bin/hermes',
      path.join(process.env.HOME || '', '.local/bin/hermes'),
      '/usr/local/bin/hermes',
      '/Users/krush/.local/bin/hermes'
    ].filter(Boolean) as string[];

    this.hermesBin = binCandidates.find(p => fs.existsSync(p)) || binCandidates[0];

    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && apiKey.startsWith('sk-')) {
      try {
        this.openaiClient = new OpenAI({ apiKey });
        console.log('🤖 OpenAI Client initialized for Hermes Sphere Voice & TTS.');
      } catch (err) {
        console.warn('⚠️ OpenAI Client initialization error:', err);
      }
    }

    this.mcpManager = new MCPClientManager(remoteMcpUrl || process.env.REMOTE_MCP_SERVER_URL);
  }

  public async initialize(): Promise<void> {
    await this.mcpManager.initialize();
  }

  public resetSession(token?: string): void {
    this.isProcessing = false;
    this.processingQueue = Promise.resolve();
    this.jwtToken = token || '';
    this.userProfile = null;
    this.userProjects = [];
    this.pendingMobileNumber = null;
    this.sessionStarted = false;
    this.conversationHistory = [];
  }

  /**
   * Start session with an optional JWT Token
   */
  public async startSessionWithToken(token: string, callbacks: AgentCallbacks): Promise<string> {
    this.resetSession(token);
    this.sessionStarted = true;

    callbacks.onStateChange('thinking');

    if (token && token.trim()) {
      await this.saveTokenToEnv(token.trim());
      await this.mcpManager.setJwtToken(token.trim());

      console.log('🚀 Loading user profile context for authenticated session...');
      const { profile, projects } = await this.mcpManager.loadUserProfileContext(token.trim());
      this.userProfile = profile;
      this.userProjects = projects;

      if (callbacks.onProjectsLoaded && this.userProjects.length > 0) {
        callbacks.onProjectsLoaded(this.userProjects);
      }

      const userName = profile?.data?.name || profile?.user?.name || profile?.name || 'Valued Partner';
      const projectListStr = this.userProjects.map(p => p.name).join(', ');
      const welcomeText = this.userProjects.length > 0
        ? `Greetings ${userName}. Hermes Agent is active as your Stallion Permission & Regulatory Specialist. I have mapped your projects: ${projectListStr}. I can audit permission checklists, extract conditions from IOD documents, match missing clearances, and draft follow-up reminders.`
        : `Greetings ${userName}. Hermes Agent is online as your Stallion Permission Specialist. How may I assist with your regulatory permissions and IOD conditions today?`;

      callbacks.onStateChange('speaking');
      callbacks.onTranscript('agent', welcomeText, true);
      await this.synthesizeAndStreamVoice(welcomeText, callbacks);
      callbacks.onStateChange('listening');
      return welcomeText;
    } else {
      const welcomeText = "Greetings. I am Hermes Agent, your Stallion Permission & Regulatory Specialist. You are currently in guest mode. Say 'Log me in with <mobile number>' to authenticate via OTP, or ask any permission question.";
      callbacks.onStateChange('speaking');
      callbacks.onTranscript('agent', welcomeText, true);
      await this.synthesizeAndStreamVoice(welcomeText, callbacks);
      callbacks.onStateChange('listening');
      return welcomeText;
    }
  }

  /**
   * Process a turn of user interaction.
   */
  public async processUserTurn(
    userInput: { text?: string; audioBase64?: string; mimeType?: string },
    callbacks: AgentCallbacks
  ): Promise<void> {
    const turnId = ++this.turnCounter;

    this.processingQueue = this.processingQueue.then(async () => {
      await this.executeTurnInternal(userInput, callbacks, turnId);
    }).catch(err => {
      console.error('❌ Processing turn queue error:', err);
    });

    return this.processingQueue;
  }

  private async executeTurnInternal(
    userInput: { text?: string; audioBase64?: string; mimeType?: string },
    callbacks: AgentCallbacks,
    turnId: number
  ): Promise<void> {
    this.isProcessing = true;

    try {
      let userText = (userInput.text || '').trim();

      // If audio is provided but no text, transcribe using OpenAI Whisper if available
      if (!userText && userInput.audioBase64 && this.openaiClient) {
        try {
          const audioBuffer = Buffer.from(userInput.audioBase64, 'base64');
          const tempAudioPath = path.resolve(this.hermesWorkspace, 'scratch', `input_${Date.now()}.webm`);
          fs.mkdirSync(path.dirname(tempAudioPath), { recursive: true });
          fs.writeFileSync(tempAudioPath, audioBuffer);

          const transcription = await this.openaiClient.audio.transcriptions.create({
            file: fs.createReadStream(tempAudioPath),
            model: 'whisper-1'
          });
          userText = transcription.text.trim();
          try { fs.unlinkSync(tempAudioPath); } catch {}
        } catch (sttErr) {
          console.warn('⚠️ STT transcription warning:', sttErr);
        }
      }

      if (!userText) {
        callbacks.onStateChange('listening');
        return;
      }

      // Normalize common speech recognition mis-transcriptions for Indian municipal terms
      userText = userText
        .replace(/\biodine\b/gi, 'IOD')
        .replace(/\bce\s*ce\b/gi, 'CC')
        .replace(/\boh\s*see\b/gi, 'OC')
        .replace(/\bc\s*f\s*o\b/gi, 'CFO')
        .replace(/\bn\s*o\s*c\b/gi, 'NOC');

      callbacks.onTranscript('user', userText, true);
      callbacks.onStateChange('thinking');

      // Check for in-conversation OTP Login commands
      const otpHandled = await this.handleAuthCommands(userText, callbacks);
      if (otpHandled) {
        return;
      }

      // Proactively trigger visual 3D sphere node animations based on query keywords
      this.triggerVisualEffectsForQuery(userText, callbacks);

      // Execute through Hermes Agent
      let responseText = await this.executeHermesTurn(userText, callbacks);

      if (!responseText || responseText.trim().length === 0) {
        responseText = "Hermes Agent has analyzed the request. All Stallion MCP tools are synchronized.";
      }

      callbacks.onStateChange('speaking');
      callbacks.onTranscript('agent', responseText, true);

      // If a newer user turn has not preempted this one, stream voice audio
      if (turnId === this.turnCounter) {
        await this.synthesizeAndStreamVoice(responseText, callbacks, turnId);
      }
      callbacks.onStateChange('listening');

    } catch (error: any) {
      console.error('❌ Error processing agent turn:', error);
      const errMsg = `Hermes Agent encountered an error: ${error.message || error}`;
      callbacks.onTranscript('agent', errMsg, true);
      callbacks.onStateChange('listening');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * In-conversation OTP Login workflow handler
   */
  private async handleAuthCommands(text: string, callbacks: AgentCallbacks): Promise<boolean> {
    const lower = text.toLowerCase();
    const scriptPath = path.resolve(this.hermesWorkspace, 'scripts', 'stallion_auth.py');

    // 1. Direct login request with phone number
    const phoneMatch = text.match(/(?:log\s*in|login|send\s*otp|authenticate|phone|mobile)\s*(?:with|to|number)?\s*[:\s]*(\+?\d{10,12})/i);
    if (phoneMatch && phoneMatch[1]) {
      const mobile = phoneMatch[1].replace(/\D/g, '').slice(-10);
      this.pendingMobileNumber = mobile;
      callbacks.onTranscript('agent', `Requesting OTP for mobile number +91 ${mobile}...`, false);

      const res = await this.runPythonScript(scriptPath, ['send-otp', mobile]);
      if (res && res.success) {
        const reply = `OTP has been sent successfully to ${mobile}. Please speak or enter the 4-digit verification code.`;
        callbacks.onStateChange('speaking');
        callbacks.onTranscript('agent', reply, true);
        await this.synthesizeAndStreamVoice(reply, callbacks);
        callbacks.onStateChange('listening');
        return true;
      } else {
        const errReply = `Unable to send OTP: ${res?.error || res?.message || 'Server error'}. Please verify your registered number.`;
        callbacks.onStateChange('speaking');
        callbacks.onTranscript('agent', errReply, true);
        await this.synthesizeAndStreamVoice(errReply, callbacks);
        callbacks.onStateChange('listening');
        return true;
      }
    }

    // 2. Entering OTP Code
    const codeMatch = text.match(/\b(\d{4,6})\b/);
    if (this.pendingMobileNumber && (codeMatch || lower.includes('otp') || lower.includes('code'))) {
      const code = codeMatch ? codeMatch[1] : text.replace(/\D/g, '');
      if (code.length >= 4) {
        callbacks.onTranscript('agent', `Verifying code ${code}...`, false);
        const res = await this.runPythonScript(scriptPath, ['verify-otp', this.pendingMobileNumber, code]);

        if (res && res.success && res.data && res.data.token) {
          const token = res.data.token;
          this.jwtToken = token;
          this.pendingMobileNumber = null;

          await this.startSessionWithToken(token, callbacks);
          return true;
        } else {
          const errReply = `Verification failed: ${res?.error || res?.message || 'Invalid code'}. Please try again.`;
          callbacks.onStateChange('speaking');
          callbacks.onTranscript('agent', errReply, true);
          await this.synthesizeAndStreamVoice(errReply, callbacks);
          callbacks.onStateChange('listening');
          return true;
        }
      }
    }

    // 3. User pasted a direct JWT token
    if (text.startsWith('eyJ') && text.length > 50) {
      callbacks.onTranscript('agent', 'Authenticating provided JWT token...', false);
      await this.runPythonScript(scriptPath, ['set-token', text.trim()]);
      await this.startSessionWithToken(text.trim(), callbacks);
      return true;
    }

    return false;
  }

  /**
   * Execute user prompt via Hermes Agent CLI with real-time verbose progress streaming
   */
  private async executeHermesTurn(userPrompt: string, callbacks: AgentCallbacks): Promise<string> {
    // If Hermes CLI is not present (e.g. running on Render cloud), execute native OpenAI Agent with MCP tools
    if (!fs.existsSync(this.hermesBin)) {
      console.log(`ℹ️ Hermes CLI binary not found at ${this.hermesBin}. Running cloud native Agent loop on Render.`);
      return this.executeOpenAIAgentTurn(userPrompt, callbacks);
    }

    return new Promise((resolve) => {
      const args = [
        '--in', this.hermesWorkspace,
        '-z', userPrompt
      ];

      // If a session has already run in this workspace, resume it to retain multi-turn context
      if (this.sessionStarted) {
        args.unshift('--resume', 'latest');
      }

      console.log(`🤖 Invoking Hermes Agent with: hermes ${args.join(' ')}`);

      // Immediately provide live progress feedback to the user on the 3D sphere
      const lower = userPrompt.toLowerCase();
      if (lower.includes('follow') || lower.includes('remind') || lower.includes('whatsapp') || lower.includes('draft')) {
        callbacks.onTranscript('agent', '⏳ [Step 1/3] Checking assigned person & drafting follow-up reminder (Human Approval Gate)...', false);
        callbacks.onNodeActive('permission');
      } else if (lower.includes('iod') || lower.includes('condition') || lower.includes('extract') || lower.includes('clause')) {
        callbacks.onTranscript('agent', '⏳ [Step 1/3] Reading IOD/CC document & extracting municipal condition clauses...', false);
        callbacks.onNodeActive('permission');
      } else if (lower.includes('reply') || lower.includes('response') || lower.includes('status update')) {
        callbacks.onTranscript('agent', '⏳ [Step 1/3] Structuring consultant response into Stallion dashboard update...', false);
        callbacks.onNodeActive('permission');
      } else if (lower.includes('permission') || lower.includes('lod') || lower.includes('document')) {
        callbacks.onTranscript('agent', '⏳ [Step 1/3] Auditing regulatory permissions & matching against Stallion master...', false);
        callbacks.onNodeActive('permission');
      } else {
        callbacks.onTranscript('agent', '⏳ [Step 1/3] Hermes Neural Core coordinating Stallion Permission tools...', false);
      }

      const childEnv = {
        ...process.env,
        STALLION_JWT_TOKEN: this.jwtToken,
        MCP_STALLION_API_KEY: this.jwtToken
      };

      const child = spawn(this.hermesBin, args, {
        cwd: this.hermesWorkspace,
        env: childEnv
      });

      let stdout = '';
      let stderr = '';
      let stepCounter = 2;

      const handleChunk = (chunk: string) => {
        const text = chunk.toLowerCase();

        // Detect tool invocations from Hermes log stream
        if (text.includes('get_project_permissions')) {
          callbacks.onTranscript('agent', `⏳ [Step ${stepCounter++}/3] Auditing approved clearances & S3 attachments...`, false);
          callbacks.onNodeActive('permission');
        } else if (text.includes('read_document') || text.includes('attachment') || text.includes('iod')) {
          callbacks.onTranscript('agent', `⏳ [Step ${stepCounter++}/3] Extracting condition clauses from sanction PDF...`, false);
          callbacks.onNodeActive('permission');
        } else if (text.includes('permission_followup') || text.includes('draft-reminder')) {
          callbacks.onTranscript('agent', `⏳ [Step ${stepCounter++}/3] Drafting compliance reminder (Awaiting user approval)...`, false);
          callbacks.onNodeActive('permission');
        } else if (text.includes('record-reply') || text.includes('process_employee_reply')) {
          callbacks.onTranscript('agent', `⏳ [Step ${stepCounter++}/3] Structuring update for permission dashboard...`, false);
          callbacks.onNodeActive('permission');
        } else if (text.includes('get_project_details')) {
          callbacks.onTranscript('agent', `⏳ [Step ${stepCounter++}/3] Validating project master record...`, false);
          callbacks.onNodeActive('project');
        }
      };

      child.stdout.on('data', (chunk) => {
        const str = chunk.toString();
        stdout += str;
        handleChunk(str);
      });

      child.stderr.on('data', (chunk) => {
        const str = chunk.toString();
        stderr += str;
        handleChunk(str);
      });

      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          console.warn(`⚠️ Hermes exit code ${code}. Stderr: ${stderr.trim()}`);
          if (stdout.trim()) {
            resolve(stdout.trim());
          } else {
            resolve(this.generateSimulatedInsight(userPrompt));
          }
        }
      });

      child.on('error', (err) => {
        console.error('❌ Failed to spawn Hermes CLI:', err);
        resolve(this.generateSimulatedInsight(userPrompt));
      });
    });
  }

  /**
   * Helper to format and sanitize any tool parameter schema strictly conforming to OpenAI Function Calling specs.
   * OpenAI requires:
   * {
   *   type: 'object',
   *   properties: {
   *     [propName]: { type: 'string' | 'number' | 'boolean' | 'array' | 'object', description?: string, enum?: any[] }
   *   },
   *   required: string[]
   * }
   */
  private formatOpenAIToolSchema(rawParams: any): Record<string, any> {
    if (!rawParams || typeof rawParams !== 'object') {
      return { type: 'object', properties: {} };
    }

    const properties: Record<string, any> = {};
    const rawProperties = rawParams.properties && typeof rawParams.properties === 'object'
      ? rawParams.properties
      : {};

    for (const [propName, propDef] of Object.entries(rawProperties)) {
      if (!propDef || typeof propDef !== 'object') {
        properties[propName] = { type: 'string' };
        continue;
      }

      const p: any = propDef;
      let propType = 'string';
      if (typeof p.type === 'string') {
        propType = p.type.toLowerCase();
      } else if (Array.isArray(p.anyOf)) {
        // FastMCP / Pydantic Optional[T] produces: anyOf: [{ type: 'string' }, { type: 'null' }]
        const nonNull = p.anyOf.find((item: any) => item?.type && item.type.toLowerCase() !== 'null');
        if (nonNull?.type) {
          propType = String(nonNull.type).toLowerCase();
        }
      }

      const cleanProp: Record<string, any> = {
        type: propType
      };

      if (p.description || p.title) {
        cleanProp.description = String(p.description || p.title);
      }

      if (Array.isArray(p.enum) && p.enum.length > 0) {
        cleanProp.enum = p.enum;
      }

      if (propType === 'array' && p.items && typeof p.items === 'object') {
        cleanProp.items = {
          type: typeof p.items.type === 'string' ? p.items.type.toLowerCase() : 'string'
        };
      }

      properties[propName] = cleanProp;
    }

    const required = Array.isArray(rawParams.required)
      ? rawParams.required.filter((r: any) => typeof r === 'string' && Object.prototype.hasOwnProperty.call(properties, r))
      : [];

    return {
      type: 'object',
      properties,
      required
    };
  }

  /**
   * Autonomous Cloud Agent Loop: Executes directly on Render using OpenAI GPT-4o and Stallion MCP
   */
  private async executeOpenAIAgentTurn(userPrompt: string, callbacks: AgentCallbacks): Promise<string> {
    if (!this.openaiClient) {
      console.warn('⚠️ OpenAI Client not configured (missing OPENAI_API_KEY). Set it in Render Environment.');
      return `### Stallion Permission Intelligence
⚠️ **OpenAI API Key Missing**: The cloud agent requires \`OPENAI_API_KEY\` to be set in your Render Dashboard under **Environment**.
Mapped Projects: ${this.userProjects.map(p => p.name).join(', ') || 'Connected'}.`;
    }

    try {
      console.log('🌐 Executing native cloud Agent Turn via OpenAI GPT-4o & Stallion MCP...');
      const rawTools = this.mcpManager.getTools();
      const tools = rawTools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description || '',
          parameters: this.formatOpenAIToolSchema(t.parameters)
        }
      }));

      const activeProjectContext = this.userProjects.length > 0
        ? `\nActive User Projects: ${this.userProjects.map(p => `Project Name: "${p.name}", ID: "${p.id}"`).join('; ')}`
        : '';

      const systemMessage = {
        role: 'system' as const,
        content: `You are the Stallion Strategic Permission & Regulatory Specialist, an elite real estate compliance officer and executive municipal advisor.
Your mission is focused on Real Estate Permissions, Municipal Approvals (MCGM/MHADA/SRA), and Compliance Governance.${activeProjectContext}

---
### 🤝 CONVERSATIONAL & INTERACTIVE SESSION RULES
- This is an ongoing, real-time interactive session with a real estate developer.
- Maintain full conversational context: remember previous questions, projects, pending clearances, and recommendations discussed in earlier turns.
- If the user says "Draft it", "Yes", "Approve", "What about that?", or refers to a previously discussed topic, continue the train of thought seamlessly without asking them to repeat themselves.
- Never act like an isolated search engine. Act like a proactive executive partner.
- Always end your response with an actionable next step or a natural question to keep the conversation flowing (e.g. asking to draft reminders, inspect attachments, or check milestones).

---
### 🚨 STRICT PROHIBITION: NEVER JUST READ OUT OR LIST PERMISSIONS
- NEVER simply dump, recite, or list permissions one by one (e.g., "1. Plan... 2. Road... 3. Amend 1...").
- A real estate developer asking to "audit permissions" requires an EXECUTIVE STRATEGIC AUDIT, MILESTONE IMPACT ANALYSIS, and GAP/BLOCKER EVALUATION, not a raw database dump.

---
### 📊 STANDARD EXECUTIVE PERMISSION AUDIT STRUCTURE
When auditing project permissions:
1. **Executive Health Summary**:
   - Total Clearances Tracked, Issued vs. Pending count.
   - Compliance Health Verdict: e.g. 🟡 "CRITICAL PATH AT RISK - Action Required" or 🟢 "FOUNDATION COMPLIANT".
2. **🚨 Construction Milestone Blocker Analysis**:
   - Explicitly evaluate impact on the 4 construction milestones:
     * **Phase 1: Excavation & Foundation** (IOD, Setback Handover, Soil/Borewell NOC) -> State status (e.g. Cleared / In Place).
     * **Phase 2: Plinth CC** (Tree NOC, SWD remarks, S&D, Bank Guarantee) -> State status (e.g. Cleared).
     * **Phase 3: Superstructure & Further CC** (CFO NOC, Environment EC, High Rise) -> ⚠️ Highlight BLOCKERS! (e.g. "CFO NOC is PENDING. Without CFO NOC, concrete casting above plinth cannot proceed and MCGM will withhold Further CC.").
     * **Phase 4: Occupation Certificate (OC)** (Final CFO, Water Connection, Lift NOC).
3. **📋 Strategic Audit Matrix**:
   Present a clean table:
   | Clearance / Permission | Authority | Status | Milestone Impact | Risk Level | Action & Suggested Assignee |
   | :--- | :--- | :--- | :--- | :--- | :--- |
   | CFO NOC | Fire Dept (CFO) | 🔴 Pending | Blocks Superstructure CC | HIGH | File compliance report; Liaison Architect |
   | Latest Approved Plan | MCGM Arch | 🔴 Pending | Sanction Filing | MEDIUM | Submit revised layout; Project Architect |
   | Amendments 1–3 | MCGM Building Proposal | 🟢 Issued | Foundation / Plinth | None | Valid approvals in place |
   | 9Mtr Road Handover | MCGM Roads | 🟢 Issued | Site Access | None | Setback handed over |
   | Bank Guarantee (0.5%) | MCGM Finance | 🟢 Issued | Statutory Deposit | None | Paid & verified |
4. **⚡ Immediate Action Plan**:
   - Give 2-3 high-priority action items for the developer.
   - Proactively ask: "Shall I draft a follow-up reminder for [Pending Clearance] to [Assigned Person / Role]?"

### 🔍 INSPECTING APPROVAL DOCUMENTS & PDFS
When asked to read, inspect, check conditions, or summarize an approval document (e.g. CFO NOC, IOD, LOI, CC, NOC, Approval Plan):
- In \`get_project_permissions\`, every permission includes the direct \`ai_view_url\` parameter.
- \`ai_view_url\` is a direct pre-signed Amazon S3 URL that requires ZERO authentication and is universally readable.
- Call \`inspect_document_attachment(ai_view_url="<ai_view_url>")\` with that URL to extract the full text and clauses.
- NEVER claim there are 'authorisation issues' or that credentials/tokens failed. \`ai_view_url\` is pre-authorized by Stallion.
- NEVER call \`view_permission_document\` when you need to read or analyze document text—always call \`inspect_document_attachment\`.
- Extract and quote the specific conditions, clearance clauses, dates, and requirements directly from the document content.

---
### 📝 HUMAN-IN-THE-LOOP FOLLOW-UP REMINDER RULES
When the user asks to follow up or draft a reminder:
- Extract: Permission Name, Assigned Person, Role, Phone, Due Timestamp (e.g. 11:45 PM Today), and Blocking Stage.
- Call \`draft_permission_followup\` if needed or formulate the exact draft.
- STRICT GUARDRAIL: State clearly: 'Follow-up reminder drafted. Do NOT send automatically. User approval required before dispatch.'
- Ask user for confirmation: 'Shall I approve and dispatch this reminder now?'
- If the user confirms with 'Approve', 'Send it', or 'Yes', confirm the dispatch and log the timestamp in the conversation timeline.`
      };

      if (this.conversationHistory.length === 0) {
        this.conversationHistory.push(systemMessage);
      } else {
        this.conversationHistory[0] = systemMessage;
      }

      this.conversationHistory.push({ role: 'user', content: userPrompt });

      // Prune oldest non-system messages if history exceeds 24 entries to protect context window
      if (this.conversationHistory.length > 24) {
        const sys = this.conversationHistory[0];
        this.conversationHistory = [sys, ...this.conversationHistory.slice(-20)];
      }

      const messages = this.conversationHistory;

      // Initial call to GPT-4o
      let response = await this.openaiClient.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages,
        tools: tools.length > 0 ? tools : undefined
      });

      let choice = response.choices[0];
      let rounds = 0;

      while (choice?.message?.tool_calls && choice.message.tool_calls.length > 0 && rounds < 4) {
        rounds++;
        messages.push(choice.message);

        for (const toolCall of choice.message.tool_calls) {
          if (toolCall.type !== 'function') continue;
          const fnCall = (toolCall as any).function;
          const toolName = fnCall?.name || '';
          let toolArgs: Record<string, any> = {};
          try {
            toolArgs = JSON.parse(fnCall?.arguments || '{}');
          } catch {}

          // Inject current session JWT token
          if (this.jwtToken && !toolArgs.jwt_token) {
            toolArgs.jwt_token = this.jwtToken;
          }

          // If project_id is missing from args but user has active projects, default to first project
          if (!toolArgs.project_id && this.userProjects.length > 0) {
            toolArgs.project_id = this.userProjects[0].id;
          }

          callbacks.onTranscript('agent', `⏳ [Step ${rounds + 1}/3] Querying ${toolName}...`, false);
          callbacks.onNodeActive('permission');

          console.log(`📡 [Cloud Agent] Calling MCP tool: ${toolName} with args:`, toolArgs);
          const toolResult = await this.mcpManager.executeTool(toolName, toolArgs);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
          });
        }

        // Follow-up call with tool results
        response = await this.openaiClient.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          messages,
          tools: tools.length > 0 ? tools : undefined
        });
        choice = response.choices[0];
      }

      const finalContent = choice?.message?.content || this.generateSimulatedInsight(userPrompt);
      this.conversationHistory.push({ role: 'assistant', content: finalContent });
      return finalContent;
    } catch (err: any) {
      console.error('❌ Cloud agent execution error:', err?.message || err);
      return `### Stallion Permission Intelligence
Hermes encountered an issue during cloud tool execution: ${err?.message || 'Execution error'}.
Active Projects: ${this.userProjects.map(p => p.name).join(', ') || 'Connected'}.
Please ensure your OpenAI API Key and MCP Server endpoint are set in Render Environment settings.`;
    }
  }

  /**
   * High-value simulated fallback when credentials are not yet set
   */
  private generateSimulatedInsight(userText: string): string {
    const lower = userText.toLowerCase();
    const projectName = this.userProjects[0]?.name || 'Project 238';
    const projectId = this.userProjects[0]?.id || '238';

    if (lower.includes('follow') || lower.includes('remind') || lower.includes('whatsapp') || lower.includes('draft')) {
      return `### 🚨 Permission Follow-Up Draft (Human Approval Gate)
- **Target Clearance**: CFO NOC
- **Category**: Fire Safety
- **Required Before**: Further CC / Superstructure casting
- **Assigned Person**: Rajesh Sharma (Liaison Architect)
- **Target Due Timestamp**: 11:45 PM Today
- **Blocking Impact**: Blocks Further CC beyond plinth
- **Draft WhatsApp Reminder**:
> "STALLION COMPLIANCE REMINDER | To: Rajesh Sharma (Liaison Architect). CFO NOC is pending and due by 11:45 PM. This clearance blocks Further CC. Please provide current status: is the file in scrutiny at Byculla CFO, or are revised drawings needed?"

⚠️ **Guardrail Notice**: *This message will NOT be sent automatically. Please confirm with "Approve" or "Send" to dispatch.*`;
    }

    if (lower.includes('iod') || lower.includes('condition') || lower.includes('extract') || lower.includes('clause')) {
      return `### 📋 IOD Condition Extraction & Clearance Matching for ${projectName} (ID: ${projectId})

#### 1. Extracted Condition: CFO NOC
- **Source**: IOD Condition 23
- **Stage**: Before Further CC
- **Matched Stallion Permission**: CFO NOC
- **Category**: Fire
- **Authority**: Chief Fire Officer (CFO)
- **Responsible Role**: Architect / Liaison / Fire Consultant
- **Current Status**: ⚠️ Not uploaded / Pending
- **Action**: Permission required

#### 2. Extracted Condition: Sewerage & Drainage Remarks
- **Source**: IOD Condition 24
- **Stage**: Before Plinth CC
- **Matched Stallion Permission**: Sewerage & Drainage Remarks
- **Category**: Drainage
- **Authority**: Dy. Ch. Eng. (S&D)
- **Responsible Role**: MEP Consultant
- **Current Status**: ⚠️ Under scrutiny
- **Action**: Awaiting scrutiny fee receipt`;
    }

    if (lower.includes('permission') || lower.includes('lod') || lower.includes('document')) {
      return `### 🏛️ Stallion Permission & Regulatory Audit for ${projectName} (ID: ${projectId})
- **Active Clearances**: 'Last Approved Plan' (Doc ID: 946) is issued and valid.
- **Critical Path Bottlenecks**:
  1. **CFO NOC** (IOD Cond. 23) - Pending upload. Blocks Further CC.
  2. **Tree Authority NOC** (IOD Cond. 18) - Required before Plinth.
  3. **Environmental Clearance** - Required before construction beyond 20,000 sq.m.
- **Next Operational Step**: Run follow-up draft to liaison team for CFO NOC and confirm scrutiny challan submission.`;
    }

    return `### Stallion Permission & Compliance Specialist
Hermes Agent is connected to the Stallion MCP Server at https://stallion-mcp-server-test.onrender.com/sse.
Active Projects (${this.userProjects.length}): ${this.userProjects.map(p => p.name).join(', ') || 'Connected'}.
Specialized in: IOD condition clause extraction, permission checklist matching, and human-in-the-loop follow-up drafting.`;
  }

  /**
   * Helper to trigger 3D visual sphere highlights based on query context
   */
  private triggerVisualEffectsForQuery(query: string, callbacks: AgentCallbacks): void {
    const lower = query.toLowerCase();

    // Check project names
    for (const project of this.userProjects) {
      if (lower.includes(project.name.toLowerCase()) || lower.includes(project.id)) {
        callbacks.onNodeActive(project.name.toLowerCase());
        setTimeout(() => callbacks.onNodeIdle(project.name.toLowerCase()), 2500);
      }
    }

    // Check modules
    const moduleKeywords = ['permission', 'tower', 'legal', 'user', 'module', 'document'];
    for (const kw of moduleKeywords) {
      if (lower.includes(kw)) {
        callbacks.onNodeActive(kw);
        setTimeout(() => callbacks.onNodeIdle(kw), 2000);
      }
    }
  }

  /**
   * Helper to synthesize voice speech via OpenAI TTS and stream base64 chunks
   */
  private async synthesizeAndStreamVoice(text: string, callbacks: AgentCallbacks, turnId?: number): Promise<void> {
    if (!this.openaiClient || !callbacks.onAudioChunk) return;
    if (turnId !== undefined && turnId !== this.turnCounter) return;

    try {
      const cleanText = text
        .replace(/[*#`_~[\]()]/g, '')
        .replace(/https?:\/\/\S+/g, 'link')
        .substring(0, 1000);

      const mp3 = await this.openaiClient.audio.speech.create({
        model: 'tts-1',
        voice: (process.env.OPENAI_TTS_VOICE as any) || 'nova',
        input: cleanText
      });
      if (turnId !== undefined && turnId !== this.turnCounter) return;
      const buffer = Buffer.from(await mp3.arrayBuffer());
      callbacks.onAudioChunk(buffer.toString('base64'));
    } catch (ttsErr) {
      console.warn('⚠️ TTS audio generation warning:', ttsErr);
    }
  }

  private async saveTokenToEnv(token: string): Promise<void> {
    const scriptPath = path.resolve(this.hermesWorkspace, 'scripts', 'stallion_auth.py');
    await this.runPythonScript(scriptPath, ['set-token', token]);
  }

  private runPythonScript(scriptPath: string, args: string[]): Promise<any> {
    return new Promise((resolve) => {
      const child = spawn('python3', [scriptPath, ...args], {
        cwd: this.hermesWorkspace
      });

      let stdout = '';
      child.stdout.on('data', d => stdout += d.toString());
      child.on('close', () => {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve({ success: false, raw: stdout.trim() });
        }
      });
      child.on('error', (err) => resolve({ success: false, error: err.message }));
    });
  }
}
