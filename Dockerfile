# MCP Server Dockerfile
# Builds and runs the Pinocchio MCP server

FROM node:20-slim

WORKDIR /app

# Install docker CLI to communicate with host Docker daemon
RUN apt-get update && apt-get install -y \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Run the MCP server
CMD ["node", "dist/index.js"]
