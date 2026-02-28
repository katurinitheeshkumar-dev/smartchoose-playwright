// ============================================================
// SmartChoose — server.js (updated)
// Matches existing proxy API format so AdminProducts.tsx
// works with zero frontend changes (just swap PROXY_URL)
// ============================================================
const express = require('express');
const { scrapeProduct } = require('./scraper');

const app = express();
app.use(express.json());

// CORS — allow all origins (AdminPanel calls from Firebase Hosting)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

// ── Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'SmartChoose Playwright Agent', time: new Date().toISOString() });
});

// ── Main endpoint — matches existing Vercel proxy format
// GET  /api/fetch-product?url=...
// POST /api/fetch-product  { "url": "..." }
app.all('/api/fetch-product', async (req, res) => {
    const url = req.query.url || req.body?.url;
    if (!url) return res.status(400).json({ success: false, error: 'Missing url parameter' });

    console.log(`[AGENT] Received: ${url}`);

    try {
        const result = await scrapeProduct(decodeURIComponent(url));
        console.log(`[AGENT] Done: ${result.platform} | "${result.data?.title?.substring(0, 50)}"`);
        return res.json(result);
    } catch (err) {
        console.error(`[AGENT ERROR] ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SmartChoose Playwright Agent running on port ${PORT}`));
