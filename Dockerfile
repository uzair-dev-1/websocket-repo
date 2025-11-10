# Use Node.js LTS version
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY websocket-server.js .
COPY sms-service.js .
COPY sms-config.json .

# Expose port
EXPOSE 3001

# Start the application
CMD ["node", "websocket-server.js"]
