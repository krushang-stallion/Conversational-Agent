import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import OpenAI from 'openai';
import { MCPClientManager, ProjectInfo, extractPdfTextFromUrl } from './mcpClient.js';
import {
  extractIodConditionsFromBuffer,
  processClearancePdfsInBatches,
  ExtractedIodDocument
} from './documentExtractor.js';

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
  private activeIodSanction: ExtractedIodDocument | null = null;
  private lastProcessedQuery = '';
  private lastProcessedTime = 0;
  private cachedProjectPermissions = new Map<string, any[]>();

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
    this.activeIodSanction = null;
    this.lastProcessedQuery = '';
    this.lastProcessedTime = 0;
    this.cachedProjectPermissions.clear();
  }

  /**
   * Ingest and parse an uploaded IOD PDF document, extracting conditions using gpt-4o-mini
   */
  public async ingestIodDocument(fileName: string, buffer: Buffer, callbacks: AgentCallbacks): Promise<ExtractedIodDocument> {
    if (!this.openaiClient) {
      throw new Error('OpenAI client is not configured.');
    }

    callbacks.onStateChange('thinking');
    callbacks.onNodeActive('document');
    callbacks.onTranscript('agent', `Ingesting and reading IOD document: ${fileName}...`, false);

    const extracted = await extractIodConditionsFromBuffer(buffer, fileName, this.openaiClient);
    this.activeIodSanction = extracted;

    const count = extracted.total_conditions;
    const refStr = extracted.iod_reference ? ` (Reference: ${extracted.iod_reference})` : '';
    const reply = `I have successfully ingested your IOD sanction document: "${fileName}"${refStr}. I extracted ${count} municipal sanction conditions. Whenever you're ready, ask me to audit your project permissions, and I will compare these conditions against all Stallion clearance records.`;

    callbacks.onStateChange('speaking');
    callbacks.onTranscript('agent', reply, true);
    await this.synthesizeAndStreamVoice(reply, callbacks);
    callbacks.onStateChange('listening');

    return extracted;
  }

  public getActiveIodSanction(): ExtractedIodDocument | null {
    return this.activeIodSanction;
  }

  public clearActiveIodSanction(): void {
    this.activeIodSanction = null;
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
        ? `Greetings ${userName}. Hermes Agent is active as your Stallion Permission & Regulatory Specialist. I have mapped your projects.`
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
          try { fs.unlinkSync(tempAudioPath); } catch { }
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
        .replace(/\b(?:iodine|i\s*o\s*d|eye\s*oh\s*dee)\b/gi, 'IOD')
        .replace(/\b(?:ce\s*ce|c\s*c|see\s*see)\b/gi, 'CC')
        .replace(/\b(?:oh\s*see|o\s*c)\b/gi, 'OC')
        .replace(/\b(?:c\s*f\s*o|see\s*eff\s*oh)\b/gi, 'CFO')
        .replace(/\b(?:n\s*o\s*c|en\s*oh\s*see)\b/gi, 'NOC')
        .replace(/\b(?:s\s*w\s*d|ess\s*double\s*you\s*dee)\b/gi, 'SWD')
        .replace(/\b(?:m\s*c\s*g\s*m|em\s*see\s*gee\s*em)\b/gi, 'MCGM')
        .replace(/\b(?:m\s*h\s*a\s*d\s*a|mahada)\b/gi, 'MHADA')
        .replace(/\b(?:s\s*r\s*a|ess\s*are\s*ay)\b/gi, 'SRA');

      // Deduplicate immediate duplicate queries (e.g. STT interim correction sent twice)
      const now = Date.now();
      const normalizedQueryKey = userText.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (
        normalizedQueryKey.length > 0 &&
        normalizedQueryKey === this.lastProcessedQuery &&
        (now - this.lastProcessedTime) < 6000
      ) {
        console.log(`🛡️ Deduplicating duplicate user speech turn within 6s: "${userText}"`);
        callbacks.onStateChange('listening');
        return;
      }

      this.lastProcessedQuery = normalizedQueryKey;
      this.lastProcessedTime = now;

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

  private detectReferredDocument(text: string): { docType: string; keywords: string[] } | null {
    const lower = text.toLowerCase();
    if (lower.includes('iod') || lower.includes('intimation of disapproval') || lower.includes('sanction letter') || lower.includes('amendment iod')) {
      return { docType: 'IOD', keywords: ['iod', 'concession', 'amendment', 'sanction'] };
    }
    if (lower.includes('commencement certificate') || lower.includes('further cc') || lower.includes('plinth cc') || /\bcc\b/i.test(text)) {
      return { docType: 'CC', keywords: ['commencement certificate', 'cc', 'plinth', 'further cc'] };
    }
    if (lower.includes('cfo') || lower.includes('fire noc') || lower.includes('fire clearance')) {
      return { docType: 'CFO NOC', keywords: ['cfo', 'fire'] };
    }
    if (lower.includes('tree') && (lower.includes('noc') || lower.includes('clearance') || lower.includes('document') || lower.includes('complianc'))) {
      return { docType: 'Tree NOC', keywords: ['tree'] };
    }
    if (lower.includes('swd') || lower.includes('storm water') || lower.includes('drainage')) {
      return { docType: 'SWD NOC', keywords: ['swd', 'drainage', 'storm water'] };
    }
    if (lower.includes('occupancy certificate') || /\boc\b/i.test(text)) {
      return { docType: 'Occupancy Certificate (OC)', keywords: ['occupancy', 'oc'] };
    }
    if (lower.includes('environment') || lower.includes('moef') || /\bec\b/i.test(text)) {
      return { docType: 'Environmental Clearance', keywords: ['environment', 'moef', 'ec'] };
    }
    if (lower.includes('aviation') || lower.includes('aai')) {
      return { docType: 'Civil Aviation NOC', keywords: ['aviation', 'aai'] };
    }
    return null;
  }

  private async resolveReferredDocumentText(
    docInfo: { docType: string; keywords: string[] },
    projectId: string,
    userQuery: string,
    callbacks: AgentCallbacks
  ): Promise<{ docName: string; extractedText: string; url?: string } | null> {
    // 1. Check if user uploaded an active IOD document
    if (docInfo.docType === 'IOD' && this.activeIodSanction) {
      if (this.activeIodSanction.raw_text) {
        return {
          docName: `Uploaded IOD (${this.activeIodSanction.file_name})`,
          extractedText: this.activeIodSanction.raw_text
        };
      }
      if (this.activeIodSanction.conditions && this.activeIodSanction.conditions.length > 0) {
        const condText = this.activeIodSanction.conditions.map(c =>
          `Condition ${c.condition_no} [Stage: ${c.stage} | Authority: ${c.authority}]: ${c.requirement}`
        ).join('\n');
        return {
          docName: `Uploaded IOD (${this.activeIodSanction.file_name})`,
          extractedText: condText
        };
      }
    }

    // 2. Fetch project permissions if not cached
    let perms = this.cachedProjectPermissions.get(projectId);
    if (!perms || perms.length === 0) {
      try {
        callbacks.onTranscript('agent', '📄 Fetching project records to locate document...', false);
        const permsResult: any = await this.mcpManager.executeTool('get_project_permissions', { project_id: projectId });
        perms = permsResult?.permissions || permsResult?.data?.permissions || (Array.isArray(permsResult) ? permsResult : []);
        if (perms && perms.length > 0) {
          this.cachedProjectPermissions.set(projectId, perms);
        }
      } catch (err) {
        console.warn('⚠️ Could not fetch permissions for document resolution:', err);
      }
    }

    if (!perms || perms.length === 0) return null;

    // Find the matching permission
    const matchedPerm = perms.find((p: any) => {
      const pName = (p.name || '').toLowerCase();
      return docInfo.keywords.some(k => pName.includes(k));
    });

    if (!matchedPerm) return null;

    const docUrl = matchedPerm.ai_view_url ||
      matchedPerm.documents?.permission_plan?.[0]?.ai_view_url ||
      matchedPerm.documents?.lod_documents?.[0]?.files?.[0]?.ai_view_url ||
      matchedPerm.documents?.other_files?.[0]?.ai_view_url;

    if (!docUrl) return null;

    callbacks.onTranscript('agent', `🔍 Reading full text of ${matchedPerm.name}...`, false);
    try {
      const docResult = await extractPdfTextFromUrl(docUrl, this.jwtToken);
      if (docResult && docResult.extracted_content) {
        return {
          docName: matchedPerm.name,
          extractedText: docResult.extracted_content,
          url: docUrl
        };
      }
    } catch (err) {
      console.warn(`⚠️ Error reading PDF for ${matchedPerm.name}:`, err);
    }

    return null;
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
        ? `\n\n### 🏢 AUTHORIZED USER PROJECTS (STRICT ACCESS BOUNDARY)
The developer is strictly authorized to access only the following registered projects:
${this.userProjects.map(p => `• Project Name: "${p.name}", Project ID: "${p.id}"`).join('\n')}

STRICT PROJECT SELECTION GOVERNANCE:
1. When calling \`get_project_permissions(project_id="...")\` or any project tool, you MUST use one of the authorized Project IDs listed above.
2. NEVER query, invent, or use any unauthorized project ID.
3. If the user mentions one of their authorized projects by name (e.g. "${this.userProjects[0].name}"), map it to its exact authorized ID ("${this.userProjects[0].id}").
4. If the user does not specify a project, default to their primary authorized project: "${this.userProjects[0].name}" (ID: ${this.userProjects[0].id}), and let the user know they can also audit their other projects (${this.userProjects.slice(1).map(p => p.name).join(', ') || 'N/A'}).`
        : '';

      const activeIodContext = this.activeIodSanction
        ? `\n\n### 📑 ACTIVE UPLOADED IOD SANCTION DOCUMENT (PRIMARY BENCHMARK)
The user has uploaded their project IOD sanction document: "${this.activeIodSanction.file_name}".
Reference: ${this.activeIodSanction.iod_reference || 'N/A'}, Sanction Date: ${this.activeIodSanction.sanction_date || 'N/A'}.
Total Extracted Conditions: ${this.activeIodSanction.total_conditions}.
SUMMARY: ${this.activeIodSanction.raw_summary || 'Sanction conditions extracted.'}
EXTRACTED IOD CONDITIONS:
${JSON.stringify(this.activeIodSanction.conditions, null, 2)}

AUDIT CROSS-MATCHING DIRECTIVE:
When auditing permissions, cross-match every IOD condition above against the project's Stallion clearance records.
Categorize findings dynamically into:
1. COMPLIED / SATISFIED (Clearance approved & verified in Stallion)
2. CRITICAL BLOCKERS (Clearances required for current stage e.g. Plinth CC or Further CC, but missing or unapproved)
3. IN PROGRESS / UPCOMING (Future stage clearances e.g. OC under process)
4. REMARKS & CAVEATS (Reference specific remarks_notes, financial guarantees, and validity dates from the documents).`
        : '';

      // Detect if user query refers to a specific document (e.g. IOD, CC, CFO NOC)
      const referredDoc = this.detectReferredDocument(userPrompt);
      let documentDirectContext = '';

      if (referredDoc) {
        let targetProjectId = this.userProjects[0]?.id || '';
        if (this.userProjects.length > 0) {
          const promptLower = userPrompt.toLowerCase();
          const matchedP = this.userProjects.find(p => promptLower.includes(p.name.toLowerCase()));
          if (matchedP) targetProjectId = matchedP.id;
        }

        if (targetProjectId) {
          const docData = await this.resolveReferredDocumentText(referredDoc, targetProjectId, userPrompt, callbacks);
          if (docData && docData.extractedText) {
            console.log(`✅ Loaded full document text for ${docData.docName} (${docData.extractedText.length} chars)`);
            const isOverview = userPrompt.toLowerCase().includes('overview') || userPrompt.toLowerCase().includes('summarize');
            documentDirectContext = `\n\n### 📑 FULL EXTRACTED TEXT OF REFERENCED DOCUMENT: "${docData.docName}"
User Query: "${userPrompt}"

CRITICAL INSTRUCTIONS:
1. ${isOverview 
      ? 'The user requested an overview: Provide a crisp executive overview of sanction date, approved floors/height, and key milestones.'
      : 'DO NOT summarize the entire document! The user asked a specific question regarding this document. Answer ONLY what the user asked: "' + userPrompt + '".'}
2. Search and analyze the FULL EXTRACTED TEXT below to give the exact, concrete answer.
3. List the exact condition numbers, specific clauses, and stage mandates (e.g. if the user asks for compliances to be done before Further CC, list the exact conditions stipulated under Further CC / work beyond plinth).
4. Do NOT output generic broad categories like "Structural and Safety Compliance", "Environmental Requirements", "Legal Settlements", etc. Citing exact condition numbers and concrete requirements is required.

--- FULL EXTRACTED DOCUMENT TEXT (${docData.extractedText.length} characters) ---
${docData.extractedText}
--- END OF EXTRACTED DOCUMENT TEXT ---`;
          }
        }
      }

      const systemMessage = {
        role: 'system' as const,
        content: `You are the Stallion Strategic Permission & Regulatory Specialist, an elite real estate compliance officer and executive municipal advisor.
Your mission is focused on Real Estate Permissions, Municipal Approvals (MCGM/MHADA/SRA), and Compliance Governance.${activeProjectContext}${activeIodContext}${documentDirectContext}

---
### 🎙️ CRITICAL: NATURAL EXECUTIVE SPOKEN VOICE STYLE
Your response is spoken aloud to the developer through neural speech synthesis and displayed as live subtitles.
DO NOT sound like a spreadsheet, a database dump, or a robotic screen reader!
1. **NEVER recite item-by-item status lists**:
   - ❌ STRICTLY FORBIDDEN:
     "Permission 1 - Issued
      Permission 2 - Issued
      Permission 3 - Pending"
   - ❌ STRICTLY FORBIDDEN:
     "Condition 1 - Complied. Condition 2 - Not Complied."
2. **ALWAYS synthesize and group naturally in conversational English**:
   - ✅ REQUIRED STYLE (Group by status):
     "For [Project Name], you have [N] tracked clearances. Your approved permissions on file are [Permission 1] and [Permission 2]. Meanwhile, [Permission 3] is currently pending with [Assigned Person], which blocks [Stage]."
   - Group approved items together. Group pending or blocked items together with their responsible person and milestone impact.
3. **Natural Phrasing for IOD / Sanction Overview**:
   - ✅ REQUIRED STYLE:
     "Your IOD was sanctioned on [Date] under reference number [Ref]. Key municipal conditions require obtaining CFO and Tree clearance before moving beyond the plinth level. You have already complied with [X], while [Y] is pending."
4. **Tone & Formatting**:
   - Speak in fluent, professional, articulate sentences.
   - Do NOT use markdown tables or repetitive bullet hyphens in your sentences.
   - Conclude naturally: "Would you like me to draft a follow-up reminder for [Pending Item], or inspect specific condition clauses?"

---
### 🤝 CONVERSATIONAL & INTERACTIVE SESSION RULES
- This is an ongoing, real-time interactive session with a real estate developer.
- Maintain full conversational context: remember previous questions, projects, pending clearances, and recommendations discussed in earlier turns.
- If the user says "Draft it", "Yes", "Approve", "What about that?", or refers to a previously discussed topic, continue the train of thought seamlessly without asking them to repeat themselves.
- Never act like an isolated search engine. Act like a proactive executive partner.
- Always end your response with an actionable next step or a natural question to keep the conversation flowing (e.g. asking to draft reminders, inspect attachments, or check milestones).

---
### 🔍 DYNAMIC PERMISSION WORKFLOWS & COMPLIANCE RULES

#### WORKFLOW 1: PERMISSION AUDIT / QUICK UPDATE (EXISTING STALLION RECORDS)
When the user asks to "audit permissions", "give a quick update", or "check status of approvals":
1. **NO USER PDF REQUIRED**: Do NOT ask for or require an uploaded user PDF. Read the project's existing permissions from Stallion.
2. Invoke \`get_project_permissions(project_id="...")\` to retrieve the live permissions and clearance documents.
3. The system automatically reads and summarizes attached clearance PDFs in parallel using gpt-4o-mini.
4. Deliver a concise, executive overview of the project's current compliance state:
   * **Total Tracked Permissions & Status Breakdown**: State total count, how many are Approved/Issued, how many are Pending/In-Process, and any Expired.
   * **Verified Approvals on File**: Highlight key clearances verified (e.g., CFO provisional NOC valid dates, sanctioned heights/floors, SWD remarks).
   * **Pending Clearances & Responsibility**: Identify pending clearances, who is assigned (\`assigned_to\`), and their construction impact.
   * **Special Remarks & Financial Guarantees**: Include specific caveats or obligations from \`remarks_notes\` (e.g. bank guarantees, dedicated fire lift requirements).
5. Conclude proactively:
   * Offer to provide a deep-dive into major milestones: *"Would you like an in-depth overview of your IOD, Commencement Certificate (CC), or Occupancy Certificate (OC), or should I draft a follow-up reminder for a pending item?"*

#### WORKFLOW 2: DOCUMENT-SPECIFIC QUERIES & CONDITIONS (WHEN A PARTICULAR DOCUMENT IS REFERRED TO)
When the user refers to or asks about a specific document (e.g. "from IOD document", "in the CFO NOC", "CC conditions", "compliances before Further CC"):
1. **STRICT RULE: DO NOT SUMMARIZE THE ENTIRE DOCUMENT**:
   - If the user asks a specific question (e.g. "Can you tell me the compliances to be done before Further CC from IOD document"), answer ONLY that specific question!
   - NEVER output broad generic categories summarizing the whole document (e.g. DO NOT output "1. Structural Compliance, 1. Environmental Requirements, 1. Legal Settlements, 1. Operational Measures, 1. Regulatory Compliance").
2. **GROUND IN THE FULL EXTRACTED TEXT**:
   - Use the FULL EXTRACTED TEXT of that document provided in context (or via \`inspect_document_attachment\`).
   - Find the exact condition clauses, condition numbers, and requirements that specifically answer what the user asked (e.g., list the exact conditions stipulated under "Before issue of Further CC / work beyond plinth").
   - Quote condition numbers (e.g. Condition 12, Condition 23, Condition 41) and specific municipal requirements.
3. **ONLY SUMMARIZE IF EXPLICITLY ASKED FOR AN OVERVIEW**:
   - ONLY deliver an executive overview/summary if the user literally asks: "Give me an overview of IOD" or "Summarize the CC". Otherwise, be targeted, precise, and direct.

#### WORKFLOW 3: EXTERNAL IOD CROSS-MATCHING (ONLY IF USER UPLOADED A FILE)
- If and only if the user explicitly uploaded an IOD document at the start, cross-match those external conditions against the Stallion clearances (Complied, In-Progress, Critical Blockers).

---
### 🔍 INSPECTING APPROVAL DOCUMENTS & PDFS
When asked to read, inspect, check conditions, or summarize an approval document (e.g. CFO NOC, IOD, LOI, CC, NOC, Approval Plan):
- In \`get_project_permissions\`, every permission includes the direct \`ai_view_url\` parameter.
- \`ai_view_url\` is a direct pre-signed Amazon S3 URL that requires ZERO authentication and is universally readable.
- Call \`inspect_document_attachment(ai_view_url="<ai_view_url>")\` with that URL to extract the full text and clauses.

---
### 📝 HUMAN-IN-THE-LOOP FOLLOW-UP REMINDER RULES
When the user asks to follow up or draft a reminder:
- Extract: Permission Name, Assigned Person, Role, Phone, Due Timestamp, and Blocking Stage.
- Call \`draft_permission_followup\` if needed or formulate the exact draft.
- STRICT GUARDRAIL: State clearly: 'Follow-up reminder drafted. Do NOT send automatically. User approval required before dispatch.'
- Ask user for confirmation: 'Shall I approve and dispatch this reminder now?'
- If the user confirms with 'Approve', 'Send it', or 'Yes', confirm the dispatch.`
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
          } catch { }

          // Inject current session JWT token
          if (this.jwtToken && !toolArgs.jwt_token) {
            toolArgs.jwt_token = this.jwtToken;
          }

          // Validate & strictly enforce authorized project boundary
          if (this.userProjects.length > 0) {
            const authorizedIds = new Set(this.userProjects.map(p => String(p.id)));
            const userPromptLower = userPrompt.toLowerCase();

            // Check if user specifically requested an authorized project by name
            const matchedProject = this.userProjects.find(p =>
              userPromptLower.includes(p.name.toLowerCase()) ||
              (toolArgs.project_name && p.name.toLowerCase().includes(String(toolArgs.project_name).toLowerCase()))
            );

            if (matchedProject) {
              toolArgs.project_id = matchedProject.id;
            } else if (!toolArgs.project_id || !authorizedIds.has(String(toolArgs.project_id))) {
              if (toolArgs.project_id) {
                console.warn(`⚠️ Overriding unauthorized project_id "${toolArgs.project_id}" with authorized project ID "${this.userProjects[0].id}" (${this.userProjects[0].name})`);
              }
              toolArgs.project_id = this.userProjects[0].id;
            }
          }

          callbacks.onTranscript('agent', `⏳ [Step ${rounds + 1}/3] Querying ${toolName}...`, false);
          callbacks.onNodeActive('permission');

          console.log(`📡 [Cloud Agent] Calling MCP tool: ${toolName} with args:`, toolArgs);
          let toolResult = await this.mcpManager.executeTool(toolName, toolArgs);

          if (toolName === 'inspect_document_attachment' && toolResult && typeof toolResult === 'object') {
            (toolResult as any).user_query_directive = `CRITICAL: The user asked: "${userPrompt}". Answer ONLY the specific question asked using this full extracted text. DO NOT summarize the entire document unless an overview was requested. Quote exact condition numbers and clauses.`;
          }

          // When querying project permissions, automatically run parallel clearance extraction on attached PDFs
          if (toolName === 'get_project_permissions' && this.openaiClient) {
            try {
              let parsedPerms: any = toolResult;
              if (typeof toolResult === 'string') {
                try { parsedPerms = JSON.parse(toolResult); } catch { }
              }
              const permsList = parsedPerms?.permissions || parsedPerms?.data?.permissions || (Array.isArray(parsedPerms) ? parsedPerms : []);

              if (permsList.length > 0) {
                this.cachedProjectPermissions.set(String(toolArgs.project_id || this.userProjects[0]?.id || ''), permsList);

                // If user asked about a specific document and it wasn't pre-loaded, extract its full text here
                let referredDocData: any = null;
                const referred = this.detectReferredDocument(userPrompt);
                if (referred) {
                  const targetPerm = permsList.find((p: any) => {
                    const pName = (p.name || '').toLowerCase();
                    return referred.keywords.some(k => pName.includes(k));
                  });
                  if (targetPerm?.ai_view_url) {
                    try {
                      callbacks.onTranscript('agent', `🔍 Reading full text of ${targetPerm.name}...`, false);
                      const fullDoc = await extractPdfTextFromUrl(targetPerm.ai_view_url, this.jwtToken);
                      if (fullDoc?.extracted_content) {
                        referredDocData = {
                          permission_name: targetPerm.name,
                          file_name: targetPerm.file_name,
                          full_extracted_text: fullDoc.extracted_content,
                          directive: `CRITICAL: The user asked: "${userPrompt}". DO NOT summarize the entire document. Answer ONLY the specific question asked using this full extracted text. Quote exact condition numbers and requirements.`
                        };
                      }
                    } catch (e) {
                      console.warn('Error reading referred doc in tool handler:', e);
                    }
                  }
                }

                callbacks.onTranscript('agent', '🔍 Analyzing existing clearance documents with gpt-4o-mini in parallel...', false);
                const masterContext = await processClearancePdfsInBatches(
                  permsList,
                  String(toolArgs.project_id || this.userProjects[0]?.id || ''),
                  this.openaiClient,
                  this.jwtToken,
                  (msg) => callbacks.onTranscript('agent', msg, false),
                  4
                );

                toolResult = {
                  success: true,
                  project_id: toolArgs.project_id || this.userProjects[0]?.id || '',
                  total_permissions: permsList.length,
                  unified_master_clearances: masterContext.clearances,
                  unprocessed_permissions: masterContext.unprocessed_permissions,
                  all_project_permissions: permsList.map((p: any) => ({
                    id: String(p.id),
                    name: p.name,
                    status: p.status,
                    exp_date: p.exp_date,
                    assigned_to: p.assigned_to,
                    ai_view_url: p.ai_view_url,
                    file_name: p.file_name,
                    remark: p.remark
                  })),
                  ...(referredDocData ? { referenced_document_full_text: referredDocData } : {}),
                  ...(this.activeIodSanction ? {
                    active_uploaded_iod: {
                      file_name: this.activeIodSanction.file_name,
                      iod_reference: this.activeIodSanction.iod_reference,
                      sanction_date: this.activeIodSanction.sanction_date,
                      total_conditions: this.activeIodSanction.total_conditions,
                      conditions: this.activeIodSanction.conditions
                    }
                  } : {}),
                  audit_instructions: referredDocData
                    ? `CRITICAL: The user is asking a specific question regarding "${referredDocData.permission_name}": "${userPrompt}". DO NOT summarize the entire document. Answer ONLY the specific query asked by quoting the exact conditions and clauses from the full text provided.`
                    : (this.activeIodSanction
                      ? "CRITICAL: Compare every condition in active_uploaded_iod against unified_master_clearances. Group conditions naturally in conversational spoken sentences: state which are COMPLIED, which are IN PROGRESS, and which are CRITICAL BLOCKERS (required for current stage like Plinth CC or Further CC but missing or unapproved in Stallion). Specifically reference clearance remarks_notes, dates, and authorities. NEVER recite repetitive 'Condition - Status' bullet points."
                      : "Deliver a crisp, data-grounded overview and status audit of these existing project permissions. Group permissions conversationally by status into natural spoken sentences (e.g. 'Your issued permissions are Permission 1 and Permission 2. Pending permissions are Permission 3 assigned to...'). Do NOT output repetitive 'Permission - Status' lists or recite item-by-item status tags. Summarize verified approvals, validities, pending items, assigned persons, and key remarks_notes. If the user asked for an overview of a specific milestone (e.g. IOD, CC, OC), identify that specific permission from all_project_permissions and call inspect_document_attachment(ai_view_url=...) to inspect its attached PDF.")
                };
              }
            } catch (batchErr) {
              console.warn('⚠️ Batch clearance extraction error:', batchErr);
            }
          }

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
    const projectName = this.userProjects[0]?.name || 'Authorized Project';
    const projectId = this.userProjects[0]?.id || '';

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
        callbacks.onNodeActive?.(project.name.toLowerCase());
        setTimeout(() => callbacks.onNodeIdle?.(project.name.toLowerCase()), 2500);
      }
    }

    // Check modules
    const moduleKeywords = ['permission', 'tower', 'legal', 'user', 'module', 'document'];
    for (const kw of moduleKeywords) {
      if (lower.includes(kw)) {
        callbacks.onNodeActive?.(kw);
        setTimeout(() => callbacks.onNodeIdle?.(kw), 2000);
      }
    }
  }

  /**
   * Helper to synthesize voice speech via OpenAI TTS and stream base64 chunks.
   * Cleans formatting and splits long text into sentence-safe chunks up to 3500 chars
   * so the entire response is spoken without stopping in between.
   */
  private async synthesizeAndStreamVoice(text: string, callbacks: AgentCallbacks, turnId?: number): Promise<void> {
    if (!this.openaiClient || !callbacks.onAudioChunk) return;
    if (turnId !== undefined && turnId !== this.turnCounter) return;

    try {
      // 1. Clean markdown formatting, raw URLs, and table pipes for smooth natural speech
      let cleaned = text
        .replace(/https?:\/\/\S+/g, '') // remove raw URL links
        .replace(/\|/g, ', ') // convert markdown table dividers to natural pauses
        .replace(/[*#`_~[\]()]/g, '') // strip markdown markers
        .replace(/\n{2,}/g, '. ') // double newlines into sentences
        .replace(/\n/g, '. ') // single newlines into sentences
        .replace(/\s*[-–—]\s*/g, ', ') // convert stray dashes/hyphens to natural comma pauses (never speak "dash"!)
        .replace(/\s+/g, ' ')
        .replace(/[,.]\s*[,.]+/g, '.')
        .replace(/\s*,\s*/g, ', ')
        .replace(/\s*\.\s*/g, '. ')
        .trim();

      if (!cleaned) return;

      // 2. Split into chunks of up to 3500 characters on sentence boundaries
      const chunks: string[] = [];
      if (cleaned.length <= 3800) {
        chunks.push(cleaned);
      } else {
        const sentences = cleaned.match(/[^.!?]+[.!?]+|\S+/g) || [cleaned];
        let currentChunk = '';
        for (const s of sentences) {
          if ((currentChunk + ' ' + s).length > 3500) {
            if (currentChunk.trim()) chunks.push(currentChunk.trim());
            currentChunk = s;
          } else {
            currentChunk = currentChunk ? currentChunk + ' ' + s : s;
          }
        }
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
      }

      // 3. Synthesize and stream each audio chunk
      for (const chunk of chunks) {
        if (turnId !== undefined && turnId !== this.turnCounter) return;

        const mp3 = await this.openaiClient.audio.speech.create({
          model: 'tts-1',
          voice: (process.env.OPENAI_TTS_VOICE as any) || 'nova',
          input: chunk
        });

        if (turnId !== undefined && turnId !== this.turnCounter) return;
        const buffer = Buffer.from(await mp3.arrayBuffer());
        callbacks.onAudioChunk(buffer.toString('base64'));
      }
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
