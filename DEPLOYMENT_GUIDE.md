# Neural Sphere Agent - Free MVP/POC Deployment Guide

This guide walks you through deploying the **3D Neural Sphere Visualization & Conversational Voice Agent** for **100% free hosting** (using Render / Vercel free tiers), connecting your paid **OpenAI API Key** for real-time LLM reasoning, voice synthesis, and remote MCP tool execution.

---

## 1. Deployment Topology: Unified vs. Separate

For a POC/MVP project, there are two deployment strategies:

| Strategy | Recommended For | Hosting Cost | Pros |
| :--- | :--- | :--- | :--- |
| **Option A: Unified Single Service (Recommended)** | MVP / POC Testing | **100% FREE (Render)** | One URL (`https://your-agent.onrender.com`), single deployment, zero WebSocket CORS or SSL port conflicts. |
| **Option B: Separate Frontend & Backend** | Production Scale | **100% FREE (Vercel + Render)** | Frontend on global edge CDN (Vercel), Backend on Render. Requires configuring `VITE_WS_URL`. |

---

## 2. Setting Up Your OpenAI API Key

To enable ultra-fast `< 400ms` tool calling and natural voice responses:

In your environment variables (or `.env` file):

```env
# Server Port (Render sets this automatically)
PORT=8080

# Primary LLM Provider: Set to 'openai'
LLM_PROVIDER=openai

# Your OpenAI API Key (Paid key with access to GPT-4o / GPT-4o-mini)
OPENAI_API_KEY=sk-proj-your-actual-openai-api-key-here

# Preferred Model (gpt-4o-mini is lightning fast for tool calling, gpt-4o for complex reasoning)
OPENAI_MODEL=gpt-4o-mini

# Remote MCP Server SSE Endpoint (Already deployed)
REMOTE_MCP_SERVER_URL=https://stallion-mcp-server-test.onrender.com/sse
```

---

## 3. Option A: 1-Click Unified Deployment on Render (Recommended)

Render offers a **Free Web Service** tier that supports both HTTP and WebSockets over secure TLS (`https://` and `wss://`).

### Step 1: Push your Code to GitHub
Push your repository to GitHub (ensure `.env` is in `.gitignore`).

### Step 2: Create a Web Service on Render
1. Go to [Render Dashboard](https://dashboard.render.com) and click **New + $\rightarrow$ Web Service**.
2. Connect your GitHub repository.
3. Configure the service settings:
   - **Name**: `sphere-neural-agent`
   - **Runtime**: `Node`
   - **Build Command**:
     ```bash
     npm install --prefix backend && npm install --prefix frontend && npm run build --prefix frontend
     ```
   - **Start Command**:
     ```bash
     npm start --prefix backend
     ```
   - **Instance Type**: `Free`

### Step 3: Add Environment Variables in Render
Under the **Environment** tab on Render, add:

| Key | Value |
| :--- | :--- |
| `LLM_PROVIDER` | `openai` |
| `OPENAI_API_KEY` | `sk-your-openai-api-key` |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `REMOTE_MCP_SERVER_URL` | `https://stallion-mcp-server-test.onrender.com/sse` |

### Step 4: Access your Live App
Once built (takes ~2 minutes), Render will provide your public URL:
👉 **`https://sphere-neural-agent.onrender.com`**

- Visiting this URL opens the 3D Neural Sphere interface.
- WebSockets connect securely via `wss://sphere-neural-agent.onrender.com`.

---

## 4. Option B: Separate Deployment (Vercel Frontend + Render Backend)

If you prefer deploying the frontend and backend on independent platforms:

### Step 1: Deploy Backend on Render (Web Service)
1. **Root Directory**: `backend`
2. **Build Command**: `npm install`
3. **Start Command**: `npm start`
4. Add environment variables: `LLM_PROVIDER`, `OPENAI_API_KEY`, `REMOTE_MCP_SERVER_URL`.
5. Note your backend URL (e.g., `https://sphere-backend.onrender.com`).

### Step 2: Deploy Frontend on Vercel
1. Go to [Vercel Dashboard](https://vercel.com) $\rightarrow$ **Add New Project**.
2. **Root Directory**: `frontend`
3. **Build Command**: `npm run build`
4. **Output Directory**: `dist`
5. **Environment Variables**:
   - `VITE_WS_URL`: `wss://sphere-backend.onrender.com`
6. Click **Deploy**.

---

## 5. Verification & Testing Checklist

Once deployed, open your live URL and test the complete conversational flow:

- [ ] **Stage 1 (Click #1 Wake-up)**: Click the screen $\rightarrow$ The 3 central golden spheres expand.
- [ ] **Voice Prompt**: Agent welcomes you and asks for your phone number.
- [ ] **OTP Authentication**: Speak your phone number $\rightarrow$ Agent asks for OTP $\rightarrow$ Speak OTP.
- [ ] **Stage 2 Expansion (Dynamic Projects)**: Once authenticated, agent automatically calls `get_user_projects` via MCP and blooms **your actual projects as 3D orbiting nodes around the sphere**.
- [ ] **Tool Calling**: Ask *"Can you list all permissions for Sharda project?"* $\rightarrow$ The *Sharda Project* node illuminates in 3D and the agent answers in natural voice.
