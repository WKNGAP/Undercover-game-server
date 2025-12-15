FROM node:20-slim AS base

WORKDIR /app

# Install build tools needed for sharp
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --production && npm cache clean --force

COPY . .

# Ensure data folders exist inside the image
RUN mkdir -p data/QuestionLib data/Sections

EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm", "start"]
