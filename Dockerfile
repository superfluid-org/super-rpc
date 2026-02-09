FROM node:18-alpine

# Install build dependencies for sqlite3/python
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for build step if needed, or just production if pre-built)
# Since we have a 'build' script (tsc), we need devDependencies to build, then we can prune.
# For simplicity in this plan, we'll install all, build, then prune.
RUN npm install

# Copy source
COPY . .

# Build the application
RUN npm run build

# Prune dev dependencies (optional, but good for image size)
RUN npm prune --production

# Expose the port
EXPOSE 4500

# Start the application
CMD ["npm", "start"]
