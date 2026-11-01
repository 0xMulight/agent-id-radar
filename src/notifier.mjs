export const cleanText = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 3500);
export class Notifier {
  constructor(cfg, store, fetcher = fetch, logger = console.log) { this.cfg = cfg; this.store = store; this.fetcher = fetcher; this.logger = logger; }
  async send(key, message, { intervalMs = 3600000, now = Date.now() } = {}) {
    let send = false;
    await this.store.transaction(s => {
      if (s.alerts[key] && now - s.alerts[key] < intervalMs) return;
      s.alerts[key] = now; send = true;
      if (Object.keys(s.alerts).length > 5000) for (const k of Object.keys(s.alerts).slice(0, 1000)) delete s.alerts[k];
    });
    if (!send) return;
    const text = cleanText(message); this.logger(text);
    const token = process.env[this.cfg.telegram.tokenEnv];
    if (!token || !this.cfg.telegram.chatId) return;
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(this.cfg.telegram.chatId)) throw new Error('Invalid Telegram notification configuration');
    // Outbound plain text only. No command polling, HTML, Markdown or remote instruction execution.
    try {
      const r = await this.fetcher('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: this.cfg.telegram.chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(8000) });
      if (!r.ok) this.logger('Telegram delivery failed; see local status');
    } catch { this.logger('Telegram delivery unavailable; token and request URL were not logged'); }
  }
}
