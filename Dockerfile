FROM node:20-alpine

# Build deps for sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build && npm prune --production && npm cache clean --force

RUN mkdir -p /app/data

EXPOSE 4500
EXPOSE 4510

CMD ["node", "dist/index.js"]
