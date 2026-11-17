import { writeFileSync } from 'node:fs';
const raw = (process.env.API_BASE_URL || '').trim();
let apiBaseUrl = '';
if (raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('API_BASE_URL must be an HTTPS origin, for example https://api.example.com');
    }
    apiBaseUrl = url.origin;
}
writeFileSync(new URL('../frontend/config.js', import.meta.url),
    '// Public browser configuration. Never put API keys here.\nwindow.STRIMKO_CONFIG = Object.freeze(' + JSON.stringify({ apiBaseUrl }) + ');\n');
console.log(apiBaseUrl ? 'Configured API: ' + apiBaseUrl : 'No API_BASE_URL: screenshot recognition is unavailable on the published site; manual solving still works.');
