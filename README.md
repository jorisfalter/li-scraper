# LinkedIn Post Scraper API

A REST API for scraping LinkedIn posts, designed for n8n integration.

## Features

- Extract post text content (excluding comments)
- Extract post images (excluding profile pictures)
- Extract post videos
- REST API endpoints for easy integration
- Batch processing support
- Optional LinkedIn authentication via cookie

## Installation

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium
```

## Usage

### Start the Server

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

The server runs on `http://localhost:3000` by default.

### Direct Scraper (CLI)

```bash
# Basic usage
node scraper.js "https://www.linkedin.com/posts/..."

# With LinkedIn authentication
LI_AT=your_cookie node scraper.js "https://www.linkedin.com/posts/..."
```

## API Endpoints

### Health Check

```
GET /health
```

Returns server status.

### Single Post Scraping

#### POST /scrape

```json
{
  "url": "https://www.linkedin.com/posts/...",
  "li_at": "optional_linkedin_cookie"
}
```

#### GET /scrape

```
GET /scrape?url=https://www.linkedin.com/posts/...&li_at=optional_cookie
```

**Response:**

```json
{
  "success": true,
  "data": {
    "text": "Post content text...",
    "images": ["https://media.licdn.com/..."],
    "videos": ["https://dms.licdn.com/..."]
  },
  "scraped_at": "2024-01-01T12:00:00.000Z",
  "url": "https://www.linkedin.com/posts/..."
}
```

### Batch Scraping

#### POST /scrape/batch

```json
{
  "urls": [
    "https://www.linkedin.com/posts/...",
    "https://www.linkedin.com/posts/..."
  ],
  "li_at": "optional_linkedin_cookie"
}
```

**Response:**

```json
{
  "success": true,
  "results": [
    {
      "url": "https://www.linkedin.com/posts/...",
      "success": true,
      "data": { "text": "...", "images": [], "videos": [] }
    }
  ],
  "scraped_at": "2024-01-01T12:00:00.000Z",
  "total_urls": 2,
  "successful": 1,
  "failed": 1
}
```

## n8n Integration

### HTTP Request Node Configuration

1. **Method**: POST
2. **URL**: `http://your-server:3000/scrape`
3. **Headers**:
   - `Content-Type`: `application/json`
4. **Body**:
   ```json
   {
     "url": "{{ $json.linkedin_url }}",
     "li_at": "{{ $vars.linkedin_cookie }}"
   }
   ```

### Example n8n Workflow

```json
{
  "nodes": [
    {
      "name": "LinkedIn Scraper",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "method": "POST",
        "url": "http://localhost:3000/scrape",
        "options": {
          "headers": {
            "Content-Type": "application/json"
          }
        },
        "body": {
          "url": "https://www.linkedin.com/posts/example",
          "li_at": ""
        }
      }
    }
  ]
}
```

## Authentication

For posts that require login, you can provide your LinkedIn `li_at` cookie:

1. Log into LinkedIn in your browser
2. Open Developer Tools → Application → Cookies
3. Find the `li_at` cookie value
4. Pass it in the `li_at` parameter

**⚠️ Security Warning**: Keep your `li_at` cookie secure and never commit it to version control.

## Rate Limiting

- Single requests: No limit
- Batch requests: Maximum 10 URLs per request
- Consider adding delays between requests to avoid being blocked

## Error Handling

The API returns structured error responses:

```json
{
  "success": false,
  "error": "Failed to load page: Timeout",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

Common errors:

- `400`: Invalid URL or missing parameters
- `500`: Scraping failed (page load timeout, blocked by LinkedIn, etc.)

## Environment Variables

- `PORT`: Server port (default: 3000)
- `LI_AT`: Default LinkedIn cookie for all requests

## Docker Support

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
RUN npx playwright install --with-deps chromium
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

## License

MIT
