export type AIState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface ProjectData {
  id: string;
  name: string;
  detail: string;
  hot?: boolean;
}

export interface WSClientCallbacks {
  onStateChange?: (state: AIState) => void;
  onNodeActive?: (nodeModule: string) => void;
  onNodeIdle?: (nodeModule: string) => void;
  onTranscript?: (speaker: 'user' | 'agent', text: string, isFinal: boolean) => void;
  onProjectsLoaded?: (projects: ProjectData[]) => void;
  onAudioStream?: (audioBase64: string) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export class AgentWSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private callbacks: WSClientCallbacks = {};
  private reconnectTimer: any = null;
  private isExplicitlyClosed = false;

  constructor(url?: string) {
    if (url) {
      this.url = url;
    } else if ((import.meta as any).env?.VITE_WS_URL) {
      this.url = (import.meta as any).env.VITE_WS_URL;
    } else {
      const isHttps = window.location.protocol === 'https:';
      const proto = isHttps ? 'wss:' : 'ws:';
      const host = window.location.hostname || 'localhost';
      if (host === 'localhost' || host === '127.0.0.1') {
        this.url = `${proto}//${host}:8080`;
      } else {
        this.url = `${proto}//${window.location.host}`;
      }
    }
  }

  public connect(callbacks: WSClientCallbacks): void {
    this.callbacks = callbacks;
    this.isExplicitlyClosed = false;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('⚡ Connected to Neural Sphere WebSocket Backend');
        if (this.callbacks.onConnectionChange) {
          this.callbacks.onConnectionChange(true);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleIncomingEvent(data);
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
        }
      };

      this.ws.onclose = () => {
        if (this.callbacks.onConnectionChange) {
          this.callbacks.onConnectionChange(false);
        }
        if (!this.isExplicitlyClosed) {
          console.log('WebSocket disconnected, reconnecting in 2s...');
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect(this.callbacks), 2000);
        }
      };

      this.ws.onerror = (err) => {
        console.warn('WebSocket connection error:', err);
      };
    } catch (err) {
      console.warn('Could not initialize WebSocket connection:', err);
    }
  }

  private handleIncomingEvent(data: any): void {
    switch (data.type) {
      case 'STATE_CHANGE':
        if (data.state && this.callbacks.onStateChange) {
          this.callbacks.onStateChange(data.state as AIState);
        }
        break;

      case 'NODE_ACTIVE':
        if (data.nodeModule && this.callbacks.onNodeActive) {
          this.callbacks.onNodeActive(data.nodeModule);
        }
        break;

      case 'NODE_IDLE':
        if (data.nodeModule && this.callbacks.onNodeIdle) {
          this.callbacks.onNodeIdle(data.nodeModule);
        }
        break;

      case 'TRANSCRIPT':
        if (this.callbacks.onTranscript) {
          this.callbacks.onTranscript(data.speaker || 'agent', data.text || '', data.isFinal ?? true);
        }
        break;

      case 'PROJECTS_LOADED':
        if (data.projects && this.callbacks.onProjectsLoaded) {
          this.callbacks.onProjectsLoaded(data.projects);
        }
        break;

      case 'AUDIO_STREAM':
        if (data.audioBase64 && this.callbacks.onAudioStream) {
          this.callbacks.onAudioStream(data.audioBase64);
        }
        break;

      default:
        console.log('Received unhandled event:', data);
    }
  }

  public startSession(token?: string): void {
    this.send({ type: 'SESSION_START', token });
  }

  public endSession(): void {
    this.send({ type: 'SESSION_END' });
  }

  public sendUserSpeech(text: string): void {
    this.send({ type: 'USER_SPEECH', text });
  }

  public sendAudioChunk(audioBase64: string, mimeType = 'audio/webm'): void {
    this.send({ type: 'AUDIO_CHUNK', audioBase64, mimeType });
  }

  private send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      console.warn('Cannot send, WebSocket is not open.');
    }
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
