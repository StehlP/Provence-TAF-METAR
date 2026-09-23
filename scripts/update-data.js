// Récupère METAR / TAF et écrit data.js (lu par index.html).
// Source principale : Ogimet (Espagne, messages OPMET du réseau OMM, mis à jour à la demi-heure).
// Secours : NOAA aviationweather.gov, puis NOAA tgftp.
const fs = require('fs');

const IDS = ['LFTW','LFMO','LFMV','LFMY','LFMT','LFMC','LFMI','LFML','LFTH'];
const now = new Date();

const get = async u => {
  try {
    const r = await fetch(u, {signal: AbortSignal.timeout(30000), headers: {'User-Agent': 'Provence-METAR-TAF'}});
    return r.ok ? r.text() : null;
  } catch (e) { return null; }
};

// Date complète d'un groupe JJHHMM / JJHH (mois déduit par rapport à maintenant)
function dayTime(dd, hh, mm = 0){
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dd, hh, mm));
  if (d - now > 15 * 86400000) d.setUTCMonth(d.getUTCMonth() - 1);
  if (now - d > 15 * 86400000) d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

function tafInfo(raw){
  const v = raw.match(/\s(\d{2})(\d{2})\/(\d{2})(\d{2})\s/);
  if (!v) return null;
  const from = dayTime(+v[1], +v[2]), to = dayTime(+v[3], +v[4] === 24 ? 0 : +v[4]);
  if (+v[4] === 24) to.setUTCDate(to.getUTCDate() + 1);
  const iss = raw.match(/\s(\d{2})(\d{2})(\d{2})Z\s/);
  return {from, to, issued: iss ? dayTime(+iss[1], +iss[2], +iss[3]) : from, hours: (to - from) / 3600000};
}

async function srcOgimet(){
  const out = {};
  const s = new Date(now - 30 * 3600000);
  const p = (d, k) => String(d['getUTC' + k]() + (k === 'Month' ? 1 : 0)).padStart(2, '0');
  const url = 'https://www.ogimet.com/display_metars2.php?lang=en&tipo=ALL&ord=REV&nil=SI&fmt=txt&send=send'
    + '&lugar=' + IDS.join('+')
    + `&ano=${s.getUTCFullYear()}&mes=${p(s,'Month')}&day=${p(s,'Date')}&hora=${p(s,'Hours')}`
    + `&anof=${now.getUTCFullYear()}&mesf=${p(now,'Month')}&dayf=${p(now,'Date')}&horaf=23&minf=59`;
  const txt = await get(url);
  if (!txt) return out;

  // Messages : une ligne "AAAAMMJJHHMM TYPE ..." puis lignes de continuation, fin par "="
  const msgs = [];
  for (const line of txt.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = line.match(/^(\d{12})\s+(.*)$/);
    if (m) msgs.push(m[2].trim());
    else if (msgs.length && line.trim()) msgs[msgs.length - 1] += ' ' + line.trim();
  }
  for (let raw of msgs) {
    raw = raw.replace(/=\s*$/, '').replace(/\s+/g, ' ');
    const m = raw.match(/^(METAR|SPECI|TAF)\s+(?:(?:COR|AMD)\s+)*([A-Z]{4})\s/);
    if (!m || !IDS.includes(m[2]) || / NIL$/.test(raw)) continue;
    const o = (out[m[2]] ??= {});
    if (m[1] !== 'TAF') {
      const t = raw.match(/\s(\d{2})(\d{2})(\d{2})Z\s/);
      const d = t && dayTime(+t[1], +t[2], +t[3]);
      if (d && (!o._mt || d > o._mt)) { o._mt = d; o.metar = raw; }
    } else {
      const i = tafInfo(raw);
      if (!i || i.to <= now) continue;               // TAF expiré (ou vieux message rediffusé)
      const k = i.hours <= 12 ? 'tafc' : 'taf';      // TAF court / TAF long
      if (!o['_' + k] || i.issued >= o['_' + k]) { o['_' + k] = i.issued; o[k] = raw; }
    }
  }
  for (const o of Object.values(out)) for (const k of Object.keys(o)) if (k[0] === '_') delete o[k];
  return out;
}

async function srcNOAA(){
  const out = {};
  const base = 'https://aviationweather.gov/api/data/';
  const m = await get(base + 'metar?ids=' + IDS + '&format=json&hours=3');
  const t = await get(base + 'taf?ids=' + IDS + '&format=json');
  try { JSON.parse(m).sort((a,b)=>a.obsTime-b.obsTime).forEach(x => (out[x.icaoId] ??= {}).metar = x.rawOb); } catch (e) {}
  try { JSON.parse(t).sort((a,b)=>a.issueTime>b.issueTime?1:-1).forEach(x => (out[x.icaoId] ??= {}).taf = x.rawTAF); } catch (e) {}
  for (const id of IDS) {
    if (!out[id]?.metar) { const s = await get(`https://tgftp.nws.noaa.gov/data/observations/metar/stations/${id}.TXT`); if (s) (out[id] ??= {}).metar = s.split('\n').slice(1).join(' ').trim(); }
    if (!out[id]?.taf)   { const s = await get(`https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/${id}.TXT`);   if (s) (out[id] ??= {}).taf   = s.split('\n').slice(1).join(' ').trim(); }
  }
  return out;
}

(async () => {
  const out = await srcOgimet();
  const src = {};
  for (const id of IDS) if (out[id]?.metar) src[id] = 'Ogimet';
  // Compléter ce qui manque avec la NOAA
  if (IDS.some(id => !out[id]?.metar || !(out[id]?.taf || out[id]?.tafc))) {
    const n = await srcNOAA();
    for (const id of IDS) for (const k of ['metar','taf']) {
      if (n[id]?.[k] && !out[id]?.[k] && !(k === 'taf' && out[id]?.tafc)) {
        (out[id] ??= {})[k] = n[id][k];
        if (k === 'metar') src[id] = 'NOAA';
      }
    }
  }
  if (!Object.keys(out).length) { console.error('Aucune donnée'); process.exit(1); }
  out._updated = now.toISOString();
  out._sources = [...new Set(Object.values(src))].join(' + ');
  fs.writeFileSync('data.js', 'window.METAR_DATA = ' + JSON.stringify(out, null, 1) + ';\n');
  for (const id of IDS) console.log(id, src[id] || '-', out[id]?.tafc ? 'TAF court' : '', out[id]?.taf ? 'TAF' : '');
})();
