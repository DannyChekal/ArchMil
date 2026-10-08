/* Shared code for the parish demographics site.
 *
 * Data model (all loaded from docs/data, produced by scripts/build.py):
 *   tracts.geojson    census tracts with a representative point (lat/lng) and neighbours (nb)
 *   parishes.json     {parishes: [...rows of data/parishes.csv], locations: [...rows of data/locations.csv]}
 *   acs/catalog.json  list of ACS tables; acs/<id>.json one file per table
 *
 * Unsaved edits made on the "Edit parishes" page are stored in this browser
 * (localStorage) and replace parishes.json everywhere on the site until they
 * are discarded or exported and committed to data/*.csv.
 */
(function () {
  "use strict";
  const AM = (window.AM = {});
  const EDITS_KEY = "archmil.parishEdits.v1";
  const VARS_KEY = "archmil.selectedVars.v1";

  AM.SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
  AM.CAT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];

  // ------------------------------------------------------------------ utilities
  AM.esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  AM.el = (tag, attrs = {}, html = "") => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
    }
    if (html) e.innerHTML = html;
    return e;
  };
  const jsonCache = new Map();
  AM.fetchJSON = (url) => {
    if (!jsonCache.has(url)) {
      jsonCache.set(url, fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        return r.json();
      }));
    }
    return jsonCache.get(url);
  };

  const R = 3958.8; // earth radius, miles
  AM.miles = (lat1, lng1, lat2, lng2) => {
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  AM.pointInFeature = (lng, lat, f) => {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.some((p) => inRing(lng, lat, p[0]) && !p.slice(1).some((h) => inRing(lng, lat, h)));
  };

  AM.csvEscape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  AM.toCSV = (fields, rows) =>
    [fields.join(","), ...rows.map((r) => fields.map((f) => AM.csvEscape(Array.isArray(r) ? r[fields.indexOf(f)] : r[f])).join(","))].join("\n") + "\n";
  AM.download = (name, text, type = "text/csv") => {
    const a = AM.el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
  AM.parseCSV = (text) => {
    const rows = [];
    let row = [], f = "", q = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
        else if (c === '"') q = false;
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(f); f = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else f += c;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    const head = rows.shift() || [];
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
  };

  // ------------------------------------------------------------------ URL state
  AM.getState = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  AM.setState = (patch) => {
    const s = { ...AM.getState(), ...patch };
    for (const k of Object.keys(s)) if (s[k] === undefined || s[k] === null || s[k] === "") delete s[k];
    history.replaceState(null, "", "#" + new URLSearchParams(s).toString());
  };
  AM.selectedVars = (defaults) => {
    const st = AM.getState();
    if (st.vars !== undefined) return st.vars ? st.vars.split(",") : [];
    try {
      const v = JSON.parse(localStorage.getItem(VARS_KEY));
      if (Array.isArray(v)) return v;
    } catch (e) { /* storage unavailable */ }
    return defaults.slice();
  };
  AM.saveVars = (vars) => {
    AM.setState({ vars: vars.join(",") });
    try { localStorage.setItem(VARS_KEY, JSON.stringify(vars)); } catch (e) { /* ignore */ }
  };

  // ------------------------------------------------------------------ local edits
  AM.getEdits = () => {
    try { return JSON.parse(localStorage.getItem(EDITS_KEY)); } catch (e) { return null; }
  };
  AM.saveEdits = (data) => {
    try { localStorage.setItem(EDITS_KEY, JSON.stringify({ ...data, saved: new Date().toISOString() })); return true; }
    catch (e) { alert("Could not save edits in this browser: " + e.message); return false; }
  };
  AM.clearEdits = () => { try { localStorage.removeItem(EDITS_KEY); } catch (e) { /* ignore */ } };

  // ------------------------------------------------------------------ base data
  AM.loadBase = async () => {
    const [site, tractsGJ, catalog, parishData] = await Promise.all([
      AM.fetchJSON("data/site.json"), AM.fetchJSON("data/tracts.geojson"),
      AM.fetchJSON("data/acs/catalog.json"), AM.fetchJSON("data/parishes.json"),
    ]);
    const tracts = tractsGJ.features;
    const tractById = new Map(tracts.map((t) => [t.properties.GEOID, t]));
    const edits = AM.getEdits();
    const src = edits || parishData;
    const parishes = AM.assembleParishes(src.parishes, src.locations, tracts);
    const base = { site, tracts, tractsGJ, tractById, catalog, parishes, parishById: new Map(parishes.map((p) => [p.id, p])),
      edits, committed: parishData };
    AM.base = base;
    return base;
  };

  AM.yes = (v) => !/^(no|n|false|0)$/i.test(String(v ?? "yes").trim());

  AM.assembleParishes = (prows, lrows, tracts) => {
    const byId = new Map();
    for (const p of prows) {
      byId.set(p.parish_id, {
        id: p.parish_id, name: p.name, city: p.city, category: p.category || "Parish",
        boundary: AM.yes(p.boundary), region: p.region || "", notes: p.notes || "",
        tags: (p.tags || "").split(";").map((t) => t.trim()).filter(Boolean), sites: [], row: p,
      });
    }
    for (const l of lrows) {
      const p = byId.get(l.parish_id);
      const lat = parseFloat(l.lat), lng = parseFloat(l.lng);
      if (!p || !isFinite(lat) || !isFinite(lng)) continue;
      const t = tracts.find((f) => AM.pointInFeature(lng, lat, f));
      p.sites.push({ ...l, id: l.location_id, lat, lng, active: AM.yes(l.active), tract: t ? t.properties.GEOID : null,
        county: t ? t.properties.COUNTY : "" });
    }
    const out = [...byId.values()];
    for (const p of out) {
      p.activeSites = p.sites.filter((s) => s.active);
      const s0 = p.activeSites[0] || p.sites[0];
      p.county = s0 ? s0.county : "";
      p.label = p.name + (p.city ? ` (${p.city})` : "");
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  };

  // ------------------------------------------------------------------ territories
  /* mode "nearest": each tract belongs to the parish with the closest active
   *   site (distance from the tract's representative point). A tract that
   *   physically contains a site belongs to that parish; if sites of several
   *   parishes are in the same tract, it belongs to all of them (the only
   *   overlap). Parishes marked boundary = no (shrines, personal parishes...)
   *   do not take part and only get the tract(s) their sites are in.
   * mode "radius": all tracts whose representative point is within r miles of
   *   any active site, plus the tracts the sites are in (overlap allowed).
   */
  let distCache = null;
  function distances(parishes, tracts) {
    const key = parishes.map((p) => p.id + p.activeSites.map((s) => s.lat + "," + s.lng).join(";")).join("|");
    if (distCache && distCache.key === key) return distCache;
    const d = new Map();
    for (const p of parishes) {
      const arr = new Float64Array(tracts.length);
      tracts.forEach((t, i) => {
        let m = Infinity;
        for (const s of p.activeSites) m = Math.min(m, AM.miles(s.lat, s.lng, t.properties.lat, t.properties.lng));
        arr[i] = m;
      });
      d.set(p.id, arr);
    }
    distCache = { key, d };
    return distCache;
  }

  AM.computeTerritories = (parishes, tracts, mode, radius) => {
    const live = parishes.filter((p) => p.activeSites.length);
    const { d } = distances(live, tracts);
    const byParish = new Map(live.map((p) => [p.id, new Map()]));
    const byTract = new Map(tracts.map((t) => [t.properties.GEOID, []]));
    const add = (pid, i) => {
      const g = tracts[i].properties.GEOID;
      if (byParish.get(pid).has(g)) return;
      byParish.get(pid).set(g, d.get(pid)[i]);
      byTract.get(g).push(pid);
    };
    const idx = new Map(tracts.map((t, i) => [t.properties.GEOID, i]));
    const homeOf = (p) => [...new Set(p.activeSites.map((s) => s.tract).filter(Boolean))];

    if (mode === "radius") {
      for (const p of live) {
        const arr = d.get(p.id);
        for (let i = 0; i < tracts.length; i++) if (arr[i] <= radius) add(p.id, i);
        for (const g of homeOf(p)) add(p.id, idx.get(g));
      }
    } else {
      const bnd = live.filter((p) => p.boundary);
      const home = new Map();
      for (const p of bnd) for (const g of homeOf(p)) {
        if (!home.has(g)) home.set(g, []);
        home.get(g).push(p.id);
      }
      for (let i = 0; i < tracts.length; i++) {
        const g = tracts[i].properties.GEOID;
        if (home.has(g)) { home.get(g).forEach((pid) => add(pid, i)); continue; }
        let best = Infinity, who = [];
        for (const p of bnd) {
          const v = d.get(p.id)[i];
          if (v < best - 1e-9) { best = v; who = [p.id]; }
          else if (Math.abs(v - best) <= 1e-9) who.push(p.id);
        }
        who.forEach((pid) => add(pid, i));
      }
      for (const p of live.filter((p) => !p.boundary)) for (const g of homeOf(p)) add(p.id, idx.get(g));
    }
    return { byParish, byTract, mode, radius };
  };

  /* Give neighbouring territories different colours (greedy graph colouring). */
  AM.territoryColors = (terr, tracts) => {
    const adj = new Map([...terr.byParish.keys()].map((k) => [k, new Set()]));
    for (const t of tracts) {
      const a = terr.byTract.get(t.properties.GEOID) || [];
      for (const n of t.properties.nb || []) {
        for (const pb of terr.byTract.get(n) || []) for (const pa of a) if (pa !== pb) { adj.get(pa).add(pb); adj.get(pb).add(pa); }
      }
    }
    const order = [...adj.keys()].sort((x, y) => adj.get(y).size - adj.get(x).size || x.localeCompare(y));
    const color = new Map();
    for (const p of order) {
      const used = new Set([...adj.get(p)].map((q) => color.get(q)));
      let c = 0;
      while (used.has(c) && c < AM.CAT.length - 1) c++;
      color.set(p, c);
    }
    return new Map([...color].map(([k, v]) => [k, AM.CAT[v]]));
  };

  // ------------------------------------------------------------------ ACS tables
  AM.loadTable = async (id) => {
    const t = await AM.fetchJSON(`data/acs/${id}.json`);
    if (!t._prepared) {
      let i = 0;
      for (const c of t.columns) {
        c.ei = i++;
        c.mi = c.moe ? i++ : -1;
        c.key = `${t.id}:${c.id}`;
        c.table = t;
      }
      t.colById = new Map(t.columns.map((c) => [c.id, c]));
      t._prepared = true;
    }
    return t;
  };
  AM.getColumn = async (key) => {
    const [tid, cid] = key.split(":");
    try {
      const t = await AM.loadTable(tid);
      return t.colById.get(cid) || null;
    } catch (e) { return null; }
  };

  /* Combine tract values for a set of tracts. Returns Map colId -> {v, moe, n}. */
  AM.aggregate = (table, geoids, onlyCols) => {
    const res = new Map();
    const rows = [];
    for (const g of geoids) { const r = table.data[g]; if (r) rows.push(r); }
    const need = new Set();
    const want = onlyCols ? onlyCols : table.columns;
    for (const c of want) {
      need.add(c);
      for (const k of ["num", "den", "w"]) if (c.agg[k]) need.add(table.colById.get(c.agg[k]));
    }
    const sumOf = (c) => {
      if (res.has(c.id)) return res.get(c.id);
      let s = 0, m2 = 0, n = 0;
      for (const r of rows) {
        const v = r[c.ei];
        if (v !== null && v !== undefined) { s += v; n++; }
        if (c.mi >= 0) { const m = r[c.mi]; if (m !== null && m !== undefined) m2 += m * m; }
      }
      const out = { v: n ? s : null, moe: c.mi >= 0 && n ? Math.sqrt(m2) : null, n };
      res.set(c.id, out);
      return out;
    };
    for (const c of need) {
      const a = c.agg;
      if (a.kind === "sum") sumOf(c);
    }
    for (const c of need) {
      const a = c.agg;
      if (a.kind === "sum") continue;
      if (a.kind === "ratio") {
        const N = sumOf(table.colById.get(a.num)), D = sumOf(table.colById.get(a.den));
        const scale = a.scale ?? 100;
        res.set(c.id, { v: N.v !== null && D.v ? (scale * N.v) / D.v : null, n: Math.min(N.n, D.n) });
      } else {
        const w = a.kind === "wavg" ? table.colById.get(a.w) : null;
        let sw = 0, swv = 0, s = 0, n = 0;
        for (const r of rows) {
          const v = r[c.ei];
          if (v === null || v === undefined) continue;
          s += v; n++;
          const wt = w ? r[w.ei] : null;
          if (wt) { sw += wt; swv += wt * v; }
        }
        res.set(c.id, { v: sw > 0 ? swv / sw : n ? s / n : null, n, approx: n > 1 && (c.type === "median") });
      }
    }
    return res;
  };

  // ------------------------------------------------------------------ labels & formatting
  const TRIVIAL = new Set(["", "Total", "Estimate"]);
  AM.colShort = (c) => {
    const row = c.row.length ? c.row : [c.header];
    let last = row[row.length - 1];
    if (row.length > 1 && (last.length < 20 || /^(Male|Female|Under|[0-9]|\$|Less|More|Some|With|No |Not |In |Below|At |Native|Foreign)/.test(last))) {
      const parent = row[row.length - 2];
      if (parent !== parent.toUpperCase()) last = `${parent} › ${last}`;
    }
    return (TRIVIAL.has(c.header) ? "" : c.header + ": ") + last;
  };
  AM.colFull = (c) => [c.header, ...c.row].filter((s) => s && !TRIVIAL.has(s)).join(" › ");
  AM.typeBadge = (c) => ({ count: "#", percent: "%", median: "median", mean: "avg", density: "/mi²" }[c.type] || c.type);

  const isDollar = (c) => /dollar|income|earnings|rent|value/i.test(c.row.join(" ") + c.header);
  AM.fmt = (c, v) => {
    if (v === null || v === undefined || !isFinite(v)) return "–";
    switch (c.type) {
      case "count": return Math.round(v).toLocaleString();
      case "percent": return v.toFixed(1) + "%";
      case "density": return Math.round(v).toLocaleString();
      default:
        if (isDollar(c)) return "$" + Math.round(v).toLocaleString();
        return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1);
    }
  };
  AM.fmtMoe = (c, m) => (m === null || m === undefined ? "" : "±" + Math.round(m).toLocaleString());

  // quantile breaks for a sequential choropleth
  AM.quantileScale = (values) => {
    const v = values.filter((x) => x !== null && isFinite(x)).sort((a, b) => a - b);
    const k = AM.SEQ.length;
    const breaks = [];
    for (let i = 1; i < k; i++) breaks.push(v.length ? v[Math.floor((i * v.length) / k)] : 0);
    const color = (x) => {
      if (x === null || x === undefined || !isFinite(x)) return null;
      let i = 0;
      while (i < breaks.length && x >= breaks[i]) i++;
      return AM.SEQ[i];
    };
    return { breaks, color, min: v[0], max: v[v.length - 1] };
  };

  // ------------------------------------------------------------------ page chrome
  AM.header = (active) => {
    const h = document.querySelector("header.site");
    h.innerHTML = `
      <a class="brand" href="index.html">Archdiocese of Milwaukee <span>Parish Demographics</span></a>
      <nav>
        <a href="index.html" ${active === "overview" ? 'class="active"' : ""}>Overview</a>
        <a href="parish.html" ${active === "parish" ? 'class="active"' : ""}>Parish profile</a>
        <a href="edit.html" ${active === "edit" ? 'class="active"' : ""}>Edit parishes</a>
        <a href="about.html" ${active === "about" ? 'class="active"' : ""}>Methods & data</a>
      </nav>`;
    const edits = AM.getEdits();
    if (edits && active !== "edit") {
      const b = AM.el("div", { class: "banner" },
        `Showing <b>unsaved parish edits</b> stored in this browser (${new Date(edits.saved).toLocaleString()}).
         <a href="edit.html">Review / export them</a> or <button type="button">discard</button>.`);
      b.querySelector("button").onclick = () => { if (confirm("Discard all local parish edits?")) { AM.clearEdits(); location.reload(); } };
      h.after(b);
    }
  };

  AM.baseLayer = (map) => {
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>; tracts: U.S. Census Bureau',
      subdomains: "abcd", maxZoom: 19,
    }).addTo(map);
  };

  AM.legend = (container, title, scale, col) => {
    if (!scale) { container.innerHTML = ""; return; }
    const parts = [];
    const lo = [scale.min, ...scale.breaks];
    AM.SEQ.forEach((c, i) => {
      parts.push(`<span class="sw" style="background:${c}"></span><span class="lb">${AM.fmt(col, lo[i])}${i === AM.SEQ.length - 1 ? "+" : ""}</span>`);
    });
    container.innerHTML = `<div class="legend-title">${AM.esc(title)}</div><div class="legend-row">${parts.join("")}</div><div class="legend-note">Quantile classes; grey = no data</div>`;
  };

  // ------------------------------------------------------------------ boundary controls
  AM.boundaryControls = (container, state, onChange) => {
    container.innerHTML = `
      <span class="ctl-label">Parish area</span>
      <div class="seg" role="radiogroup">
        <label><input type="radio" name="bmode" value="nearest"> Nearest-parish tracts</label>
        <label><input type="radio" name="bmode" value="radius"> Tracts within</label>
      </div>
      <input type="number" class="radius" min="0.25" max="50" step="0.25" aria-label="radius in miles"> <span>miles</span>`;
    const radios = container.querySelectorAll("input[name=bmode]");
    const r = container.querySelector(".radius");
    const sync = () => {
      radios.forEach((x) => (x.checked = x.value === state.mode));
      r.value = state.radius;
      r.disabled = state.mode !== "radius";
    };
    sync();
    radios.forEach((x) => x.addEventListener("change", () => { state.mode = x.value; sync(); onChange(); }));
    r.addEventListener("change", () => {
      const v = parseFloat(r.value);
      if (v > 0) { state.radius = v; onChange(); }
    });
  };
  AM.readBoundaryState = (site) => {
    const st = AM.getState();
    return { mode: st.mode === "radius" ? "radius" : "nearest", radius: parseFloat(st.r) || site.default_radius_miles || 3 };
  };
  AM.writeBoundaryState = (s) => AM.setState({ mode: s.mode, r: s.mode === "radius" ? s.radius : "" });

  // ------------------------------------------------------------------ variable picker
  /* Opens a dialog to choose ACS variables. selected: array of "TABLE:COL" keys. */
  AM.pickVariables = (catalog, selected, onDone) => {
    const chosen = new Set(selected);
    const dlg = AM.el("dialog", { class: "picker" });
    dlg.innerHTML = `
      <form method="dialog" class="picker-inner">
        <div class="picker-head">
          <h2>Choose ACS variables</h2>
          <input type="search" placeholder="Search all tables (e.g. poverty, Spanish, travel time)…" class="psearch">
        </div>
        <div class="picker-body">
          <ul class="ptables"></ul>
          <div class="pcols"><p class="muted">Pick a table on the left, or search.</p></div>
        </div>
        <div class="picker-foot">
          <span class="pcount"></span>
          <button value="cancel" class="btn-secondary">Cancel</button>
          <button value="ok" class="btn-primary">Apply</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    const ul = dlg.querySelector(".ptables"), pc = dlg.querySelector(".pcols"), count = dlg.querySelector(".pcount");
    const updCount = () => (count.textContent = `${chosen.size} selected`);
    updCount();
    let current = null;

    const renderCols = (cols, groupFilter, showTable, target = pc) => {
      target.innerHTML = "";
      if (!cols.length) { target.innerHTML = '<p class="muted">No matching variables.</p>'; return; }
      const list = AM.el("div", { class: "plist" });
      let lastHead = null;
      for (const c of cols.slice(0, 600)) {
        if (c.hidden) continue;
        if (groupFilter && c.header !== groupFilter) continue;
        const head = showTable ? `${c.table.table} · ${c.table.title}` : null;
        if (head && head !== lastHead) { list.appendChild(AM.el("div", { class: "phead" }, AM.esc(head))); lastHead = head; }
        const depth = Math.max(0, c.row.length - 1);
        const lab = AM.el("label", { class: "pitem", style: `padding-left:${0.4 + depth * 0.9}rem`, title: AM.colFull(c) + " — " + c.id });
        const cb = AM.el("input", { type: "checkbox" });
        cb.checked = chosen.has(c.key);
        cb.onchange = () => { cb.checked ? chosen.add(c.key) : chosen.delete(c.key); updCount(); };
        lab.appendChild(cb);
        const txt = showTable ? AM.colFull(c) : (c.row[c.row.length - 1] || c.header);
        lab.appendChild(AM.el("span", {}, `${AM.esc(txt)} <em class="badge">${AM.typeBadge(c)}</em>`));
        list.appendChild(lab);
      }
      target.appendChild(list);
    };

    const showTable = async (meta) => {
      current = meta.id;
      ul.querySelectorAll("li").forEach((li) => li.classList.toggle("on", li.dataset.id === meta.id));
      const t = await AM.loadTable(meta.id);
      const heads = [...new Set(t.columns.filter((c) => !c.hidden).map((c) => c.header))];
      pc.innerHTML = "";
      const host = AM.el("div");
      const top = AM.el("div", { class: "pcols-top" }, `<div><b>${AM.esc(t.table)}</b> ${AM.esc(t.title)} <span class="muted">${AM.esc(t.dataset)} ${AM.esc(t.year)}</span></div>`);
      let filter = heads[0];
      if (heads.length > 1) {
        const tabs = AM.el("div", { class: "tabs" });
        heads.forEach((h) => {
          const b = AM.el("button", { type: "button", class: h === filter ? "on" : "" }, AM.esc(h || "Estimate"));
          b.onclick = () => { filter = h; tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); renderCols(t.columns, filter, false, host); };
          tabs.appendChild(b);
        });
        top.appendChild(tabs);
      }
      pc.append(top, host);
      renderCols(t.columns, heads.length > 1 ? filter : null, false, host);
    };

    for (const meta of catalog.tables) {
      const li = AM.el("li", { "data-id": meta.id }, `<b>${AM.esc(meta.table)}</b> ${AM.esc(meta.title)}<br><span class="muted">${AM.esc(meta.year)} ${meta.missing_tracts ? `· ${meta.missing_tracts} tracts missing` : ""}</span>`);
      li.onclick = () => showTable(meta);
      ul.appendChild(li);
    }
    const search = dlg.querySelector(".psearch");
    let timer;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = search.value.trim().toLowerCase();
        if (!q) { if (current) showTable(catalog.tables.find((t) => t.id === current)); return; }
        const tables = await Promise.all(catalog.tables.map((m) => AM.loadTable(m.id)));
        const words = q.split(/\s+/);
        const hits = [];
        for (const t of tables) for (const c of t.columns) {
          const hay = (AM.colFull(c) + " " + c.id + " " + t.title).toLowerCase();
          if (words.every((w) => hay.includes(w))) hits.push(c);
        }
        ul.querySelectorAll("li").forEach((li) => li.classList.remove("on"));
        renderCols(hits, null, true);
      }, 200);
    });
    dlg.addEventListener("close", () => {
      if (dlg.returnValue === "ok") {
        const order = selected.filter((k) => chosen.has(k)).concat([...chosen].filter((k) => !selected.includes(k)));
        onDone(order);
      }
      dlg.remove();
    });
    dlg.showModal();
    if (catalog.tables.length) showTable(catalog.tables[0]);
  };
})();
