const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || '';

// Basit auth middleware
function authCheck(req, res, next) {
    if (API_SECRET) {
        const token = req.query.token || req.headers['x-api-token'];
        if (token !== API_SECRET) {
            return res.status(401).json({ error: 'Yetkisiz erisim' });
        }
    }
    next();
}

// Rate limiting (basit in-memory)
const requestLog = {};
function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 dakika
    const maxRequests = 30;

    if (!requestLog[ip]) requestLog[ip] = [];
    requestLog[ip] = requestLog[ip].filter(t => t > now - windowMs);

    if (requestLog[ip].length >= maxRequests) {
        return res.status(429).json({ error: 'Cok fazla istek, 1 dakika bekleyin' });
    }

    requestLog[ip].push(now);
    next();
}

// Ana endpoint: URL redirect takibi
app.get('/resolve', authCheck, rateLimit, async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'url parametresi gerekli' });
    }

    // URL validasyonu
    try {
        new URL(url);
    } catch {
        return res.status(400).json({ error: 'Gecersiz URL' });
    }

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote',
            ],
        });

        const page = await browser.newPage();

        // Gercekci tarayici ayarlari
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        );
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        });
        await page.setViewport({ width: 1920, height: 1080 });

        // Gereksiz kaynaklari engelle (hiz icin)
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const type = request.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        // Tum redirect'leri takip et
        const redirectChain = [url];
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                const currentUrl = frame.url();
                if (currentUrl && currentUrl !== 'about:blank') {
                    redirectChain.push(currentUrl);
                }
            }
        });

        // Sayfayi ac ve JS redirect'lerin tamamlanmasini bekle
        const timeout = parseInt(req.query.timeout) || 30000;
        const waitTime = parseInt(req.query.wait) || 5000;

        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: Math.min(timeout, 60000),
        });

        // Ekstra bekleme (JS redirect'ler icin)
        await new Promise(r => setTimeout(r, Math.min(waitTime, 15000)));

        // Son URL'yi al
        const finalUrl = page.url();

        // Sayfa title'ini al (debug icin)
        const title = await page.title().catch(() => '');

        await browser.close();
        browser = null;

        res.json({
            success: true,
            original_url: url,
            final_url: finalUrl,
            changed: finalUrl !== url,
            title: title,
            redirect_chain: [...new Set(redirectChain)],
        });

    } catch (error) {
        if (browser) await browser.close().catch(() => {});

        res.status(500).json({
            success: false,
            error: error.message,
            original_url: url,
            final_url: url,
        });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'URL Redirect Scraper',
        usage: 'GET /resolve?url=https://example.com',
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Scraper service running on port ${PORT}`);
});
