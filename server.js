const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = 3000;

// ── Mapping ticker → Yahoo Finance symbol ──────────────────────────────────
// Les tickers US n'ont pas de suffixe, les autres sont auto-détectés
const YAHOO_MAP = {
  // Actions US
  INTC:'INTC', LEG:'LEG', MPT:'MPT', MSFT:'MSFT',
  SWK:'SWK', UGI:'UGI', VFC:'VFC', GOOGL:'GOOGL',
  V:'V', MA:'MA', AAPL:'AAPL', AMZN:'AMZN',
  O:'O', NKE:'NKE', ACN:'ACN', ADBE:'ADBE',
  CRM:'CRM', PFE:'PFE', ZTS:'ZTS', AMAT:'AMAT', HE:'HE',
  // Indices (Google Finance .INX → Yahoo ^GSPC, etc.)
  INX:'^GSPC', GSPC:'^GSPC',       // S&P 500
  IXIC:'^IXIC', COMP:'^IXIC',      // Nasdaq Composite
  PX1:'^FCHI', FCHI:'^FCHI',       // CAC 40
  DJI:'^DJI', DJIA:'^DJI',         // Dow Jones
  GDAXI:'^GDAXI', DAX:'^GDAXI',    // DAX
  FTSE:'^FTSE',                     // FTSE 100
  VIX:'^VIX',                       // VIX Volatilité
  // Crypto
  BTC:'BTC-USD', ETH:'ETH-USD', TAO:'TAO-USD',
  // Matières premières & Forex
  BZF:'BZ=F', BRENT:'BZ=F',          // Pétrole Brent
  EURUSDX:'EURUSD=X', EURUSD:'EURUSD=X', // EUR/USD
};

// ── Résolution automatique du symbol Yahoo ─────────────────────────────────
// Si le ticker est dans YAHOO_MAP → utilise la valeur
// Sinon → essaie TICKER.PA (Euronext Paris) en premier, puis TICKER seul
async function resolveSymbol(ticker) {
  if (YAHOO_MAP[ticker]) return YAHOO_MAP[ticker];
  // Essai .PA d'abord (Euronext Paris)
  try {
    await fetchYahoo(ticker + '.PA', '5d', '1d');
    return ticker + '.PA';
  } catch(_) {}
  // Fallback : ticker brut (US ou autre)
  return ticker;
}

// ── Fetch OHLCV from Yahoo Finance ─────────────────────────────────────────
function fetchYahoo(symbol, range = 'max', interval = '1mo') {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}&includePrePost=false`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };
    const req = https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        const newUrl = res.headers.location;
        https.get(newUrl, options, handleResponse).on('error', reject);
        return;
      }
      handleResponse(res);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });

    function handleResponse(res) {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json   = JSON.parse(raw);
          const result = json.chart.result[0];
          const ts     = result.timestamp;
          const q      = result.indicators.quote[0];

          const candles = ts.map((t, i) => ({
            time:   new Date(t * 1000).toISOString().split('T')[0],
            open:   q.open[i]   != null ? Math.round(q.open[i]   * 100) / 100 : null,
            high:   q.high[i]   != null ? Math.round(q.high[i]   * 100) / 100 : null,
            low:    q.low[i]    != null ? Math.round(q.low[i]    * 100) / 100 : null,
            close:  q.close[i]  != null ? Math.round(q.close[i]  * 100) / 100 : null,
            volume: q.volume[i] != null ? q.volume[i] : 0,
          })).filter(c => c.open && c.high && c.low && c.close);

          resolve(candles);
        } catch (e) {
          reject(new Error('Parse error: ' + e.message));
        }
      });
    }
  });
}

// ── Fetch one quote via v8/chart (1d range, 1d interval) ──────────────────
function fetchOneQuote(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d&includePrePost=false`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };
    const req = https.get(url, options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const r = json.chart.result[0];
          const meta = r.meta;
          const q = r.indicators.quote[0];
          const last = q.close.filter(Boolean);
          const prev = last.length >= 2 ? last[last.length - 2] : meta.previousClose || last[0];
          const price = meta.regularMarketPrice || last[last.length - 1];
          const change = price - prev;
          const changePct = (change / prev) * 100;
          resolve({
            symbol,
            regularMarketPrice: Math.round(price * 100) / 100,
            regularMarketChange: Math.round(change * 100) / 100,
            regularMarketChangePercent: Math.round(changePct * 100) / 100,
            regularMarketOpen: q.open[q.open.length - 1],
            regularMarketDayHigh: q.high[q.high.length - 1],
            regularMarketDayLow: q.low[q.low.length - 1],
            regularMarketVolume: q.volume[q.volume.length - 1],
            currency: meta.currency,
            shortName: meta.shortName || symbol,
          });
        } catch (e) { reject(new Error('Parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Fetch quotes for multiple symbols in parallel ─────────────────────────
async function fetchQuotes(symbols) {
  const results = await Promise.allSettled(symbols.map(fetchOneQuote));
  return results.filter(r => r.status === 'fulfilled').map(r => r.value);
}

// ── HTTP Server ────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // ── API: /api/quotes?tickers=TTE,AAPL,MSFT ──
  if (req.url.startsWith('/api/quotes')) {
    const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
    const params = new URLSearchParams(qs);
    const raw = (params.get('tickers') || '').toUpperCase();
    const tickers = raw.split(',').filter(Boolean);
    const symbols = await Promise.all(tickers.map(t => resolveSymbol(t)));

    console.log(`[API] Quotes for: ${symbols.join(', ')}`);
    try {
      const quotes = await fetchQuotes(symbols);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(quotes));
    } catch (e) {
      console.error('[API] Quotes error:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: /api/history?ticker=TTE ──
  if (req.url.startsWith('/api/history')) {
    const qs     = req.url.includes('?') ? req.url.split('?')[1] : '';
    const params = new URLSearchParams(qs);
    const ticker = (params.get('ticker') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (!ticker) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ticker' }));
      return;
    }

    try {
      const symbol   = await resolveSymbol(ticker);
      const range    = params.get('range')    || 'max';
      const interval = params.get('interval') || '1mo';
      console.log(`[API] Fetching ${symbol} (${ticker}) range=${range} interval=${interval} …`);
      const candles = await fetchYahoo(symbol, range, interval);
      console.log(`[API] ${symbol} → ${candles.length} candles`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ symbol, ticker, candles }));
    } catch (e) {
      console.error(`[API] Error for ${ticker}:`, e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: /api/news?ticker=TTE ──
  if (req.url.startsWith('/api/news')) {
    const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
    const ticker = new URLSearchParams(qs).get('ticker') || '';
    const symbol = await resolveSymbol(ticker.toUpperCase());
    try {
      const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=6&quotesCount=0&enableFuzzyQuery=false`;
      const data = await new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
          let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
      const news = (data.news || []).map(n => ({ title: n.title, url: n.link, publisher: n.publisher, time: n.providerPublishTime }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(news));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  // ── API: /api/fundamentals?ticker=TTE ──
  if (req.url.startsWith('/api/fundamentals')) {
    const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
    const ticker = new URLSearchParams(qs).get('ticker') || '';
    const symbol = await resolveSymbol(ticker.toUpperCase());
    try {
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=summaryDetail,defaultKeyStatistics,price`;
      const data = await new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
          let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
      const r = data.quoteSummary?.result?.[0] || {};
      const sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, pr = r.price || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        pe: sd.trailingPE?.raw || ks.trailingPE?.raw || null,
        forwardPe: sd.forwardPE?.raw || null,
        divYield: sd.dividendYield?.raw ? (sd.dividendYield.raw * 100).toFixed(2) : null,
        marketCap: pr.marketCap?.raw || null,
        beta: sd.beta?.raw || null,
        eps: ks.trailingEps?.raw || null,
        fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh?.raw || null,
        fiftyTwoWeekLow: sd.fiftyTwoWeekLow?.raw || null,
        avgVolume: sd.averageVolume?.raw || null,
      }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
    return;
  }

  // ── Static files ──
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  const ext  = path.extname(filePath);
  const mime = {
    '.html': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.json': 'application/json',
    '.png': 'image/png', '.ico': 'image/x-icon',
  }[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`LinReg Dashboard → http://localhost:${PORT}`);
});
