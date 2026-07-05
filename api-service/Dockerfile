# Start from an official Node.js image
FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json .
RUN npm install

# Copy the rest of the source code
COPY . .

EXPOSE 3001

# Use ES modules (the "type": "module" needs to be set in package.json)
CMD ["node", "src/index.js"]
