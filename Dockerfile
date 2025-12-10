# Use Node 18 with Ubuntu (more reliable for Playwright)
FROM node:18

# Install dependencies for Playwright
RUN apt-get update && apt-get install -y \
    libnss3-dev \
    libatk-bridge2.0-dev \
    libdrm-dev \
    libxkbcommon-dev \
    libxcomposite-dev \
    libxdamage-dev \
    libxrandr-dev \
    libgbm-dev \
    libxss-dev \
    libasound2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Install Playwright and Chromium BEFORE setting env vars
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

# Copy app code
COPY . .

# Set correct environment variables for Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"] 