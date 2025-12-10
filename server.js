const express = require("express");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add CORS headers for n8n
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Import scraper functions
function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

async function maybeExpand(page) {
  // Try to expand truncated text ("…more")
  const candidates = [
    'button[data-feed-action="see-more-post"]',
    'button[data-feed-action="expandCommentaryText"]',
    'button:has-text("…more")',
    'button:has-text("See more")',
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 2000 }).catch(() => {});
      break;
    }
  }
}

async function extractFromArticle(page) {
  // Try to scope to the main article (single-post pages usually have one)
  const article = page.locator("article").first();

  // TEXT - Try multiple selectors to get just the main post content, not comments
  let text = "";

  // Try different selectors for the main post content (based on actual HTML structure)
  const textSelectors = [
    // Most specific: Main post commentary with the exact data-test-id
    'p[data-test-id="main-feed-activity-card__commentary"]',
    // Alternative: attributed-text-segment-list content in main activity card
    "div.main-feed-activity-card p.attributed-text-segment-list__content",
    // Broader: any attributed-text-segment-list content not in comments
    'article p.attributed-text-segment-list__content:not([class*="comment"])',
    // Fallback: just the first attributed-text-segment-list content
    "article p.attributed-text-segment-list__content:first-of-type",
  ];

  for (const selector of textSelectors) {
    try {
      const textParts = await article.locator(selector).allTextContents();
      if (textParts.length > 0) {
        text = textParts
          .map((s) => s.trim())
          .filter(Boolean)
          .join("\n\n");

        // If we found content and it's not too long (likely just the main post), use it
        if (text && text.length < 2000) {
          break;
        }
        // If it's very long, it probably includes comments, so try the next selector
        if (text && text.length >= 2000) {
          continue;
        }
      }
    } catch (e) {
      continue;
    }
  }

  // If no text found with specific selectors, try a more sophisticated approach
  if (!text) {
    try {
      const mainPostText = await page.$$eval(
        "article p.attributed-text-segment-list__content",
        (elements) => {
          // Filter out elements that are inside comment sections
          const mainPostElements = elements.filter((el) => {
            // Check if this element is inside a comment section
            const commentSection = el.closest(
              'section.comment, .comment__body, [class*="comment"]'
            );
            return !commentSection;
          });

          return mainPostElements
            .map((el) => el.textContent?.trim())
            .filter(Boolean)
            .slice(0, 3) // Take only first 3 paragraphs to avoid comments
            .join("\n\n");
        }
      );

      if (mainPostText) {
        text = mainPostText;
      }
    } catch (e) {
      // Silent fail for API
    }
  }

  // If still too long, take only the first part (likely the original post)
  if (text.length > 2000) {
    const sentences = text.split(/[.!?]+/);
    text = sentences.slice(0, Math.min(5, sentences.length)).join(". ").trim();
    if (
      text &&
      !text.endsWith(".") &&
      !text.endsWith("!") &&
      !text.endsWith("?")
    ) {
      text += ".";
    }
  }

  // IMAGES - Target actual post content images, not profile pics
  const images = await page.$$eval("article img", (imgs) => {
    const postImages = imgs
      .map((i) => {
        // Get src, data-src (for lazy loading), or srcset
        let src = i.getAttribute("src") || i.getAttribute("data-src") || "";

        // If srcset exists, extract the first URL
        const srcset = i.getAttribute("srcset");
        if (srcset && !src) {
          const firstSrc = srcset.split(",")[0]?.trim().split(" ")[0];
          if (firstSrc) src = firstSrc;
        }

        // Check if image is in a comment section by traversing up the DOM
        let isInComment = false;
        let isInMainPost = false;
        let current = i.parentElement;
        let depth = 0;
        while (current && depth < 10) {
          const className = current.className || "";
          const id = current.id || "";

          // Check for comment-related classes/IDs
          if (
            className.includes("comment") ||
            className.includes("comments") ||
            className.includes("commentary") ||
            className.includes("feed-shared-commentary") ||
            className.includes("comments-container") ||
            className.includes("social-actions") ||
            className.includes("comments-list") ||
            id.includes("comment")
          ) {
            isInComment = true;
            break;
          }

          // Check if we're in the main post container
          if (
            className.includes("feed-shared-update-v2") ||
            className.includes("feed-shared-update") ||
            className.includes("main-feed-activity-card") ||
            className.includes("feed-shared-image")
          ) {
            isInMainPost = true;
          }

          current = current.parentElement;
          depth++;
        }

        return {
          src: src,
          w: Number(i.getAttribute("width") || i.naturalWidth || 0),
          h: Number(i.getAttribute("height") || i.naturalHeight || 0),
          classes: i.className || "",
          alt: i.getAttribute("alt") || "",
          parent: i.parentElement?.className || "",
          parentTag: i.parentElement?.tagName || "",
          isInComment: isInComment,
          isInMainPost: isInMainPost,
        };
      })
      .filter((o) => {
        // Exclude comment images first
        if (o.isInComment) return false;
        // Must have a valid src
        if (!o.src) return false;

        // Must be from LinkedIn CDN (check multiple possible domains)
        const isLinkedInCDN =
          o.src.startsWith("https://media.licdn.com/") ||
          o.src.startsWith("https://static.licdn.com/") ||
          o.src.includes("licdn.com");

        if (!isLinkedInCDN) return false;

        // Skip profile pictures (usually small and in specific containers)
        if (o.classes.includes("profile") || o.classes.includes("avatar"))
          return false;
        if (o.parent.includes("profile") || o.parent.includes("avatar"))
          return false;

        // Skip images in author/actor containers (profile pics)
        const isInAuthorContainer =
          o.parent.includes("actor") ||
          o.parent.includes("author") ||
          o.parent.includes("feed-shared-actor");
        if (isInAuthorContainer && (o.w || 0) < 100 && (o.h || 0) < 100) {
          return false;
        }

        // Skip very small images (likely icons/avatars) - but be more lenient
        if ((o.w || 0) < 150 && (o.h || 0) < 150) return false;

        // Look for post content indicators (more inclusive)
        // Prioritize images in the main post container
        const isPostContent =
          o.isInMainPost || // If in main post container, include it
          o.classes.includes("w-full") ||
          o.classes.includes("object-cover") ||
          o.classes.includes("feed-shared-image") ||
          o.parent.includes("feed-images") ||
          o.parent.includes("feed-shared-image") ||
          o.parent.includes("media") ||
          o.parent.includes("image") ||
          o.parentTag === "FIGURE" ||
          o.alt.includes("graphical") ||
          o.alt.includes("application") ||
          o.alt.includes("PowerPoint") ||
          o.alt.includes("image") ||
          o.alt.includes("screenshot") ||
          // If it's reasonably large and not in a profile container, include it
          (o.w || 0) >= 300 ||
          (o.h || 0) >= 300;

        return isPostContent;
      })
      .map((o) => o.src);

    return postImages;
  });

  // VIDEOS
  // 1) Parse data-sources JSON on <video>
  const videoFromDataSources = await page.$$eval("article video", (vids) => {
    const out = [];
    for (const v of vids) {
      const ds = v.getAttribute("data-sources");
      if (ds) {
        try {
          const arr = JSON.parse(ds);
          for (const s of arr) if (s && s.src) out.push(s.src);
        } catch {}
      }
      // also collect <source> tags
      v.querySelectorAll("source[src]").forEach((s) =>
        out.push(s.getAttribute("src"))
      );
    }
    return out;
  });

  // 2) Fallback: sometimes a wrapper div holds data-sources
  const videoFromWrapper = await page.$$eval(
    "article [data-sources]",
    (nodes) => {
      const links = [];
      for (const n of nodes) {
        const ds = n.getAttribute("data-sources");
        if (!ds) continue;
        try {
          const arr = JSON.parse(ds);
          for (const s of arr) if (s && s.src) links.push(s.src);
        } catch {}
      }
      return links;
    }
  );

  return {
    text: text || null,
    images: uniq(images),
    videos: uniq([...videoFromDataSources, ...videoFromWrapper]),
  };
}

async function scrapeLinkedInPost(url, liAtCookie = null) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  });

  // Optional auth via LI_AT cookie (only if needed)
  if (liAtCookie) {
    await context.addCookies([
      {
        name: "li_at",
        value: liAtCookie,
        domain: ".linkedin.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
  }

  const page = await context.newPage();

  // Load post with more forgiving wait condition
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    // Try with even more basic loading
    try {
      await page.goto(url, { timeout: 15000 });
    } catch (fallbackError) {
      await browser.close();
      throw new Error(`Failed to load page: ${fallbackError.message}`);
    }
  }

  // Give LinkedIn's JS a moment to hydrate
  await page.waitForTimeout(3000).catch(() => {});

  // Wait for content to appear
  try {
    await page.waitForSelector("article", { timeout: 10000 });
  } catch (error) {
    // Continue anyway, might still work
  }

  await maybeExpand(page);

  // Extract
  const result = await extractFromArticle(page);

  await browser.close();
  return result;
}

// API Routes

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Main scraping endpoint
app.post("/scrape", async (req, res) => {
  try {
    const { url, li_at } = req.body;

    if (!url) {
      return res.status(400).json({
        error: "Missing required parameter: url",
        example: { url: "https://www.linkedin.com/posts/..." },
      });
    }

    // Validate URL format
    if (!url.includes("linkedin.com/posts/")) {
      return res.status(400).json({
        error: "Invalid LinkedIn post URL",
        expected: 'URL should contain "linkedin.com/posts/"',
      });
    }

    const result = await scrapeLinkedInPost(url, li_at);

    res.json({
      success: true,
      data: result,
      scraped_at: new Date().toISOString(),
      url: url,
    });
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// GET endpoint for simple URL parameter
app.get("/scrape", async (req, res) => {
  try {
    const { url, li_at } = req.query;

    if (!url) {
      return res.status(400).json({
        error: "Missing required parameter: url",
        example: "/scrape?url=https://www.linkedin.com/posts/...",
      });
    }

    // Validate URL format
    if (!url.includes("linkedin.com/posts/")) {
      return res.status(400).json({
        error: "Invalid LinkedIn post URL",
        expected: 'URL should contain "linkedin.com/posts/"',
      });
    }

    const result = await scrapeLinkedInPost(url, li_at);

    res.json({
      success: true,
      data: result,
      scraped_at: new Date().toISOString(),
      url: url,
    });
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Batch scraping endpoint
app.post("/scrape/batch", async (req, res) => {
  try {
    const { urls, li_at } = req.body;

    if (!urls || !Array.isArray(urls)) {
      return res.status(400).json({
        error: "Missing required parameter: urls (array)",
        example: {
          urls: [
            "https://www.linkedin.com/posts/...",
            "https://www.linkedin.com/posts/...",
          ],
        },
      });
    }

    if (urls.length > 10) {
      return res.status(400).json({
        error: "Too many URLs. Maximum 10 URLs per batch request.",
      });
    }

    const results = [];

    for (const url of urls) {
      try {
        if (!url.includes("linkedin.com/posts/")) {
          results.push({
            url: url,
            success: false,
            error: "Invalid LinkedIn post URL",
          });
          continue;
        }

        const result = await scrapeLinkedInPost(url, li_at);
        results.push({
          url: url,
          success: true,
          data: result,
        });
      } catch (error) {
        results.push({
          url: url,
          success: false,
          error: error.message,
        });
      }
    }

    res.json({
      success: true,
      results: results,
      scraped_at: new Date().toISOString(),
      total_urls: urls.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    });
  } catch (error) {
    console.error("Batch scraping error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`LinkedIn Scraper API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Scrape endpoint: http://localhost:${PORT}/scrape`);
  console.log(
    `Example: curl -X POST http://localhost:${PORT}/scrape -H "Content-Type: application/json" -d '{"url":"https://www.linkedin.com/posts/..."}'`
  );
});
