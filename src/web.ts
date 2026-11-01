export function assertHttp(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs are supported.");
  return u;
}

export async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; red-design-mcp)", accept: "text/html,text/css,*/*" },
    });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    return (await res.text()).slice(0, 2_000_000);
  } finally {
    clearTimeout(timer);
  }
}

/** Collect inline <style> blocks and up to 8 linked stylesheets from a page. */
export async function collectCss(pageUrl: string): Promise<{ css: string; sheets: number }> {
  const base = assertHttp(pageUrl);
  const html = await fetchText(base.href);
  let css = "";
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css += "\n" + m[1];

  const hrefs: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const h = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!h) continue;
    try {
      hrefs.push(new URL(h[1], base).href);
    } catch {
      /* ignore bad href */
    }
  }
  const results = await Promise.allSettled([...new Set(hrefs)].slice(0, 8).map((h) => fetchText(h)));
  let sheets = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      css += "\n" + r.value;
      sheets++;
    }
  }
  return { css, sheets };
}
