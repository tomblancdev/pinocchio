# Multi-language Claude Agent Image
# Provides an isolated environment with Claude Code in YOLO mode

FROM ubuntu:24.04

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
RUN npm install -g pnpm && \
    curl -fsSL https://bun.sh/install | bash

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

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

# Add bun to PATH for agent user
ENV PATH="/home/agent/.bun/bin:${PATH}"

# Labels for identification
LABEL org.opencontainers.image.title="Claude Agent"
LABEL org.opencontainers.image.description="Isolated Claude Code agent with YOLO mode"

ENTRYPOINT ["/entrypoint.sh"]
