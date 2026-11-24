// The one place that decides which requests are the API's (no-store, JSON 404) and which may get the web app's page.

/** /api, /api?…, /api/… (raw request URL, query included). */
export const isApi = (url: string): boolean => url === '/api' || /^\/api[/?]/.test(url);

/** Only a GET or HEAD outside /api and the build's /assets/ falls back to index.html (the web app's own routes). */
export const servesPage = (method: string, url: string): boolean =>
  (method === 'GET' || method === 'HEAD') && !isApi(url) && !url.startsWith('/assets/');
