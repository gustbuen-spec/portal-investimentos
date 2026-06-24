// Cloudflare Worker — Portal Investimento v3.1
// Debug: logs detalhados para diagnosticar falhas Finnhub

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Content-Type': 'application/json',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'quotes';
    const key = env.FINNHUB_KEY;
    const tdKey = env.TWELVEDATA_KEY;

    if (!key) {
      return new Response(JSON.stringify({ error: 'FINNHUB_KEY not set' }), { status: 500, headers: cors });
    }

    try {
      let result;
      switch (action) {

        case 'quotes': {
          const symbols = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
          result = await fetchQuotes(symbols, key, tdKey);
          break;
        }

        case 'candle': {
          const sym = url.searchParams.get('symbol') || '';
          const res = url.searchParams.get('resolution') || 'D';
          const days = parseInt(url.searchParams.get('days') || '90');
          result = await fetchCandleChart(sym, res, days, key);
          break;
        }

        case 'signal': {
          const sym = url.searchParams.get('symbol') || '';
          const res = url.searchParams.get('resolution') || 'D';
          result = await fetchSignal(sym, res, key);
          break;
        }

        case 'forex-rates': {
          const base = url.searchParams.get('base') || 'USD';
          const res = await fetch(`https://finnhub.io/api/v1/forex/rates?base=${base}&token=${key}`);
          const d = await res.json();
          result = { base: d.base, quote: d.quote, _ts: Date.now() };
          break;
        }

        case 'yield-curve': {
          const code = url.searchParams.get('code') || 'US';
          const res = await fetch(`https://finnhub.io/api/v1/bond/yield-curve?code=${code}&token=${key}`, {
            headers: { 'User-Agent': 'PortalInvestimento/3.0' }
          });
          if (!res.ok) return new Response(JSON.stringify({ error: `Yield curve ${res.status}`, status: res.status }), { status: 200, headers: cors });
          const d = await res.json();
          result = { code, data: d.data?.slice(-2), _ts: Date.now() };
          break;
        }

        case 'economic-calendar': {
          const today = new Date();
          const from = today.toISOString().split('T')[0];
          const to = new Date(today.getTime() + 7 * 86400000).toISOString().split('T')[0];
          const res = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${key}`, {
            headers: { 'User-Agent': 'PortalInvestimento/3.0' }
          });
          if (!res.ok) return new Response(JSON.stringify({ error: `Calendar ${res.status}`, events: [] }), { status: 200, headers: cors });
          const d = await res.json();
          const events = (d.economicCalendar || [])
            .filter(e => e.impact === 'high' || e.impact === 'medium')
            .slice(0, 10);
          result = { events, _ts: Date.now() };
          break;
        }

        case 'news': {
          const category = url.searchParams.get('category') || 'general';
          const res = await fetch(`https://finnhub.io/api/v1/news?category=${category}&token=${key}`, {
            headers: { 'User-Agent': 'PortalInvestimento/3.0' }
          });
          if (!res.ok) return new Response(JSON.stringify({ error: `News ${res.status}`, news: [] }), { status: 200, headers: cors });
          const d = await res.json();
          result = {
            news: (d || []).slice(0, 8).map(n => ({
              headline: n.headline,
              source: n.source,
              url: n.url,
              datetime: n.datetime,
            })),
            _ts: Date.now()
          };
          break;
        }

        // Diagnóstico — testa a chave directamente
        case 'ping': {
          const res = await fetch(`https://finnhub.io/api/v1/forex/rates?base=USD&token=${key}`);
          const text = await res.text();
          result = { 
            status: res.status, 
            ok: res.ok, 
            preview: text.slice(0, 200),
            key_prefix: key.slice(0, 4) + '...',
          };
          break;
        }

        default:
          result = { error: `Unknown action: ${action}` };
      }

      return new Response(JSON.stringify(result), { headers: cors });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 200) }), { status: 502, headers: cors });
    }
  },
};

// ════════════════════════════════════════════════════════
// FETCH QUOTES
// Tenta forex/candle para símbolos com ':' (OANDA/Pepperstone)
// Tenta quote para stocks normais
// Fallback: Twelve Data
// ════════════════════════════════════════════════════════
async function fetchQuotes(symbols, key, tdKey) {
  const forexSyms = symbols.filter(s => s.includes(':'));
  const stockSyms = symbols.filter(s => !s.includes(':'));

  const now = Math.floor(Date.now() / 1000);
  const from = now - (10 * 86400); // 10 dias para garantir dados

  const result = { _source: 'finnhub', _ts: Date.now() };
  const errors = [];

  // Forex/CFD symbols via forex/candle
  const forexCalls = forexSyms.map(async sym => {
    try {
      const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(sym)}&resolution=D&from=${from}&to=${now}&token=${key}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'PortalInvestimento/3.0' } });
      
      if (!res.ok) {
        errors.push(`${sym}: HTTP ${res.status}`);
        return;
      }
      
      const d = await res.json();
      
      if (d.s !== 'ok' || !d.c || d.c.length < 1) {
        errors.push(`${sym}: ${d.s || 'no_data'}`);
        return;
      }

      const curr = d.c[d.c.length - 1];
      const prev = d.c.length >= 2 ? d.c[d.c.length - 2] : (d.o?.[0] || curr);
      const change = curr - prev;
      const changePct = prev > 0 ? (change / prev) * 100 : 0;

      // Formatar preço correctamente baseado na magnitude
      const priceStr = curr >= 1000 
        ? curr.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : curr >= 10 
          ? curr.toFixed(2) 
          : curr.toFixed(4);

      result[sym] = {
        price: priceStr,
        change: change.toFixed(4),
        changePct: changePct.toFixed(2),
        high: d.h?.[d.h.length - 1]?.toFixed(2),
        low: d.l?.[d.l.length - 1]?.toFixed(2),
        candles: d.c.length,
      };
    } catch (e) {
      errors.push(`${sym}: ${e.message}`);
    }
  });

  // Stock symbols via /quote (mais eficiente — uma chamada, sem timestamps)
  const stockCalls = stockSyms.map(async sym => {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`, {
        headers: { 'User-Agent': 'PortalInvestimento/3.0' }
      });
      if (!res.ok) { errors.push(`${sym}: HTTP ${res.status}`); return; }
      const d = await res.json();
      if (!d.c) { errors.push(`${sym}: no price`); return; }

      result[sym] = {
        price: d.c >= 1000 ? d.c.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : d.c.toFixed(2),
        change: d.d?.toFixed(2),
        changePct: d.dp?.toFixed(2),
        high: d.h?.toFixed(2),
        low: d.l?.toFixed(2),
      };
    } catch (e) {
      errors.push(`${sym}: ${e.message}`);
    }
  });

  await Promise.allSettled([...forexCalls, ...stockCalls]);

  // Fallback Twelve Data para os que falharam
  if (tdKey) {
    const missing = symbols.filter(s => !result[s]?.price && !s.includes(':'));
    if (missing.length > 0) {
      try {
        const res = await fetch(`https://api.twelvedata.com/price?symbol=${missing.join(',')}&apikey=${tdKey}`);
        const data = await res.json();
        for (const sym of missing) {
          const price = missing.length === 1 ? data?.price : data?.[sym]?.price;
          if (price) result[sym] = { price: parseFloat(price).toFixed(2), change: null, changePct: null, _source: 'twelvedata' };
        }
      } catch(e) {}
    }
  }

  if (errors.length) result._errors = errors;
  return result;
}

// ════════════════════════════════════════════════════════
// CANDLE CHART — OHLCV para gráfico
// ════════════════════════════════════════════════════════
async function fetchCandleChart(symbol, resolution, days, key) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - (days * 86400);
  const isForex = symbol.includes(':');
  
  const endpoint = isForex
    ? `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${key}`
    : `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${key}`;

  const res = await fetch(endpoint, { headers: { 'User-Agent': 'PortalInvestimento/3.0' } });
  if (!res.ok) return { symbol, status: 'error', code: res.status };
  
  const d = await res.json();
  if (d.s !== 'ok' || !d.c) return { symbol, status: d.s || 'no_data' };

  return { symbol, resolution, status: 'ok', t: d.t, o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, count: d.c.length };
}

// ════════════════════════════════════════════════════════
// SIGNAL — sinais técnicos agregados
// ════════════════════════════════════════════════════════
async function fetchSignal(symbol, resolution, key) {
  const res = await fetch(
    `https://finnhub.io/api/v1/scan/technical-indicator?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&token=${key}`,
    { headers: { 'User-Agent': 'PortalInvestimento/3.0' } }
  );
  if (!res.ok) return { symbol, error: res.status };
  const d = await res.json();
  return {
    symbol,
    signal: d.technicalAnalysis?.signal,
    count: d.technicalAnalysis?.count,
    trending: d.trend?.trending,
    adx: d.trend?.adx,
  };
}