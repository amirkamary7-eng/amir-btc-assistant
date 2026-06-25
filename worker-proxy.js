/**
 * Cloudflare Worker — پروکسی API به بک‌اند FastAPI (Railway/Render)
 * در Cloudflare Workers متغیر BACKEND_URL را تنظیم کنید.
 * مثال: https://your-app.up.railway.app
 */
export default {
  async fetch(request, env) {
    const backend = (env.BACKEND_URL || '').replace(/\/$/, '');
    if (!backend) {
      return new Response(JSON.stringify({ status: 'error', message: 'BACKEND_URL not configured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const url = new URL(request.url);
    const target = `${backend}${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    headers.delete('host');

    const init = {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text(),
    };

    try {
      const res = await fetch(target, init);
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ status: 'error', message: String(e) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
