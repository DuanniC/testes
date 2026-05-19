// Minha Estante - API de livros para Vercel
// Endpoint: /api/books?q=nome-do-livro

const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const cache = globalThis.__BOOK_CACHE__ || new Map();
globalThis.__BOOK_CACHE__ = cache;

const LOCAL_CATALOG = [
  { title: 'Quarta Asa', author_name: ['Rebecca Yarros'], number_of_pages_median: 528, isbn: ['9786559811390'], isbn13: '9786559811390', _source: 'cat' },
  { title: 'Chama de Ferro', author_name: ['Rebecca Yarros'], number_of_pages_median: 672, isbn: ['9786559812038'], isbn13: '9786559812038', _source: 'cat' },
  { title: 'Tempestade de Ônix', author_name: ['Rebecca Yarros'], number_of_pages_median: 544, isbn: ['9786559813844'], isbn13: '9786559813844', _source: 'cat' },
  { title: 'A Crisálida Dourada', author_name: ['Selena Valentino'], number_of_pages_median: null, isbn: [], _source: 'manual' },
  { title: 'Ignis Lacrimosa', author_name: ['Helena Lopes'], number_of_pages_median: null, isbn: [], _source: 'manual' },
  { title: 'Era Uma Vez um Coração Partido', author_name: ['Stephanie Garber'], number_of_pages_median: 336, isbn: [], _source: 'cat' },
  { title: 'A Maldição do Verdadeiro Amor', author_name: ['Stephanie Garber'], number_of_pages_median: 336, isbn: [], _source: 'cat' },
  { title: 'A Balada do Felizes Para Nunca', author_name: ['Stephanie Garber'], number_of_pages_median: 336, isbn: [], _source: 'cat' },
];

function norm(s = '') {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanQuery(raw = '') {
  return String(raw)
    .replace(/\b(e\s*book|ebook|kindle|capa comum|brochura|livro|romantasia|sucesso do bookgram|edi[cç][aã]o portugu[eê]s[a]?|portugu[eê]s[a]?)\b/gi, ' ')
    .replace(/\s*[:|–—-]\s*(uma romantasia.*|sucesso.*|e\s*book.*|ebook.*|kindle.*)$/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  const stop = new Set(['o','a','os','as','um','uma','de','do','da','dos','das','e','em','no','na','para','por','com','livro']);
  return norm(s).split(/\s+/).filter(t => t.length > 1 && !stop.has(t));
}

function score(query, item) {
  const qn = norm(query);
  const tn = norm(item.title);
  const an = norm((item.author_name || []).join(' '));
  const qt = tokens(query);
  if (!qt.length || !tn) return 0;
  if (tn === qn) return 10000;
  if (tn.startsWith(qn)) return 8500;
  if (qn.includes(tn) && tn.length > 4) return 8000;
  let hits = 0;
  let authorHits = 0;
  for (const t of qt) {
    if (tn.includes(t)) hits++;
    else if (an.includes(t)) authorHits++;
  }
  if (!hits) return 0;
  return hits * 1000 + authorHits * 250 + Math.round((hits / Math.max(1, tokens(item.title).length)) * 600);
}

function imageFromGoogle(v) {
  const links = v && v.imageLinks;
  if (!links) return '';
  return (links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail || '')
    .replace('http://', 'https://')
    .replace(/[?&]edge=curl/g, '')
    .replace('zoom=1', 'zoom=0');
}

function mapGoogle(item) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const isbn = ids.map(x => x.identifier).filter(Boolean);
  return {
    title: v.title || '',
    author_name: v.authors || [],
    number_of_pages_median: v.pageCount || null,
    subject: v.categories || [],
    isbn,
    isbn13: isbn.find(x => String(x).replace(/[^0-9X]/gi, '').length === 13) || '',
    cover_url: imageFromGoogle(v),
    cover_i: null,
    publisher: v.publisher || '',
    language: v.language || '',
    _source: 'google'
  };
}

function mapOpenLibrary(doc) {
  const isbn = (doc.isbn || []).filter(Boolean);
  const bestIsbn = isbn.find(x => String(x).replace(/[^0-9X]/gi, '').length === 13) || isbn[0] || '';
  return {
    title: doc.title || '',
    author_name: doc.author_name || [],
    number_of_pages_median: doc.number_of_pages_median || doc.number_of_pages || null,
    subject: doc.subject || [],
    isbn,
    isbn13: bestIsbn,
    cover_i: doc.cover_i || null,
    cover_url: bestIsbn ? `https://covers.openlibrary.org/b/isbn/${bestIsbn}-L.jpg` : (doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : ''),
    language: doc.language || [],
    _source: 'ol'
  };
}

async function fetchJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'MinhaEstante/1.0', 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchGoogle(q) {
  const fields = 'items(volumeInfo(title,authors,imageLinks,pageCount,categories,industryIdentifiers,language,publishedDate,publisher))';
  const queries = [
    `intitle:${q}`,
    q
  ];
  const out = [];
  for (const query of queries) {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=20&printType=books&country=BR&orderBy=relevance&fields=${encodeURIComponent(fields)}`;
    const data = await fetchJson(url);
    for (const item of (data && data.items || [])) out.push(mapGoogle(item));
  }
  return out;
}

async function searchOpenLibrary(q) {
  const fields = 'title,author_name,cover_i,number_of_pages_median,number_of_pages,subject,isbn,language,edition_count';
  const urls = [
    `https://openlibrary.org/search.json?title=${encodeURIComponent(q)}&language=por&limit=25&fields=${fields}`,
    `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=25&fields=${fields}`
  ];
  const out = [];
  for (const url of urls) {
    const data = await fetchJson(url);
    for (const doc of (data && data.docs || [])) out.push(mapOpenLibrary(doc));
  }
  return out;
}

function dedupeAndRank(query, lists) {
  const map = new Map();
  for (const item of lists.flat()) {
    if (!item || !item.title) continue;
    const s = score(query, item);
    if (s <= 0 && item._source !== 'manual') continue;
    const key = norm(`${item.title} ${(item.author_name || [])[0] || ''}`);
    const prev = map.get(key);
    const enriched = { ...item, _score: s || score(cleanQuery(query), item) || 1 };
    if (!prev || enriched._score > prev._score || (!prev.cover_url && enriched.cover_url)) map.set(key, enriched);
  }
  return [...map.values()].sort((a, b) => (b._score || 0) - (a._score || 0)).slice(0, 15);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const raw = String(req.query.q || '').trim();
  if (raw.length < 2) return res.status(200).json({ query: raw, cleanQuery: '', items: [] });

  const q = cleanQuery(raw) || raw;
  const cacheKey = norm(q);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  const local = LOCAL_CATALOG.filter(item => score(q, item) > 0 || score(raw, item) > 0);
  const [google, ol] = await Promise.allSettled([searchGoogle(q), searchOpenLibrary(q)]);
  const items = dedupeAndRank(q, [local, google.value || [], ol.value || []]);

  // Último recurso: mantém opção manual útil, em vez de parecer que quebrou.
  if (!items.length) {
    items.push({ title: q, author_name: [], number_of_pages_median: null, subject: [], isbn: [], cover_url: '', cover_i: null, _source: 'manual', _score: 1 });
  }

  const data = { query: raw, cleanQuery: q, items };
  cache.set(cacheKey, { time: Date.now(), data });
  return res.status(200).json(data);
}
