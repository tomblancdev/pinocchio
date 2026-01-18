# Multi-language Claude Agent Image
# Provides an isolated environment with Claude Code in YOLO mode

# ============================================================================
# Builder stage - compile spawn proxy TypeScript
# ============================================================================
FROM node:20-slim AS builder

# Build spawn proxy
COPY spawn-proxy/package*.json /build/spawn-proxy/
WORKDIR /build/spawn-proxy
RUN npm ci
COPY spawn-proxy/ /build/spawn-proxy/
RUN npm run build

# ============================================================================
# Final stage - runtime environment
# ============================================================================
# Pin to specific digest for reproducible builds
# To update: docker pull ubuntu:24.04 && docker inspect ubuntu:24.04 --format='{{index .RepoDigests 0}}'
FROM ubuntu:24.04@sha256:7a398144c5a2fa7dbd9362e460779dc6659bd9b19df50f724250c62ca7812eb3

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies and multiple language runtimes
RUN apt-get update && apt-get install -y \
    # Core utilities
    curl \
    wget \
    git \
    unzip \
    jq \
    ca-certificates \
    gnupg \
    # Build essentials
    build-essential \
    # Python
    python3 \
    python3-pip \
    python3-venv \
    # Go
    golang-go \
    # Rust (optional, uncomment if needed)
    # rustc \
    # cargo \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh) for GitHub operations
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm and bun (popular package managers)
# Use npm to install bun instead of piping remote script to bash for security
RUN npm install -g pnpm bun

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Copy spawn proxy from builder stage
COPY --from=builder /build/spawn-proxy/dist /opt/pinocchio/spawn-proxy/
COPY --from=builder /build/spawn-proxy/node_modules /opt/pinocchio/spawn-proxy/node_modules/
COPY --from=builder /build/spawn-proxy/package.json /opt/pinocchio/spawn-proxy/

# Create spawn proxy launcher script
RUN echo '#!/bin/sh\nnode /opt/pinocchio/spawn-proxy/index.js "$@"' > /usr/local/bin/spawn-proxy && \
    chmod +x /usr/local/bin/spawn-proxy

# Create non-root user for security
RUN useradd -m -s /bin/bash agent && \
    mkdir -p /workspace && \
    chown -R agent:agent /workspace && \
    # Create .claude directory for mounting credentials
    mkdir -p /home/agent/.claude && \
    chown agent:agent /home/agent/.claude

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Switch to non-root user
USER agent
WORKDIR /workspace

# Bun installed via npm is already in global node_modules bin path
# No additional PATH modification needed

# Labels for identification
LABEL org.opencontainers.image.title="Claude Agent"
LABEL org.opencontainers.image.description="Isolated Claude Code agent with YOLO mode"

ENTRYPOINT ["/entrypoint.sh"]
