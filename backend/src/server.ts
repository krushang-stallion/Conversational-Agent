import { WebSocketServer, WebSocket } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

export type AIState = 'idle' | 'thinking' | 'speaking';

export interface UIEvent {
  type: 'STATE_CHANGE' | 'NODE_ACTIVE' | 'NODE_IDLE';
  state?: AIState;
  nodeModule?: string; 
}

console.log('⚡ MCP UI WebSocket server running on ws://localhost:8080');

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected to UI Stream');

  const sendEvent = (event: UIEvent) => {
    ws.send(JSON.stringify(event));
  };

  simulateMCPWorkflow(sendEvent);
});

function simulateMCPWorkflow(send: (event: UIEvent) => void) {
  // Simulating an AI thought process loop
  setInterval(() => {
    // 1. Thinking phase
    send({ type: 'STATE_CHANGE', state: 'thinking' });
    send({ type: 'NODE_ACTIVE', nodeModule: 'knowledge_base' });

    setTimeout(() => {
      // 2. Fetching from database
      send({ type: 'NODE_ACTIVE', nodeModule: 'database' });
    }, 1500);

    setTimeout(() => {
      // 3. Speaking phase
      send({ type: 'NODE_IDLE', nodeModule: 'knowledge_base' });
      send({ type: 'NODE_IDLE', nodeModule: 'database' });
      send({ type: 'STATE_CHANGE', state: 'speaking' });
    }, 3500);

    setTimeout(() => {
      // 4. Idle phase
      send({ type: 'STATE_CHANGE', state: 'idle' });
    }, 8000);
  }, 10000);
}
