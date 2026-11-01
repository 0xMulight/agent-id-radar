// Scheduling changes how soon a reviewed template is inspected, never its gates.
export class EntrySchedule {
  constructor(cfg, clock = Date.now) { this.cfg = cfg; this.clock = clock; this.records = new Map(); }
  interval(candidate = {}, record = {}, now = this.clock()) {
    const { scan, entry } = this.cfg;
    const activity = candidate.lastSeen ?? candidate.firstSeen;
    const cold = Number.isFinite(activity) && now - activity >= scan.activeHours * 3600000;
    const near = Number.isInteger(record.progressBps) && record.progressBps >= entry.progressBps - 200 && record.progressBps < 10000 && now - record.observedAt <= 2 * scan.normalMs;
    const hot = near || (!cold && (candidate.heatTier >= 1 || candidate.agentCount >= Math.ceil(entry.minAgents * 0.7)));
    return hot ? scan.hotMs : cold ? scan.coldMs : scan.normalMs;
  }
  claim(templates, contextFor) {
    const now = this.clock(), due = [];
    for (const template of templates) {
      const candidate = contextFor(template), record = this.records.get(template.contract) || {};
      const interval = this.interval(candidate, record, now);
      if (Math.min(record.nextAt || 0, (record.checkedAt || 0) + interval) <= now) due.push({ template, candidate, record, hot: interval === this.cfg.scan.hotMs });
    }
    // Oldest checked first within each queue; unseen entries break ties by age.
    const fair = (a, b) => (a.record.checkedAt || 0) - (b.record.checkedAt || 0) || (b.candidate.firstSeen || 0) - (a.candidate.firstSeen || 0) || a.template.contract.localeCompare(b.template.contract);
    const hot = due.filter(x => x.hot).sort(fair), rest = due.filter(x => !x.hot).sort(fair), max = this.cfg.scan.maxEntryChecksPerTick;
    // Reserve capacity for ordinary/cold entries so popular ones cannot starve them.
    const selected = max === 1 ? due.sort(fair).slice(0, 1) : hot.splice(0, rest.length ? max - 1 : max).concat(rest.splice(0, 1));
    selected.push(...hot.concat(rest).sort(fair).slice(0, max - selected.length));
    const active = new Set(templates.map(t => t.contract));
    for (const key of this.records.keys()) if (!active.has(key)) this.records.delete(key);
    for (const row of selected) this.records.set(row.template.contract, { ...row.record, checkedAt: now, nextAt: now + this.interval(row.candidate, row.record, now) });
    return selected;
  }
  observe(contract, candidate, snapshot) {
    const now = this.clock(), record = { ...this.records.get(contract), progressBps: snapshot.progressBps, observedAt: now };
    record.nextAt = now + this.interval(candidate, record, now); this.records.set(contract, record);
  }
}
