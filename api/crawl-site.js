// api/crawl-site.js
// Função serverless (Vercel) — faz fetch ao HTML do site do cliente,
// extrai conteúdo relevante e devolve texto limpo + metadados.
// O Claude (chamado no frontend) usa este conteúdo para gerar os slides.
//
// Fluxo:
//  1. Recebe { url }
//  2. Fetch do HTML (server-side, sem CORS)
//  3. Extrai: título, meta description, og:image, headings, parágrafos, contactos, cores
//  4. Devolve JSON estruturado e limpo

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } }
};

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&atilde;/g, 'ã')
    .replace(/&otilde;/g, 'õ').replace(/&ccedil;/g, 'ç').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n));
}

function extractTag(html, regex) {
  const m = html.match(regex);
  return m ? decodeEntities(m[1].trim()) : null;
}

function extractAll(html, regex, limit = 20) {
  const out = [];
  let m;
  while ((m = regex.exec(html)) !== null && out.length < limit) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text.length > 2 && text.length < 200) out.push(text);
  }
  return [...new Set(out)]; // dedupe
}

function normalizeUrl(url) {
  url = url.trim();
  if (!/^https?:\/\//.test(url)) url = 'https://' + url;
  return url;
}

function resolveUrl(base, relative) {
  try { return new URL(relative, base).href; } catch { return relative; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL em falta.' });
    url = normalizeUrl(url);

    // Fetch com timeout e user-agent de browser
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LEDMockupStudio/1.0; +https://multimac.pt)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) return res.status(502).json({ error: `Site respondeu ${response.status}` });

    let html = await response.text();
    // Limitar tamanho
    if (html.length > 500000) html = html.slice(0, 500000);

    // ── EXTRAÇÃO ──
    const title = extractTag(html, /<title[^>]*>([^<]+)<\/title>/i);
    const metaDesc = extractTag(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    const ogImage = extractTag(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    const ogTitle = extractTag(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const themeColor = extractTag(html, /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);

    const h1 = extractAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi, 5);
    const h2 = extractAll(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi, 12);
    const h3 = extractAll(html, /<h3[^>]*>([\s\S]*?)<\/h3>/gi, 12);

    // Parágrafos relevantes
    const paragraphs = extractAll(html, /<p[^>]*>([\s\S]*?)<\/p>/gi, 15)
      .filter(p => p.length > 30);

    // Contactos
    const emails = [...new Set((html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
      .filter(e => !e.includes('.png') && !e.includes('.jpg')))].slice(0, 3);
    const phones = [...new Set((html.match(/(?:\+351\s?)?(?:\d{3}\s?\d{3}\s?\d{3})/g) || []))].slice(0, 3);

    // Cores hex do CSS inline (suporta 3 ou 6 dígitos)
    const colors = [...new Set((html.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})/g) || []))]
      .map(c => c.toLowerCase())
      .filter(c => c !== '#ffffff' && c !== '#000000' && c !== '#fff')
      .slice(0, 8);

    // Favicon
    const favicon = extractTag(html, /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i);

    const result = {
      success: true,
      url,
      title: ogTitle || title,
      description: metaDesc,
      logo: ogImage ? resolveUrl(url, ogImage) : (favicon ? resolveUrl(url, favicon) : null),
      themeColor,
      headings: { h1, h2, h3 },
      paragraphs,
      contacts: { emails, phones },
      colors,
      // Texto agregado para o Claude
      summary: [
        title && `Título: ${title}`,
        metaDesc && `Descrição: ${metaDesc}`,
        h1.length && `Principais: ${h1.join(' | ')}`,
        h2.length && `Secções: ${h2.join(' | ')}`,
        h3.length && `Subsecções: ${h3.join(' | ')}`,
        paragraphs.length && `Conteúdo: ${paragraphs.slice(0, 5).join(' ')}`,
        emails.length && `Emails: ${emails.join(', ')}`,
        phones.length && `Telefones: ${phones.join(', ')}`
      ].filter(Boolean).join('\n')
    };

    res.status(200).json(result);

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'O site demorou demasiado a responder.' });
    }
    res.status(500).json({ error: err.message });
  }
}
