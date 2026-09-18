import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { SphereConversationalAgent, AIState } from './agent.js';
import { ProjectInfo } from './mcpClient.js';

dotenv.config();

const port = parseInt(process.env.PORT || '8080', 10);

// Find static frontend dist folder if built
const frontendDistPath = fs.existsSync(path.resolve(process.cwd(), '../frontend/dist'))
  ? path.resolve(process.cwd(), '../frontend/dist')
  : path.resolve(process.cwd(), 'frontend/dist');

export interface UIEvent {
  type: 'STATE_CHANGE' | 'NODE_ACTIVE' | 'NODE_IDLE' | 'TRANSCRIPT' | 'PROJECTS_LOADED' | 'AUDIO_STREAM' | 'ERROR';
  state?: AIState;
  nodeModule?: string;
  speaker?: 'user' | 'agent';
  text?: string;
  isFinal?: boolean;
  projects?: ProjectInfo[];
  audioBase64?: string;
  error?: string;
}

// HTTP Server for serving UI static assets and upgrading to WebSockets
const server = http.createServer((req, res) => {
  if (!fs.existsSync(frontendDistPath)) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('⚡ Neural Sphere WebSocket Backend is active and running.');
    return;
  }

  let filePath = path.join(frontendDistPath, req.url === '/' ? 'index.html' : (req.url || 'index.html'));
  if (!fs.existsSync(filePath)) {
    filePath = path.join(frontendDistPath, 'index.html');
  }

  const ext = path.extname(filePath);
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end('Error loading file');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

const wss = new WebSocketServer({ server });

const agent = new SphereConversationalAgent();

async function startServer() {
  await agent.initialize();
  server.listen(port, () => {
    console.log(`⚡ Neural Sphere server active on port ${port} (HTTP & WebSockets)`);
  });
}

startServer().catch(console.error);

wss.on('connection', (ws: WebSocket) => {
  console.log('🔗 Client connected to Neural Sphere Agent Stream');

  const sendEvent = (event: UIEvent) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  };

  // Bind agent callbacks to WebSocket client
  const callbacks = {
    onStateChange: (state: AIState) => {
      sendEvent({ type: 'STATE_CHANGE', state });
    },
    onNodeActive: (nodeModule: string) => {
      sendEvent({ type: 'NODE_ACTIVE', nodeModule });
    },
    onNodeIdle: (nodeModule: string) => {
      sendEvent({ type: 'NODE_IDLE', nodeModule });
    },
    onTranscript: (speaker: 'user' | 'agent', text: string, isFinal: boolean) => {
      sendEvent({ type: 'TRANSCRIPT', speaker, text, isFinal });
    },
    onProjectsLoaded: (projects: ProjectInfo[]) => {
      sendEvent({ type: 'PROJECTS_LOADED', projects });
    },
    onAudioChunk: (base64Audio: string) => {
      sendEvent({ type: 'AUDIO_STREAM', audioBase64: base64Audio });
    }
  };

  ws.on('message', async (data: Buffer | string) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'SESSION_START':
          console.log('🚀 Session started by user click');
          agent.resetSession();
          sendEvent({ type: 'STATE_CHANGE', state: 'speaking' });
          sendEvent({
            type: 'TRANSCRIPT',
            speaker: 'agent',
            text: 'Welcome to the Neural Core. Please provide your phone number so I can send your login OTP.',
            isFinal: true
          });
          break;

        case 'SESSION_END':
          console.log('🛑 Session ended by user click');
          agent.resetSession();
          sendEvent({ type: 'STATE_CHANGE', state: 'idle' });
          break;

        case 'USER_SPEECH':
          console.log(`🎤 Received user speech: "${message.text}"`);
          if (message.text && message.text.trim()) {
            await agent.processUserTurn({ text: message.text.trim() }, callbacks);
          }
          break;

        case 'AUDIO_CHUNK':
          if (message.audioBase64) {
            await agent.processUserTurn(
              { audioBase64: message.audioBase64, mimeType: message.mimeType || 'audio/webm' },
              callbacks
            );
          }
          break;

        default:
          console.log('Unknown message type:', message.type);
      }
    } catch (err: any) {
      console.error('Error handling WebSocket message:', err);
      sendEvent({ type: 'ERROR', error: err.message || 'Error processing request' });
    }
  });

  ws.on('close', () => {
    console.log('🔌 Client disconnected');
  });
});
