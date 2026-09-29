# Runs the vibelore MCP server over stdio (no dependencies, no build step).
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY engine/package.json engine/
COPY engine/src engine/src
COPY src src
ENTRYPOINT ["node", "src/server.js"]
