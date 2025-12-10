// Usage:
//   node scrape-linkedin-post.js "https://www.linkedin.com/posts/...."
//   LI_AT=your_cookie node scrape-linkedin-post.js "https://www.linkedin.com/posts/...."
//
// Notes:
// - Runs headless (no visible window).
// - If the post requires login, set env var LI_AT with your LinkedIn session cookie.
// - Outputs a JSON object with { text, images, videos }.

const { chromium } = require("playwright");

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

        console.error(`DEBUG: Using selector "${selector}"`);
        console.error(
          `DEBUG: Found ${textParts.length} text parts, total length: ${text.length}`
        );
        console.error(`DEBUG: First 200 chars: ${text.substring(0, 200)}...`);

        // If we found content and it's not too long (likely just the main post), use it
        if (text && text.length < 2000) {
          break;
        }
        // If it's very long, it probably includes comments, so try the next selector
        if (text && text.length >= 2000) {
          console.error(
            `DEBUG: Text too long (${text.length} chars), trying next selector...`
          );
          continue;
        }
      }
    } catch (e) {
      console.error(`DEBUG: Selector "${selector}" failed:`, e.message);
      continue;
    }
  }

  // If no text found with specific selectors, try a more sophisticated approach
  if (!text) {
    console.error("DEBUG: Trying sophisticated comment exclusion approach...");

    // First, let's see what's actually on the page
    try {
      const allTextElements = await page.$$eval(
        'article p, article div[class*="text"], article span[class*="text"]',
        (elements) => {
          return elements
            .map((el) => ({
              tagName: el.tagName,
              className: el.className,
              textContent: el.textContent?.trim().substring(0, 100) || "",
              parentClasses: el.parentElement?.className || "",
            }))
            .filter((item) => item.textContent.length > 0);
        }
      );

      console.error(
        "DEBUG: Found text elements:",
        JSON.stringify(allTextElements.slice(0, 5), null, 2)
      );
    } catch (e) {
      console.error("DEBUG: Failed to analyze page structure:", e.message);
    }

    try {
      const mainPostText = await page.$$eval(
        "article p.attributed-text-segment-list__content",
        (elements) => {
          console.log("Found elements:", elements.length);

          // Filter out elements that are inside comment sections
          const mainPostElements = elements.filter((el) => {
            // Check if this element is inside a comment section
            const commentSection = el.closest(
              'section.comment, .comment__body, [class*="comment"]'
            );
            const isComment = !!commentSection;
            console.log(
              "Element text:",
              el.textContent?.substring(0, 50),
              "Is comment:",
              isComment
            );
            return !commentSection;
          });

          console.log(
            "Main post elements after filtering:",
            mainPostElements.length
          );

          return mainPostElements
            .map((el) => el.textContent?.trim())
            .filter(Boolean)
            .slice(0, 3) // Take only first 3 paragraphs to avoid comments
            .join("\n\n");
        }
      );

      if (mainPostText) {
        text = mainPostText;
        console.error(
          `DEBUG: Sophisticated approach found ${text.length} chars`
        );
      } else {
        console.error(
          "DEBUG: No main post text found even with sophisticated approach"
        );

        // Ultimate fallback - just get any text content
        try {
          const fallbackText = await page.$$eval("article p", (elements) => {
            return elements
              .map((el) => el.textContent?.trim())
              .filter(Boolean)
              .slice(0, 2) // Just first 2 paragraphs
              .join("\n\n");
          });

          if (fallbackText) {
            text = fallbackText;
            console.error(
              `DEBUG: Ultimate fallback found ${text.length} chars`
            );
          }
        } catch (fallbackError) {
          console.error(
            "DEBUG: Ultimate fallback also failed:",
            fallbackError.message
          );
        }
      }
    } catch (e) {
      console.error(`DEBUG: Sophisticated approach failed:`, e.message);
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

  // IMAGES - Simple approach: filter by URL patterns and size
  const imageResult = await page.evaluate(() => {
    const images = [];
    const debug = {
      totalImages: 0,
      licdnImages: 0,
      feedshareImages: 0,
      allImages: [], // Store ALL images for debugging
      filteredOut: [],
      added: []
    };
    
    const mainSection = document.querySelector("main");

    if (!mainSection) {
      return { images: [], debug: { ...debug, error: "No main section found" } };
    }

    const allImages = mainSection.querySelectorAll("img");
    debug.totalImages = allImages.length;

    allImages.forEach((img, idx) => {
      // Get all possible sources
      const src = img.src || "";
      const dataSrc = img.getAttribute("data-src") || "";
      const dataLazySrc = img.getAttribute("data-lazy-src") || "";
      const srcset = img.getAttribute("srcset") || "";
      
      // Try to get the best source URL
      let bestSrc = src || dataSrc || dataLazySrc || "";
      
      // Handle srcset if no other source
      if (!bestSrc && srcset) {
        bestSrc = srcset.split(",")[0]?.trim().split(" ")[0];
      }

      const alt = img.alt || "";
      const className = img.className || "";
      const parentTag = img.parentElement?.tagName || "";
      const parentClass = img.parentElement?.className || "";
      
      // Try to get actual dimensions - naturalWidth/Height are more reliable
      let width = img.naturalWidth || 0;
      let height = img.naturalHeight || 0;
      
      // If natural dimensions not available, try width/height attributes
      if (width === 0) width = img.width || 0;
      if (height === 0) height = img.height || 0;
      
      // If still 0, try to get from computed style
      if (width === 0 || height === 0) {
        const style = window.getComputedStyle(img);
        const styleWidth = parseInt(style.width, 10);
        const styleHeight = parseInt(style.height, 10);
        if (styleWidth > 0) width = styleWidth;
        if (styleHeight > 0) height = styleHeight;
      }

      // Store ALL image info for debugging
      const imageInfo = {
        idx: idx + 1,
        src: bestSrc.substring(0, 150),
        dataSrc: dataSrc.substring(0, 150),
        dataLazySrc: dataLazySrc.substring(0, 150),
        srcset: srcset.substring(0, 100),
        width,
        height,
        alt: alt.substring(0, 50),
        className: className.substring(0, 100),
        parentTag,
        parentClass: parentClass.substring(0, 100),
        hasFeedshare: bestSrc.includes("feedshare"),
        hasMedia: bestSrc.includes("media.licdn.com"),
        hasLicdn: bestSrc.includes("licdn.com")
      };
      
      debug.allImages.push(imageInfo);

      // Check if from LinkedIn CDN
      if (bestSrc && bestSrc.includes("licdn.com")) {
        debug.licdnImages++;
        
        // Check if from media.licdn.com (post images) or has feedshare
        if (bestSrc.includes("media.licdn.com") || bestSrc.includes("feedshare")) {
          debug.feedshareImages++;
        }
      }

      // Filter criteria:
      const hasFeedshare = bestSrc.includes("feedshare");
      const isFromMedia = bestSrc.includes("media.licdn.com");
      const isSmallComment = bestSrc.includes("comment-image") && height < 300;
      
      if (
        bestSrc &&
        bestSrc.includes("licdn.com") &&
        (isFromMedia || hasFeedshare) &&
        !bestSrc.includes("profile-displayphoto") &&
        !bestSrc.includes("displaybackgroundimage") &&
        !bestSrc.includes("/sc/h/") &&
        !bestSrc.includes("/aero-v1/sc/h/") &&
        !(isSmallComment && !hasFeedshare) &&
        width > 200
      ) {
        images.push(bestSrc);
        debug.added.push({ src: bestSrc.substring(0, 150), width, height });
      } else if (bestSrc && bestSrc.includes("licdn.com")) {
        // Debug why image was filtered out
        const reasons = [];
        if (!bestSrc.includes("media.licdn.com") && !bestSrc.includes("feedshare")) reasons.push("not media.licdn.com or feedshare");
        if (bestSrc.includes("profile-displayphoto")) reasons.push("profile pic");
        if (bestSrc.includes("displaybackgroundimage")) reasons.push("background");
        if (bestSrc.includes("/sc/h/") || bestSrc.includes("/aero-v1/sc/h/")) reasons.push("icon");
        if (bestSrc.includes("comment-image") && height < 300) reasons.push("small comment");
        if (width <= 200) reasons.push(`too small (${width}px)`);
        if (reasons.length > 0) {
          debug.filteredOut.push({ 
            reason: reasons.join(", "), 
            src: bestSrc.substring(0, 120),
            width,
            height,
            idx: idx + 1
          });
        }
      }
    });

    return { images: [...new Set(images)], debug };
  });

  const images = imageResult.images;
  
  // Log extensive debug info
  console.error(`\n=== IMAGE EXTRACTION DEBUG ===`);
  console.error(`Total images in main: ${imageResult.debug.totalImages}`);
  console.error(`LinkedIn CDN images: ${imageResult.debug.licdnImages}`);
  console.error(`Images with 'feedshare' or media.licdn.com: ${imageResult.debug.feedshareImages}`);
  console.error(`Images added: ${imageResult.debug.added.length}\n`);
  
  // Show ALL images from media.licdn.com or with feedshare
  const relevantImages = imageResult.debug.allImages.filter(img => 
    (img.hasMedia || img.hasFeedshare) && img.hasLicdn
  );
  
  if (relevantImages.length > 0) {
    console.error(`=== ALL RELEVANT IMAGES (media.licdn.com or feedshare) ===`);
    relevantImages.forEach((img, idx) => {
      console.error(`\nImage #${img.idx}:`);
      console.error(`  src: ${img.src}`);
      if (img.dataSrc) console.error(`  data-src: ${img.dataSrc}`);
      if (img.dataLazySrc) console.error(`  data-lazy-src: ${img.dataLazySrc}`);
      if (img.srcset) console.error(`  srcset: ${img.srcset}`);
      console.error(`  Size: ${img.width}x${img.height}`);
      console.error(`  Alt: ${img.alt || '(none)'}`);
      console.error(`  Class: ${img.className || '(none)'}`);
      console.error(`  Parent: <${img.parentTag}> ${img.parentClass.substring(0, 80)}`);
      console.error(`  Has feedshare: ${img.hasFeedshare}`);
      console.error(`  Has media.licdn.com: ${img.hasMedia}`);
      
      // Check why it's filtered
      const reasons = [];
      if (img.src.includes("profile-displayphoto")) reasons.push("profile pic");
      if (img.src.includes("displaybackgroundimage")) reasons.push("background");
      if (img.src.includes("/sc/h/") || img.src.includes("/aero-v1/sc/h/")) reasons.push("icon");
      if (img.src.includes("comment-image") && img.height < 300) reasons.push("small comment");
      if (img.width <= 200) reasons.push(`too small (${img.width}px)`);
      if (reasons.length > 0) {
        console.error(`  ❌ FILTERED: ${reasons.join(", ")}`);
      } else {
        console.error(`  ✅ WOULD PASS FILTER`);
      }
    });
  }
  
  // Show all filtered out images
  if (imageResult.debug.filteredOut.length > 0) {
    console.error(`\n=== FILTERED OUT IMAGES ===`);
    imageResult.debug.filteredOut.forEach((item, idx) => {
      console.error(`${idx + 1}. [${item.idx}] ${item.reason}`);
      console.error(`   ${item.src}... (${item.width}x${item.height})`);
    });
  }
  
  // Show added images
  if (imageResult.debug.added.length > 0) {
    console.error(`\n=== ADDED IMAGES ===`);
    imageResult.debug.added.forEach((item, idx) => {
      console.error(`${idx + 1}. ${item.src}... (${item.width}x${item.height})`);
    });
  }
  
  // If no images found, show ALL images for debugging
  if (imageResult.debug.added.length === 0 && imageResult.debug.allImages.length > 0) {
    console.error(`\n=== ALL IMAGES (for debugging) ===`);
    imageResult.debug.allImages.slice(0, 10).forEach((img) => {
      console.error(`\nImage #${img.idx}:`);
      console.error(`  src: ${img.src || '(empty)'}`);
      if (img.dataSrc) console.error(`  data-src: ${img.dataSrc}`);
      console.error(`  Size: ${img.width}x${img.height}`);
      console.error(`  Has licdn.com: ${img.hasLicdn}`);
      console.error(`  Has feedshare: ${img.hasFeedshare}`);
      console.error(`  Has media.licdn.com: ${img.hasMedia}`);
    });
    if (imageResult.debug.allImages.length > 10) {
      console.error(`\n... and ${imageResult.debug.allImages.length - 10} more images`);
    }
  }
  
  console.error(`\n=== END DEBUG ===\n`);

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

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.error(
      'Provide a LinkedIn post URL.\nExample: node scrape-linkedin-post.js "https://www.linkedin.com/posts/..."'
    );
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
  });

  // Optional auth via LI_AT cookie (only if needed)
  if (process.env.LI_AT) {
    await context.addCookies([
      {
        name: "li_at",
        value: process.env.LI_AT,
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
    console.error("Failed to load page:", error.message);
    // Try with even more basic loading
    try {
      await page.goto(url, { timeout: 15000 });
    } catch (fallbackError) {
      console.error("Fallback loading also failed:", fallbackError.message);
      await browser.close();
      process.exit(1);
    }
  }

  // Give LinkedIn's JS a moment to hydrate
  await page.waitForTimeout(3000).catch(() => {});

  // Wait for content to appear
  try {
    await page.waitForSelector("main", { timeout: 10000 });
  } catch (error) {
    console.error(
      "No main content found - the post might require authentication"
    );
  }

  await maybeExpand(page);

  // Scroll multiple times to trigger lazy-loaded images
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1000);
  
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight / 3);
  });
  await page.waitForTimeout(1000);
  
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight / 2);
  });
  await page.waitForTimeout(2000); // Wait for images to load
  
  // Try to wait for images to load
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  } catch (e) {}

  // Extract
  const result = await extractFromArticle(page);

  console.log(JSON.stringify(result, null, 2));

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
