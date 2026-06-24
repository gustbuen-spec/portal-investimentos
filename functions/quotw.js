// Cloudflare Worker — proxy Finnhub + Twelve Data (backup)
// Variáveis de ambiente necessárias no Cloudflare:
//   FINNHUB_KEY    → chave de https://finnhub.io
//   TWELVEDATA_KEY → chave de https://twelvedata.com

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const symbols = url.searchParams.get('symbols');

    if (!symbols) {
      return new Response(
        JSON.stringify({ error: 'symbols param required' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const symList = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);

    // ── 1. Tenta Finnhub ──────────────────────────────────────────────
    if (env.FINNHUB_KEY) {
      try {
        const result = await fetchFinnhub(symList, env.FINNHUB_KEY);
        const valid = Object.values(result).filter(v => v.price !== null).length;
        if (valid > 0) {
          result._source = 'finnhub';
          return new Response(JSON.stringify(result), { headers: corsHeaders });
        }
      } catch (e) {
        console.log('Finnhub failed:', e.message);
      }
    }

    // ── 2. Fallback: Twelve Data ──────────────────────────────────────
    if (env.TWELVEDATA_KEY) {
      try {
        const result = await fetchTwelveData(symList, env.TWELVEDATA_KEY);
        const valid = Object.values(result).filter(v => v.price !== null).length;
        if (valid > 0) {
          result._source = 'twelvedata';
          return new Response(JSON.stringify(result), { headers: corsHeaders });
        }
      } catch (e) {
        console.log('TwelveData failed:', e.message);
      }
    }

    // ── 3. Nenhuma API disponível ─────────────────────────────────────
    return new Response(
      JSON.stringify({ error: 'Todas as fontes falharam. Verifica as chaves de API.' }),
      { status: 502, headers: corsHeaders }
    );
  },
};

// ─────────────────────────────────────────────────────────────────────
// FINNHUB — 60 req/min grátis, delay ~20min
// Docs: https://finnhub.io/docs/api/quote
// Nota: não suporta múltiplos tickers numa só chamada — paralelizamos
// ─────────────────────────────────────────────────────────────────────
async function fetchFinnhub(symbols, key) {
  const calls = symbols.map(async (sym) => {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${key}`,
      { headers: { 'User-Agent': 'PortalInvestimento/1.0' } }
    );
    if (!res.ok) throw new Error(`Finnhub ${res.status} for ${sym}`);
    const d = await res.json();
    return {
      sym,
      price:     d.c  != null ? d.c.toFixed(2)  : null,  // current price
      change:    d.d  != null ? d.d.toFixed(2)  : null,  // change value
      changePct: d.dp != null ? d.dp.toFixed(2) : null,  // change %
    };
  });

  const settled = await Promise.allSettled(calls);
  const result = {};
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      result[r.value.sym] = {
        price:     r.value.price,
        change:    r.value.change,
        changePct: r.value.changePct,
      };
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// TWELVE DATA — 800 req/dia grátis, delay ~4h
// Docs: https://twelvedata.com/docs#getting-started
// Suporta múltiplos tickers numa chamada (separados por vírgula)
// ─────────────────────────────────────────────────────────────────────
async function fetchTwelveData(symbols, key) {
  const symStr = symbols.join(',');
  const res = await fetch(
    `https://api.twelvedata.com/price?symbol=${symStr}&apikey=${key}`,
    { headers: { 'User-Agent': 'PortalInvestimento/1.0' } }
  );
  if (!res.ok) throw new Error(`TwelveData ${res.status}`);
  const data = await res.json();

  const result = {};

  // Resposta varia: se 1 símbolo devolve {price:...}, se múltiplos devolve {SYM:{price:...}}
  if (symbols.length === 1) {
    const sym = symbols[0];
    result[sym] = {
      price:     data.price != null ? parseFloat(data.price).toFixed(2) : null,
      change:    null,
      changePct: null,
    };
  } else {
    for (const sym of symbols) {
      const d = data[sym];
      result[sym] = {
        price:     d?.price != null ? parseFloat(d.price).toFixed(2) : null,
        change:    null,
        changePct: null,
      };
    }
  }

  return result;
}