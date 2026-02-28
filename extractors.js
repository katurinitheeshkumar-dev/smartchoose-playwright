// ============================================================
// SmartChoose — extractors.js
// Universal product data extractor:
//   Priority 1 → JSON-LD structured data (fastest, most accurate)
//   Priority 2 → Platform-specific DOM selectors (evaluated in browser)
//   Priority 3 → OpenGraph meta tags (universal fallback)
//   Priority 4 → Next.js __NEXT_DATA__ (Flipkart, Meesho, etc.)
// ============================================================

// ── Parse a price string to numeric value
function parseNumericPrice(str) {
    if (!str) return 0;
    return parseInt(String(str).replace(/[^\d]/g, '')) || 0;
}

// ── Format a numeric price with ₹ and Indian comma formatting
function formatPrice(num) {
    if (!num) return '';
    return `₹${Number(num).toLocaleString('en-IN')}`;
}

// ── Calculate discount if we have both prices
function calcDiscount(price, originalPrice) {
    const p = parseNumericPrice(price);
    const o = parseNumericPrice(originalPrice);
    if (o > p && p > 0) return `${Math.round(((o - p) / o) * 100)}% off`;
    return '';
}

// ── Auto-detect category from title + description text
function detectCategory(title = '', desc = '') {
    const t = (title + ' ' + desc).toLowerCase();
    if (t.match(/shirt|dress|jeans|shoes|sneaker|kurti|saree|fashion|clothing|wear|kurta|chappals|sandals/)) return 'Fashion';
    if (t.match(/phone|mobile|tv|laptop|earbuds|headphone|camera|watch|charger|tablet|speaker|bluetooth|gaming/)) return 'Electronics';
    if (t.match(/cream|serum|makeup|perfume|hair|lipstick|skincare|moisturizer|shampoo|conditioner/)) return 'Beauty';
    if (t.match(/table|chair|sofa|home|mattress|pillow|curtain|bedsheet|kitchen|utensil|cookware/)) return 'Lifestyle';
    if (t.match(/vitamin|protein|supplement|medicine|health|fitness|gym|yoga|weight|nutrition/)) return 'Health';
    if (t.match(/bag|purse|wallet|handbag|backpack|luggage|suitcase/)) return 'Bags';
    if (t.match(/book|novel|textbook|magazine/)) return 'Books';
    return 'General';
}

// ── Known app/brand logo URLs to reject as product images
const BAD_IMAGE_PATTERNS = [
    'play-lh.googleusercontent.com',
    'is1-ssl.mzstatic.com',
    '_next/static',
    'meesho.com/images/meesho_logo',
    'static.meesho.com/web/images',
    '/favicon',
    'logo.png',
    'brand-logo',
    't.co/logo',
];

function isValidProductImage(url) {
    if (!url || !url.startsWith('http')) return false;
    const u = url.toLowerCase();
    return !BAD_IMAGE_PATTERNS.some(p => u.includes(p));
}

// ── EXTRACT JSON-LD STRUCTURED DATA (Priority 1)
function extractJsonLd(html) {
    const results = [];
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(m[1]);
            // Handle @graph arrays
            const items = parsed['@graph'] || (Array.isArray(parsed) ? parsed : [parsed]);
            for (const item of items) {
                if (item['@type'] === 'Product' || (Array.isArray(item['@type']) && item['@type'].includes('Product'))) {
                    results.push(item);
                }
            }
        } catch (_) { }
    }

    if (!results.length) return {};

    const product = results[0];
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    const agg = product.aggregateRating;

    // Images — can be string or array
    let images = [];
    if (Array.isArray(product.image)) images = product.image.filter(isValidProductImage);
    else if (typeof product.image === 'string' && isValidProductImage(product.image)) images = [product.image];
    else if (product.image?.url && isValidProductImage(product.image.url)) images = [product.image.url];

    const price = offer?.price ? formatPrice(offer.price) : '';
    const origPrice = offer?.priceValidUntil ? '' : '';

    return {
        title: product.name || '',
        description: product.description || '',
        brand: product.brand?.name || product.brand || '',
        image: images[0] || '',
        images,
        price,
        originalPrice: '',
        rating: agg?.ratingValue ? String(agg.ratingValue) : '',
        reviews: agg?.reviewCount ? String(agg.reviewCount) : '',
        _source: 'jsonld',
    };
}

// ── EXTRACT OG / META TAGS (Priority 3 fallback)
function extractOgMeta(html) {
    const get = (pattern) => {
        const m = html.match(pattern);
        return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim() : '';
    };

    return {
        title: get(/og:title[^>]+content=["']([^"']{5,})["']/i)
            || get(/<title>([^<]{5,})<\/title>/i)
            || '',
        description: get(/og:description[^>]+content=["']([^"']{10,})["']/i)
            || get(/name=["']description["'][^>]+content=["']([^"']{10,})["']/i)
            || '',
        image: (() => {
            const img = get(/og:image[^>]+content=["']([^"']+)["']/i);
            return isValidProductImage(img) ? img : '';
        })(),
        _source: 'og',
    };
}

// ── PLATFORM-SPECIFIC EXTRACTORS (run in browser via Playwright page.evaluate)
// These are exported as strings to be used with page.evaluate()

const BROWSER_EXTRACTORS = {
    Amazon: `({
    title: (document.querySelector('#productTitle') || document.querySelector('.product-title-word-break'))?.textContent?.trim() || document.title,
    price: (() => {
      const w = document.querySelector('.a-price-whole')?.textContent?.replace(/[^\\d]/g,'');
      return w ? '₹' + parseInt(w).toLocaleString('en-IN') : '';
    })(),
    originalPrice: document.querySelector('.a-text-price .a-offscreen')?.textContent?.trim()
                || document.querySelector('#listPrice')?.textContent?.trim() || '',
    description: document.querySelector('#productDescription p')?.textContent?.trim()
              || document.querySelector('#feature-bullets')?.innerText?.trim()?.substring(0,400) || '',
    brand: document.querySelector('#bylineInfo')?.textContent?.replace(/Brand:|Visit the|Store/g,'').trim()
        || document.querySelector('#brand')?.textContent?.trim() || '',
    rating: document.querySelector('#acrPopover')?.title?.match(/[\\d.]+/)?.[0] || '',
    reviews: document.querySelector('#acrCustomerReviewText')?.textContent?.match(/[\\d,]+/)?.[0]?.replace(/,/g,'') || '',
    image: (() => {
      const imgs = [];
      const main = document.querySelector('#landingImage, #imgBlkFront');
      if (main?.src) imgs.push(main.src.replace(/\\._[A-Z0-9,_]+_\\./,'._SL500_.'));
      document.querySelectorAll('#altImages img').forEach(img => {
        const src = img.src?.replace(/\\._[A-Z0-9,_]+_\\./,'._SL500_.');
        if (src?.includes('amazon') && !src.includes('transparent') && !imgs.includes(src)) imgs.push(src);
      });
      return imgs[0] || '';
    })(),
    images: (() => {
      try {
        const data = JSON.parse(document.querySelector('#imageBlock')?.dataset?.aePageData || '{}');
        return (data.images || []).map(i => i.large || '').filter(Boolean).slice(0,6);
      } catch { return []; }
    })(),
  })`,

    Flipkart: `(() => {
    // Try Next.js data first (most reliable for Flipkart)
    try {
      const nd = window.__NEXT_DATA__?.props?.pageProps?.initialData;
      if (nd) {
        const p = nd?.data?.product || nd?.RESPONSE?.data?.product || nd;
        const title = p?.name || p?.title || '';
        const pricing = p?.pricing || p?.price || {};
        const price = pricing?.finalPrice?.value || pricing?.value || '';
        const origPrice = pricing?.mrpPrice?.value || pricing?.mrp || '';
        const imgs = (p?.images || []).map(i => i?.url || i).filter(s => typeof s === 'string' && s.includes('http')).slice(0, 6);
        const rating = p?.rating?.average || '';
        const reviews = p?.rating?.count || '';
        if (title) return { title, price: price ? '₹'+Number(price).toLocaleString('en-IN') : '', originalPrice: origPrice ? '₹'+Number(origPrice).toLocaleString('en-IN') : '', images: imgs, image: imgs[0] || '', rating: String(rating), reviews: String(reviews), description: p?.description || '', brand: p?.brand?.name || '' };
      }
    } catch(_) {}
    // DOM fallback
    const title = document.querySelector('span.VU-Tz5, span.B_NuCI, h1._6EBuvT')?.textContent?.trim() || document.title;
    const price = document.querySelector('div.Nx9bqj, div._30jeq3')?.textContent?.trim() || '';
    const origPrice = document.querySelector('div.yRaY8j, div._3I9_wc')?.textContent?.trim() || '';
    const images = [...document.querySelectorAll('img._396cs4, img._53J4C-, img.DByuf4')].map(i=>i.src).filter(Boolean);
    const rating = document.querySelector('div.XQDdHH, div._3Ux46L, div.ipqd2A')?.textContent?.trim() || '';
    const reviews = document.querySelector('span._2_R_DZ, span.count')?.textContent?.match(/[\\d,]+/)?.[0]?.replace(/,/g,'') || '';
    const brand = document.querySelector('a.G6XhRU, span.G6XhRU')?.textContent?.trim() || '';
    const desc = document.querySelector('div._1AN87F, div._4gvKMe p')?.textContent?.trim() || '';
    return { title, price, originalPrice: origPrice, images, image: images[0]||'', rating, reviews, brand, description: desc };
  })()`,

    Meesho: `(() => {
    // Try JSON-LD first
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        const d = JSON.parse(s.textContent);
        const product = d['@type'] === 'Product' ? d : (d['@graph'] || []).find(i=>i['@type']==='Product');
        if (product?.name) {
          const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
          const imgs = Array.isArray(product.image) ? product.image : [product.image].filter(Boolean);
          return { title: product.name, price: offer?.price ? '₹'+Number(offer.price).toLocaleString('en-IN') : '', originalPrice:'', images: imgs.filter(u=>u?.startsWith('http')), image: imgs[0]||'', rating: product.aggregateRating?.ratingValue||'', reviews: product.aggregateRating?.reviewCount||'', description: product.description||'', brand: product.brand?.name||'' };
        }
      }
    } catch(_) {}
    // React state / window data
    try {
      const keys = Object.keys(window).filter(k => k.startsWith('__'));
      for (const k of keys) { try { const v = window[k]; if (v?.product?.name) { const p = v.product; return { title: p.name||'', price: p.price ? '₹'+p.price : '', originalPrice:'', images: p.images||[], image: p.images?.[0]||'', rating:'', reviews:'', brand:'', description:'' }; } } catch(_){} }
    } catch(_) {}
    // DOM fallback
    const title = document.querySelector('p[class*="ProductDescription"], span[class*="product-title"]')?.textContent?.trim()
               || document.querySelector('h1')?.textContent?.trim() || document.title;
    const price = document.querySelector('h4[class*="ProductPrice"], span[class*="price-value"]')?.textContent?.replace(/[^\\d₹,.]/g,'').trim() || '';
    const imgs = [...document.querySelectorAll('[class*="ProductImages"] img, [class*="product-image"] img, [class*="carousel"] img')].map(i=>(i.src||i.dataset.src||'')).filter(s=>s?.startsWith('http')&&!s.includes('logo')).slice(0,6);
    return { title, price, originalPrice:'', images: imgs, image: imgs[0]||'', rating:'', reviews:'', brand:'', description:'' };
  })()`,

    Myntra: `(() => {
    // JSON-LD
    try {
      const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent || '{}');
      const p = ld['@type']==='Product' ? ld : null;
      if (p?.name) {
        const o = Array.isArray(p.offers)?p.offers[0]:p.offers;
        const imgs = (Array.isArray(p.image)?p.image:[p.image]).filter(i=>i?.startsWith('http'));
        return { title:p.name, price:o?.price?'₹'+Number(o.price).toLocaleString('en-IN'):'', originalPrice:'', images:imgs, image:imgs[0]||'', rating:p.aggregateRating?.ratingValue||'', reviews:p.aggregateRating?.reviewCount||'', brand:p.brand?.name||'', description:p.description||'' };
      }
    } catch(_) {}
    // DOM
    const brand = document.querySelector('h1.pdp-title')?.textContent?.trim() || '';
    const name  = document.querySelector('h1.pdp-name')?.textContent?.trim() || '';
    const title = [brand, name].filter(Boolean).join(' ') || document.title;
    const price = document.querySelector('.pdp-price strong, .pdp-discounted-price strong')?.textContent?.trim() || '';
    const origPrice = document.querySelector('.pdp-mrp s, .pdp-mrp strike')?.textContent?.trim() || '';
    const imgs = [...document.querySelectorAll('.image-grid-image, img.desktop-image-thumbnail')].map(el => el.style?.backgroundImage?.match(/url\\("?([^"')]+)/)?.[1] || el.src?.replace(/\\?.*$/, '')).filter(s=>s?.startsWith('http')).slice(0,6);
    const rating = document.querySelector('.index-overallRating span, .user-review-main-text')?.textContent?.trim() || '';
    return { title, price, originalPrice: origPrice, images: imgs, image: imgs[0]||'', rating, reviews:'', brand, description:'' };
  })()`,

    Ajio: `(() => {
    try {
      const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent||'{}');
      if (ld.name) {
        const o = Array.isArray(ld.offers)?ld.offers[0]:ld.offers;
        const imgs = (Array.isArray(ld.image)?ld.image:[ld.image]).filter(i=>i?.startsWith('http'));
        return { title:ld.name, price:o?.price?'₹'+Number(o.price).toLocaleString('en-IN'):'', originalPrice:'', images:imgs, image:imgs[0]||'', rating:ld.aggregateRating?.ratingValue||'', reviews:ld.aggregateRating?.reviewCount||'', brand:ld.brand?.name||'', description:ld.description||'' };
      }
    } catch(_) {}
    const title = document.querySelector('h1.prod-name, span.brand-name + span')?.textContent?.trim() || document.title;
    const price = document.querySelector('.prod-price-amount, span[class*="price"]')?.textContent?.trim() || '';
    const imgs = [...document.querySelectorAll('.zoom-image, img.rilrtl-base-img')].map(i=>i.src||i.dataset.src).filter(s=>s?.startsWith('http')).slice(0,6);
    return { title, price, originalPrice:'', images:imgs, image:imgs[0]||'', rating:'', reviews:'', brand:'', description:'' };
  })()`,

    'Tata Cliq': `(() => {
    try {
      const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent||'{}');
      if (ld.name) {
        const o = Array.isArray(ld.offers)?ld.offers[0]:ld.offers;
        const imgs = (Array.isArray(ld.image)?ld.image:[ld.image]).filter(i=>i?.startsWith('http'));
        return { title:ld.name, price:o?.price?'₹'+Number(o.price).toLocaleString('en-IN'):'', originalPrice:'', images:imgs, image:imgs[0]||'', rating:ld.aggregateRating?.ratingValue||'', reviews:ld.aggregateRating?.reviewCount||'', brand:ld.brand?.name||'', description:ld.description||'' };
      }
    } catch(_) {}
    const title = document.querySelector('h1.ProductDetails-pdpTitle, .pdp-product-name')?.textContent?.trim() || document.title;
    const price = document.querySelector('.pdp-selling-price, .final-price')?.textContent?.trim() || '';
    const imgs = [...document.querySelectorAll('.product-slider img, .pdp-image img')].map(i=>i.src).filter(s=>s?.startsWith('http')).slice(0,6);
    return { title, price, originalPrice:'', images:imgs, image:imgs[0]||'', rating:'', reviews:'', brand:'', description:'' };
  })()`,

    Nykaa: `(() => {
    try {
      const ld = JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent||'{}');
      if (ld.name) {
        const o = Array.isArray(ld.offers)?ld.offers[0]:ld.offers;
        const imgs = (Array.isArray(ld.image)?ld.image:[ld.image]).filter(i=>i?.startsWith('http'));
        return { title:ld.name, price:o?.price?'₹'+Number(o.price).toLocaleString('en-IN'):'', originalPrice:'', images:imgs, image:imgs[0]||'', rating:ld.aggregateRating?.ratingValue||'', reviews:ld.aggregateRating?.reviewCount||'', brand:ld.brand?.name||'', description:ld.description||'' };
      }
    } catch(_) {}
    const title = document.querySelector('h1.product-title, .pdp-product-name')?.textContent?.trim() || document.title;
    const price = document.querySelector('.product-price .final-price, span[class*="price"]')?.textContent?.trim() || '';
    const imgs = [...document.querySelectorAll('.image-slide img, .product-image img')].map(i=>i.src).filter(s=>s?.startsWith('http')).slice(0,6);
    return { title, price, originalPrice:'', images:imgs, image:imgs[0]||'', rating:'', reviews:'', brand:'', description:'' };
  })()`,
};

// Generic extractor for all other platforms
BROWSER_EXTRACTORS['default'] = `(() => {
  // JSON-LD first
  try {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      const d = JSON.parse(s.textContent);
      const items = d['@graph'] || (Array.isArray(d)?d:[d]);
      const p = items.find(i => i['@type']==='Product' || (Array.isArray(i['@type'])&&i['@type'].includes('Product')));
      if (p?.name) {
        const o = Array.isArray(p.offers)?p.offers[0]:p.offers;
        const imgs = (Array.isArray(p.image)?p.image:[p.image]).filter(i=>i&&i.startsWith('http'));
        return { title:p.name, price:o?.price?'₹'+Number(o.price).toLocaleString('en-IN'):'', originalPrice:'', images:imgs, image:imgs[0]||'', rating:p.aggregateRating?.ratingValue||'', reviews:p.aggregateRating?.reviewCount||'', brand:p.brand?.name||p.brand||'', description:p.description||'' };
      }
    }
  } catch(_) {}
  // OG + DOM
  const title = document.querySelector('meta[property="og:title"]')?.content || document.querySelector('h1')?.textContent?.trim() || document.title;
  const image = document.querySelector('meta[property="og:image"]')?.content || document.querySelector('img.product')?.src || '';
  const description = document.querySelector('meta[property="og:description"]')?.content || '';
  const price = document.querySelector('[class*="price"],[id*="price"],[class*="Price"]')?.textContent?.trim() || '';
  return { title, price, originalPrice:'', images: image?[image]:[], image, rating:'', reviews:'', brand:'', description };
})()`;

// ── MAIN HTML EXTRACTION FUNCTION
// Called with rendered HTML from either HTTP fetch or Playwright
function extractFromHtml(html, url, platform, nextDataJson) {
    // Priority 1: JSON-LD
    const jsonLd = extractJsonLd(html);

    // Priority 4: Next.js data (if provided from Playwright)
    let nextData = {};
    if (nextDataJson) {
        try {
            const nd = JSON.parse(nextDataJson);
            const props = nd?.props?.pageProps;
            const product = props?.initialData?.data?.product
                || props?.RESPONSE?.data?.product
                || props?.pdpData?.product
                || null;

            if (product?.name || product?.title) {
                const pricing = product.pricing || product.price || {};
                const price = pricing.finalPrice?.value || pricing.value || 0;
                const orig = pricing.mrpPrice?.value || pricing.mrp || 0;
                const imgs = (product.images || []).map(i => i?.url || i).filter(s => typeof s === 'string' && s.startsWith('http'));
                nextData = {
                    title: product.name || product.title || '',
                    price: price ? formatPrice(price) : '',
                    originalPrice: orig ? formatPrice(orig) : '',
                    image: imgs[0] || '',
                    images: imgs,
                    brand: product.brand?.name || '',
                    description: product.description || '',
                    rating: String(product.rating?.average || ''),
                    reviews: String(product.rating?.count || ''),
                    _source: 'nextjs',
                };
            }
        } catch (_) { }
    }

    // Priority 3: OG meta
    const og = extractOgMeta(html);

    // Merge: JSON-LD > Next.js > OG
    const merged = {};
    const sources = [jsonLd, nextData, og];
    const fields = ['title', 'price', 'originalPrice', 'description', 'image', 'brand', 'rating', 'reviews'];

    for (const field of fields) {
        for (const src of sources) {
            if (src[field] && !merged[field]) {
                merged[field] = src[field];
                break;
            }
        }
        if (!merged[field]) merged[field] = '';
    }

    // Images array
    merged.images = jsonLd.images?.length ? jsonLd.images
        : nextData.images?.length ? nextData.images
            : (merged.image ? [merged.image] : []);

    // Discount calculation
    if (!merged.discount) merged.discount = calcDiscount(merged.price, merged.originalPrice);

    // Category
    merged.category = detectCategory(merged.title, merged.description);

    return merged;
}

module.exports = { extractFromHtml, BROWSER_EXTRACTORS, detectCategory, calcDiscount, formatPrice };
