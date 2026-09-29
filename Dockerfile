# Multi-stage / Unified Dockerfile for Neural Sphere & Hermes Autonomous Agent
FROM node:20-bookworm-slim

# Prevent interactive prompts during apt installs
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.local/bin:${PATH}"

# Install Python 3, pip, curl, git, and required tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies for IOD document parsing & follow-up engine
RUN pip3 install --no-cache-dir --break-system-packages pypdf requests

# Install Nous Research Hermes Agent CLI
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash || true

# Set working directory
WORKDIR /app

# Copy package manifests first for optimal Docker layer caching
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/

# Install Node dependencies for backend and frontend
RUN npm install --prefix backend && npm install --prefix frontend

# Copy entire project source into container
COPY . .

# Build frontend production bundle into frontend/dist
RUN npm run build --prefix frontend

# Set up Hermes default configuration and skills inside container
RUN mkdir -p /root/.hermes/skills/productivity \
    && cp -r skills/* /root/.hermes/skills/productivity/ 2>/dev/null || true

RUN echo 'model:\n  default: "gpt-4o"\n  provider: "openai"\n  base_url: "https://api.openai.com/v1"\nmcp_servers:\n  stallion:\n    command: npx\n    args:\n      - -y\n      - mcp-remote\n      - https://stallion-mcp-server-test.onrender.com/sse\n    enabled: true\n' > /root/.hermes/config.yaml

# Set runtime environment variables
ENV NODE_ENV=production
ENV PORT=8080
ENV HERMES_BIN=/root/.local/bin/hermes
ENV HERMES_WORKSPACE=/app

# Expose server port
EXPOSE 8080

# Start unified HTTP and WebSocket server
CMD ["npm", "start", "--prefix", "backend"]
