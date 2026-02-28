// ============================================================
// SmartChoose — scraper.js
// Hybrid AI extraction engine:
//   Step 1 → Fast HTTP + JSON-LD + meta (1–3s, no browser)
//   Step 2 → Playwright full browser fallback (5–10s)
// ============================================================

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { chromium } = require('playwright');
const { extractFromHtml, BROWSER_EXTRACTORS } = require('./extractors');

// ── Platform registry
const PLATFORM_MAP = {
    'Amazon': ['amazon.in', 'amazon.com', 'amzn.in', 'amzn.to'],
    'Flipkart': ['flipkart.com', 'fkrt.it', 'fkrt.cc', 'dl.flipkart.com'],
    'Meesho': ['meesho.com', 'ltl.sh', 'm.ltl.sh', 'msho.co'],
    'Myntra': ['myntra.com'],
    'Ajio': ['ajio.com'],
    'Tata Cliq': ['tatacliq.com'],
    'Nykaa': ['nykaa.com', 'nykaafashion.com'],
    'Reliance Digital': ['reliancedigital.in'],
    'Croma': ['croma.com'],
    'Snapdeal': ['snapdeal.com'],
    'JioMart': ['jiomart.com'],
};

// Platforms that are JS-heavy SPAs — always need Playwright
const JS_HEAVY = ['Meesho', 'Myntra', 'Ajio', 'Flipkart', 'Nykaa'];

function detectPlatform(url) {
    const u = url.toLowerCase();
    for (const [name, domains] of Object.entries(PLATFORM_MAP)) {
        if (domains.some(d => u.includes(d))) return name;
    }
    return 'Store';
}

// ── Browser-like headers for HTTP fetch
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
};

// ── Simple HTTP fetch with redirect following
function fetchHtml(url, maxRedirects = 8) {
    return new Promise((resolve) => {
        let redirects = 0;

        function doFetch(currentUrl) {
            let parsed;
            try { parsed = new URL(currentUrl); } catch { return resolve({ html: '', finalUrl: currentUrl }); }

            const lib = parsed.protocol === 'https:' ? https : http;
            const req = lib.request({
                hostname: parsed.hostname,
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: { ...BROWSER_HEADERS, Host: parsed.hostname, Referer: `https://${parsed.hostname}/` },
                timeout: 12000,
            }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    if (redirects++ >= maxRedirects) return resolve({ html: '', finalUrl: currentUrl });
                    const next = res.headers.location.startsWith('http')
                        ? res.headers.location
                        : `${parsed.protocol}//${parsed.hostname}${res.headers.location}`;
                    res.resume();
                    return doFetch(next);
                }

                let html = '';
                res.setEncoding('utf8');
                res.on('data', c => { html += c; if (html.length > 500000) res.destroy(); });
                res.on('end', () => resolve({ html, finalUrl: currentUrl, status: res.statusCode }));
            });

            req.on('timeout', () => { req.destroy(); resolve({ html: '', finalUrl: currentUrl }); });
            req.on('error', () => resolve({ html: '', finalUrl: currentUrl }));
            req.end();
        }

        doFetch(url);
    });
}

// ── Check if extracted data is complete enough to use
function isDataGood(data) {
    return !!(
        data.title && data.title.length > 8 &&
        !['online shopping', 'shop online', 'access denied', 'robot check', 'just a moment', 'captcha']
            .some(b => data.title.toLowerCase().includes(b))
    );
}

// ── STEP 2: Playwright full-browser extraction
async function extractWithPlaywright(url, platform) {
    console.log(`[PLAYWRIGHT] Launching for: ${platform} → ${url}`);

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-web-security',
        ],
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            extraHTTPHeaders: {
                'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
            },
            locale: 'en-IN',
        });

        // Anti-detection: hide webdriver flag
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });

        const page = await context.newPage();

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        } catch (_) {
            // Some pages throw on navigation but still render — continue
        }

        // Wait for dynamic content to load
        await page.waitForTimeout(4000);

        const finalUrl = page.url();

        // Check for CAPTCHA
        const captchaDetected = await page.evaluate(() => {
            const html = document.body?.innerHTML || '';
            return ['Robot Check', 'Enter the characters you see', 'CAPTCHA', 'bot verification']
                .some(s => html.includes(s));
        });

        if (captchaDetected) {
            console.warn('[PLAYWRIGHT] CAPTCHA detected — attempting to extract partial data');
        }

        // Get full rendered HTML for extraction
        const html = await page.content();

        // Get Next.js data (Flipkart, Meesho, etc.)
        const nextData = await page.evaluate(() => {
            try { return window.__NEXT_DATA__ ? JSON.stringify(window.__NEXT_DATA__) : null; } catch { return null; }
        }).catch(() => null);

        // Run platform-specific in-browser extractor directly in the DOM
        const extractorCode = BROWSER_EXTRACTORS[platform] || BROWSER_EXTRACTORS['default'];
        let domData = {};
        try {
            domData = await page.evaluate(new Function(`return ${extractorCode}`));
        } catch (e) {
            console.warn('[PLAYWRIGHT] DOM extractor error:', e.message);
        }

        await browser.close();

        // Parse HTML with JSON-LD / meta fallback
        const htmlData = extractFromHtml(html, finalUrl, platform, nextData);

        // Merge: DOM extractor takes priority (fresher, JS-rendered), HTML parser fills gaps
        const merged = {
            title: domData.title || htmlData.title || '',
            price: domData.price || htmlData.price || '',
            originalPrice: domData.originalPrice || htmlData.originalPrice || '',
            description: domData.description || htmlData.description || '',
            brand: domData.brand || htmlData.brand || '',
            rating: domData.rating || htmlData.rating || '',
            reviews: String(domData.reviews || htmlData.reviews || ''),
            image: domData.image || (domData.images?.[0]) || htmlData.image || '',
            images: domData.images?.length ? domData.images : (htmlData.images?.length ? htmlData.images : []),
            discount: htmlData.discount || '',
            category: htmlData.category || '',
        };

        return { data: merged, finalUrl, fromPlaywright: true, captchaDetected };

    } catch (err) {
        await browser.close();
        throw err;
    }
}

// ── MAIN: Hybrid scraper
async function scrapeProduct(inputUrl) {
    let resolvedUrl = inputUrl;
    let platform = detectPlatform(inputUrl);

    // ── STEP 1: Fast HTTP extraction (skip for known JS-heavy platforms)
    if (!JS_HEAVY.includes(platform)) {
        console.log(`[STEP1] Fast HTTP extraction for: ${platform}`);
        const { html, finalUrl } = await fetchHtml(inputUrl);
        if (finalUrl && finalUrl !== inputUrl) {
            resolvedUrl = finalUrl;
            if (platform === 'Store') platform = detectPlatform(finalUrl);
        }

        if (html) {
            const data = extractFromHtml(html, resolvedUrl, platform, null);
            if (isDataGood(data)) {
                console.log(`[STEP1] Success! Title: "${data.title?.substring(0, 50)}"`);
                return buildResponse(data, resolvedUrl, inputUrl, platform, false);
            }
        }
        console.log(`[STEP1] Insufficient data, falling back to Playwright`);
    } else {
        // For JS-heavy sites, first resolve the URL to get the real product URL
        console.log(`[STEP1] JS-heavy platform (${platform}), resolving URL first`);
        const { finalUrl } = await fetchHtml(inputUrl);
        if (finalUrl && finalUrl !== inputUrl) {
            resolvedUrl = finalUrl;
            if (platform === 'Store') platform = detectPlatform(finalUrl);
        }
    }

    // ── STEP 2: Playwright browser extraction
    const { data, finalUrl, captchaDetected } = await extractWithPlaywright(resolvedUrl, platform);

    return buildResponse(data, finalUrl || resolvedUrl, inputUrl, platform, true, captchaDetected);
}

function buildResponse(data, finalUrl, originalUrl, platform, usedPlaywright, captchaDetected = false) {
    const titleEmpty = !data.title || data.title.length < 5;
    return {
        success: true,
        finalUrl,
        originalUrl,
        platform,
        blocked: titleEmpty,
        captchaDetected: captchaDetected || false,
        usedPlaywright,
        data: {
            title: data.title || '',
            description: data.description || '',
            image: data.image || '',
            price: data.price || '',
            originalPrice: data.originalPrice || '',
            discount: data.discount || '',
            brand: data.brand || '',
            rating: data.rating || '',
            reviews: data.reviews || '',
            platform: platform,
        },
    };
}

module.exports = { scrapeProduct };
