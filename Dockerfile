FROM node:20-alpine

# Build deps for sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build && npm prune --production && npm cache clean --force

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 4500
EXPOSE 4510

CMD ["node", "dist/index.js"]
