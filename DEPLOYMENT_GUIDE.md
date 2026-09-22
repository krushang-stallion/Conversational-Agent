# Neural Sphere 3D Visualization & Conversational Agent
## Deployment & External Web Application Integration Guide

This guide covers two key operational areas:
1. **External Web Application Integration Guide** — How any third-party or main web application passes JWT tokens to launch the 3D Sphere interface.
2. **Deployment Guide** — How to host the 3D Neural Sphere frontend & backend (Render / Vercel).

---

## 🔗 Part 1: External Web Application Integration Guide

### Overview
In the single-JWT architecture, users authenticate inside your primary web application. When a user clicks a button or link to open the **3D Neural Sphere**, your web app redirects them (or opens a modal/tab) passing their active **JWT token** as a URL query parameter.

```
+--------------------------------+           Redirect with JWT           +--------------------------------+
|  Primary Web Application       |  ---------------------------------->  |  3D Sphere Visualization App   |
|  (e.g., https://app.batman.in) |  ?token=eyJhbGciOiJIUzI1...          |  (https://sphere.onrender.com) |
+--------------------------------+                                       +--------------------------------+
                                                                                         |
                                                                              WebSocket SESSION_START
                                                                                         v
                                                                         +--------------------------------+
                                                                         |  Stallion Remote MCP Server    |
                                                                         |  get_user_profile(jwt_token)   |
                                                                         +--------------------------------+
```

---

### Integration Link Format

The frontend parses the token automatically from any of these URL query parameter names:
- `?token=<JWT>` (Recommended)
- `?jwt=<JWT>`
- `?bearer=<JWT>`

#### Example Target URL
```http
https://your-sphere-app.onrender.com/?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

### Code Examples for External Web Applications

#### 1. React / Next.js Button Click Handler
```tsx
import React from 'react';

export function OpenNeuralSphereButton() {
  const handleOpenSphere = () => {
    // 1. Get the authenticated user's JWT from your Auth Context / LocalStorage / Cookie
    const userJwtToken = localStorage.getItem('authToken'); 
    const sphereAppBaseUrl = 'https://your-sphere-app.onrender.com';

    if (!userJwtToken) {
      alert('Please log in first.');
      return;
    }

    // 2. Construct redirect URL with JWT token
    const targetUrl = `${sphereAppBaseUrl}/?token=${encodeURIComponent(userJwtToken)}`;

    // 3. Option A: Redirect current window
    window.location.href = targetUrl;

    // Option B: Open in a new tab
    // window.open(targetUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <button 
      onClick={handleOpenSphere}
      style={{
        padding: '12px 24px',
        backgroundColor: '#00e5ff',
        color: '#070806',
        fontWeight: 'bold',
        border: 'none',
        borderRadius: '8px',
        cursor: 'pointer'
      }}
    >
      🌐 Launch Interactive 3D Sphere Core
    </button>
  );
}
```

#### 2. HTML + Vanilla JavaScript
```html
<!-- In your external web app's HTML page -->
<a id="launch-sphere-btn" href="#" class="btn-neural">
  Launch 3D Sphere Visualization
</a>

<script>
  document.getElementById('launch-sphere-btn').addEventListener('click', function(e) {
    e.preventDefault();
    const token = getCookie('user_session_jwt'); // Your auth token retriever
    const sphereUrl = 'https://your-sphere-app.onrender.com/?token=' + encodeURIComponent(token);
    window.open(sphereUrl, '_blank');
  });
</script>
```

#### 3. Embedding via iFrame (Optional)
If you prefer opening the 3D Sphere directly inside a modal dialog on your web app:
```html
<iframe 
  src="https://your-sphere-app.onrender.com/?token=YOUR_USER_JWT_TOKEN"
  width="100%"
  height="700px"
  style="border: none; border-radius: 16px;"
  allow="microphone"
></iframe>
```
*(Note: Ensure `allow="microphone"` is set on the iframe so the voice recording features function properly).*

---

## 🚀 Part 2: Deployment Guide

### Deployment Options

| Strategy | Recommended For | Hosting Cost | Pros |
| :--- | :--- | :--- | :--- |
| **Option A: Unified Web Service (Recommended)** | MVP / Staging / Production | **Render Free Tier / Paid** | Single URL (`https://your-sphere-app.onrender.com`), built-in static serving, zero CORS or SSL WebSocket issues. |
| **Option B: Separate Frontend & Backend** | Edge Scale | **Vercel + Render** | Frontend on global edge CDN (Vercel), Backend WebSocket server on Render. |

---

### Environment Variables Reference

Configure these in your host platform (e.g., Render Dashboard):

```env
# Server Port
PORT=8080

# Primary LLM Provider: 'openai' or 'gemini'
LLM_PROVIDER=openai

# OpenAI API Key (Paid key for fast tool calling & TTS audio)
OPENAI_API_KEY=sk-proj-your-actual-openai-api-key-here
OPENAI_MODEL=gpt-4o-mini

# Stallion Remote MCP Server SSE Endpoint
REMOTE_MCP_SERVER_URL=https://stallion-mcp-server-test.onrender.com/sse

# Optional: Development Fallback Token if testing without URL params
FALLBACK_JWT_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

### Step-by-Step Option A: Unified Deployment on Render

Render supports Node.js services with HTTP asset serving and WebSocket connections (`wss://`).

#### 1. Connect Repository
1. Push this repository to GitHub.
2. Go to [Render Dashboard](https://dashboard.render.com) $\rightarrow$ **New +** $\rightarrow$ **Web Service**.
3. Connect your GitHub repository.

#### 2. Configure Service Settings
- **Name**: `sphere-neural-agent`
- **Region**: Select closest region
- **Runtime**: `Node`
- **Build Command**:
  ```bash
  npm install --prefix backend && npm install --prefix frontend && npm run build --prefix frontend
  ```
- **Start Command**:
  ```bash
  npm start --prefix backend
  ```
- **Instance Type**: `Free` or `Starter`

#### 3. Set Environment Variables
Under the **Environment** tab, add:
- `LLM_PROVIDER` = `openai`
- `OPENAI_API_KEY` = `sk-your-openai-api-key`
- `OPENAI_MODEL` = `gpt-4o-mini`
- `REMOTE_MCP_SERVER_URL` = `https://stallion-mcp-server-test.onrender.com/sse`

#### 4. Access Live Service
Once deployed, Render provides your URL:
👉 **`https://sphere-neural-agent.onrender.com`**

---

## 🧪 Verification & User Flow Checklist

Once deployed, test your external integration flow:

- [ ] **1. External Redirect**: Click the button in your external web app $\rightarrow$ browser redirects to `https://sphere-neural-agent.onrender.com/?token=<JWT>`.
- [ ] **2. First Click Wake-up**: Click anywhere on the 3D canvas $\rightarrow$ 3 central golden concentric spheres bloom/expand.
- [ ] **3. Single Tool Execution (`get_user_profile`)**: The backend connects to the MCP server passing the JWT, executes `get_user_profile`, and extracts assigned user projects.
- [ ] **4. Project Node Orbiting**: User's projects automatically render as dynamic orbiting 3D nodes around the sphere.
- [ ] **5. Voice Query & MCP Execution**: Speak a question (e.g. *"What are the permissions and drawings for project 194?"*) $\rightarrow$ the AI executes `get_project_permissions(project_id="194", jwt_token=...)`, illuminates the node with a comet laser beam, and speaks the answer in natural voice TTS.
