/* Single-parish demographic profile. URL: parish.html?id=<parish_id>#mode=nearest|radius&r=<miles>&vars=... */
(async function () {
  "use strict";
  AM.header("parish");
  const base = await AM.loadBase();
  const { tracts, parishes, catalog, site } = base;
  const allTractIds = tracts.map((t) => t.properties.GEOID);
  const pid = new URLSearchParams(location.search).get("id");
  const parish = base.parishById.get(pid);
  const bstate = AM.readBoundaryState(site);
  let vars = AM.selectedVars(catalog.defaults || []);
  const content = document.getElementById("content");

  setupChooser();
  if (!parish) {
    content.innerHTML = `<div class="card"><h1>Parish profiles</h1><p>Choose a parish above, or from the list below.</p>
      <ul style="columns: 18rem">${parishes.map((p) => `<li><a href="parish.html?id=${encodeURIComponent(p.id)}${location.hash}">${AM.esc(p.label)}</a></li>`).join("")}</ul></div>`;
    document.getElementById("bctl").hidden = true;
    return;
  }
  document.title = `${parish.label} — Parish Profile`;

  content.innerHTML = `
    <section class="card">
      <div class="ph-head">
        <div>
          <h1>${AM.esc(parish.name)} <span class="muted" style="font-weight:400">${AM.esc(parish.city)}</span></h1>
          <div><span class="pill">${AM.esc(parish.category)}</span> ${parish.region ? `<span class="pill">${AM.esc(parish.region)}</span>` : ""}
            ${parish.tags.map((t) => `<span class="pill">${AM.esc(t)}</span>`).join(" ")}
            ${!parish.boundary ? '<span class="pill warn" title="Set boundary = no in data/parishes.csv">no territory in nearest-parish mode</span>' : ""}
            <span class="muted small">${AM.esc(parish.county)} County</span></div>
          ${parish.notes ? `<p class="small muted">${AM.esc(parish.notes)}</p>` : ""}
          <ul class="sites">${parish.sites.map((s) => `<li><b>${AM.esc(s.site_name)}</b>${s.active ? "" : ' <span class="pill">inactive</span>'} — ${AM.esc(s.address)}
            ${s.phone ? ` · ${AM.esc(s.phone)}` : ""} ${s.url ? ` · <a href="${AM.esc(s.url)}" target="_blank" rel="noopener">archmil.org</a>` : ""}</li>`).join("")}</ul>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <a class="btn-secondary" style="text-decoration:none" href="edit.html?id=${encodeURIComponent(parish.id)}">Correct this parish</a>
          <button class="btn-secondary" id="csv" type="button">Download profile CSV</button>
        </div>
      </div>
    </section>
    <div class="grid2">
      <div class="map-wrap"><div id="map"></div></div>
      <div>
        <div class="table-tools"><h2 style="margin:0">Key figures</h2><span class="spacer"></span>
          <button class="btn-secondary" id="addVars" type="button">Choose variables</button></div>
        <div class="stats" id="stats"></div>
        <p class="muted small" id="areaNote"></p>
      </div>
    </div>
    <h2 style="margin-top:1rem">Full ACS profile</h2>
    <p class="muted small">Each table is combined over the parish's tracts. Grey figures are the archdiocese as a whole; percentages in brackets are shares of the parent row.</p>
    <div id="tables"></div>
    <details class="acs"><summary>Census tracts in this parish area (<span id="ntr"></span>)</summary><div id="tractList"></div></details>`;

  // ------------------------------------------------------------ map
  const map = L.map("map", { preferCanvas: true, zoomSnap: 0.5 }).setView([43.05, -88.1], 9);
  AM.baseLayer(map);
  const terrLayer = L.layerGroup().addTo(map);
  for (const p of parishes) {
    if (p.id === parish.id) continue;
    for (const s of p.activeSites) {
      L.circleMarker([s.lat, s.lng], { radius: 3.5, weight: 1, color: "#fff", fillColor: "#7a7974", fillOpacity: 1 })
        .bindTooltip(AM.esc(p.label), { className: "tt" })
        .on("click", () => (location.href = `parish.html?id=${encodeURIComponent(p.id)}${location.hash}`))
        .addTo(map);
    }
  }
  const siteMarkers = parish.sites.map((s) => L.circleMarker([s.lat, s.lng], {
    radius: 7, weight: 2, color: "#fff", fillColor: s.active ? "#7a1f2b" : "#999", fillOpacity: 1,
  }).bindTooltip(`<b>${AM.esc(s.site_name)}</b><br>${AM.esc(s.address)}`, { className: "tt" }).addTo(map));

  let terr, geoids = [];
  const dioceseCache = new Map();

  function draw() {
    terr = AM.computeTerritories(parishes, tracts, bstate.mode, bstate.radius);
    const gs = terr.byParish.get(parish.id) || new Map();
    geoids = [...gs.keys()];
    terrLayer.clearLayers();
    const feats = geoids.map((g) => base.tractById.get(g));
    const lyr = L.geoJSON({ type: "FeatureCollection", features: feats }, {
      style: (f) => {
        const shared = (terr.byTract.get(f.properties.GEOID) || []).length > 1;
        return { color: "#7a1f2b", weight: 1.2, fillColor: "#a8323f", fillOpacity: shared ? 0.12 : 0.25, dashArray: shared ? "3 3" : null };
      },
      onEachFeature: (f, l) => l.bindTooltip(() => {
        const others = (terr.byTract.get(f.properties.GEOID) || []).filter((x) => x !== parish.id).map((x) => base.parishById.get(x).label);
        return `<b>${AM.esc(f.properties.NAME)}</b>, ${AM.esc(f.properties.COUNTY)} Co.<br>${gs.get(f.properties.GEOID).toFixed(1)} mi from nearest site` +
          (others.length ? `<br>Shared with: ${AM.esc(others.join(", "))}` : "");
      }, { sticky: true, className: "tt" }),
    }).addTo(terrLayer);
    if (bstate.mode === "radius") {
      for (const s of parish.activeSites) L.circle([s.lat, s.lng], { radius: bstate.radius * 1609.34, color: "#7a1f2b", weight: 1.5, dashArray: "5 5", fill: false, interactive: false }).addTo(terrLayer);
    }
    siteMarkers.forEach((m) => m.bringToFront());
    const b = feats.length ? lyr.getBounds() : L.latLngBounds(parish.sites.map((s) => [s.lat, s.lng]));
    map.fitBounds(b, { padding: [25, 25], maxZoom: 14 });

    const area = feats.reduce((s, f) => s + (f.properties.ALAND_SQMI || 0), 0);
    const shared = geoids.filter((g) => terr.byTract.get(g).length > 1).length;
    document.getElementById("areaNote").textContent =
      (bstate.mode === "nearest"
        ? (parish.boundary ? "Area = tracts closer to this parish's sites than to any other parish." : "This parish does not take territory; showing the tract(s) its sites are in.")
        : `Area = tracts whose centre is within ${bstate.radius} miles of an active site.`) +
      ` ${geoids.length} tracts, ${area.toFixed(1)} sq mi of land${shared ? `, ${shared} shared with other parishes` : ""}.`;
    document.getElementById("ntr").textContent = geoids.length;
    renderTractList(gs);
    renderStats();
    renderTables();
  }

  // ------------------------------------------------------------ key figures
  async function renderStats() {
    const box = document.getElementById("stats");
    const cols = (await Promise.all(vars.map((k) => AM.getColumn(k)))).filter(Boolean);
    const area = geoids.reduce((s, g) => s + (base.tractById.get(g).properties.ALAND_SQMI || 0), 0);
    const cards = [`<div class="stat"><div class="k">Census tracts</div><div class="v">${geoids.length}</div><div class="c">${area.toFixed(1)} sq mi land</div></div>`];
    for (const c of cols) {
      const v = AM.aggregate(c.table, geoids, [c]).get(c.id);
      const d = dioceseAgg(c.table).get(c.id);
      cards.push(`<div class="stat" title="${AM.esc(AM.colFull(c))} (${AM.esc(c.table.table)} ${AM.esc(c.id)})">
        <div class="k">${AM.esc(AM.colShort(c))}</div><div class="v">${AM.fmt(c, v?.v)}</div>
        <div class="c">Archdiocese ${AM.fmt(c, d?.v)}${c.type === "median" ? " · approx." : ""}${v?.moe ? " · " + AM.fmtMoe(c, v.moe) : ""}</div></div>`);
    }
    box.innerHTML = cards.join("");
  }
  function dioceseAgg(t) {
    if (!dioceseCache.has(t.id)) dioceseCache.set(t.id, AM.aggregate(t, allTractIds));
    return dioceseCache.get(t.id);
  }
  document.getElementById("addVars").onclick = () => AM.pickVariables(catalog, vars, (v) => { vars = v; AM.saveVars(vars); renderStats(); });

  // ------------------------------------------------------------ full tables
  async function renderTables() {
    const host = document.getElementById("tables");
    if (!host.children.length) {
      for (const meta of catalog.tables) {
        const d = AM.el("details", { class: "acs", "data-id": meta.id });
        d.innerHTML = `<summary>${AM.esc(meta.table)} · ${AM.esc(meta.title)} <span class="muted small">${AM.esc(meta.dataset)} ${AM.esc(meta.year)}</span>
          ${meta.missing_tracts ? `<span class="pill warn">${meta.missing_tracts} tracts without data</span>` : ""}</summary><div></div>`;
        d.addEventListener("toggle", () => { if (d.open) renderMatrix(d, meta); });
        host.appendChild(d);
      }
      const first = host.querySelector("details");
      if (first) first.open = true;
    }
    host.querySelectorAll("details[open]").forEach((d) => renderMatrix(d, catalog.tables.find((m) => m.id === d.dataset.id)));
  }

  async function renderMatrix(d, meta) {
    const t = await AM.loadTable(meta.id);
    const P = AM.aggregate(t, geoids), D = dioceseAgg(t);
    const cols = t.columns.filter((c) => !c.hidden);
    const heads = [...new Set(cols.map((c) => c.header))];
    const rows = new Map();
    for (const c of cols) {
      const k = c.row.join("!!");
      if (!rows.has(k)) rows.set(k, { row: c.row, cells: new Map() });
      rows.get(k).cells.set(c.header, c);
    }
    const covered = geoids.filter((g) => t.data[g]).length;
    const cell = (c) => {
      if (!c) return "<td></td>";
      const p = P.get(c.id), dd = D.get(c.id);
      let share = "";
      if (c.type === "count" && c.agg.parent && p?.v !== null) {
        const par = P.get(c.agg.parent);
        if (par?.v) share = ` <span class="muted small">(${((100 * p.v) / par.v).toFixed(1)}%)</span>`;
      }
      return `<td title="${AM.esc(c.id)}${p?.moe ? " · margin of error " + AM.fmtMoe(c, p.moe) : ""}">${AM.fmt(c, p?.v)}${share}<span class="cmp">${AM.fmt(c, dd?.v)}</span></td>`;
    };
    const showHeads = heads.length > 1 || (heads[0] && heads[0] !== "Estimate");
    const emitted = new Set();
    const pad = (depth) => `padding-left:${0.55 + depth * 0.9}rem`;
    const body = [...rows.values()].map((r) => {
      let html = "";
      // headings for ancestors that are not rows themselves (e.g. "AGE", "Speak a language other than English at home")
      for (let i = 1; i < r.row.length; i++) {
        const k = r.row.slice(0, i).join("!!");
        if (emitted.has(k) || rows.has(k)) continue;
        emitted.add(k);
        html += `<tr class="sec"><td class="l" colspan="${heads.length + 1}" style="${pad(i - 1)}">${AM.esc(r.row[i - 1])}</td></tr>`;
      }
      emitted.add(r.row.join("!!"));
      const depth = Math.max(0, r.row.length - 1);
      const label = r.row.length ? r.row[r.row.length - 1] : "(all)";
      const meds = [...r.cells.values()].some((c) => c.type === "median");
      return html + `<tr><td class="l" style="${pad(depth)}">${AM.esc(label)}${meds ? ' <span class="muted small">(approx.)</span>' : ""}</td>${heads.map((h) => cell(r.cells.get(h))).join("")}</tr>`;
    }).join("");
    d.querySelector("div").innerHTML = `
      <p class="muted small">${covered} of ${geoids.length} tracts in this area have data for this table. ${AM.esc(t.source)}</p>
      <div class="tscroll" style="max-height:none"><table class="data matrix">
        ${showHeads ? `<thead><tr><th class="l">Characteristic</th>${heads.map((h) => `<th>${AM.esc(h)}</th>`).join("")}</tr></thead>` : ""}
        <tbody>${body}</tbody></table></div>`;
  }

  // ------------------------------------------------------------ tract list
  function renderTractList(gs) {
    const rows = [...gs].sort((a, b) => a[1] - b[1]).map(([g, dist]) => {
      const p = base.tractById.get(g).properties;
      const others = terr.byTract.get(g).filter((x) => x !== parish.id).map((x) => base.parishById.get(x).label).join(", ");
      return `<tr><td class="l">${AM.esc(p.NAME)}</td><td class="l">${g}</td><td class="l">${AM.esc(p.COUNTY)}</td><td>${dist.toFixed(2)}</td><td>${(p.ALAND_SQMI || 0).toFixed(2)}</td><td class="l">${AM.esc(others)}</td></tr>`;
    }).join("");
    document.getElementById("tractList").innerHTML = `<div class="tscroll"><table class="data"><thead><tr><th class="l">Tract</th><th class="l">GEOID</th><th class="l">County</th><th>Miles to site</th><th>Land sq mi</th><th class="l">Shared with</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ------------------------------------------------------------ export
  document.getElementById("csv").onclick = async () => {
    const out = [];
    for (const meta of catalog.tables) {
      const t = await AM.loadTable(meta.id);
      const P = AM.aggregate(t, geoids), D = dioceseAgg(t);
      for (const c of t.columns) {
        if (c.hidden) continue;
        const p = P.get(c.id), d = D.get(c.id);
        out.push([meta.table, meta.title, c.id, AM.colFull(c), c.type, p?.v ?? "", p?.moe ?? "", d?.v ?? ""]);
      }
    }
    const def = bstate.mode === "nearest" ? "nearest" : `radius_${bstate.radius}mi`;
    AM.download(`${parish.id}_${def}.csv`, AM.toCSV(["table", "table_title", "column", "label", "type", "parish_value", "parish_moe", "archdiocese_value"], out));
  };

  AM.boundaryControls(document.getElementById("bctl"), bstate, () => { AM.writeBoundaryState(bstate); draw(); });
  draw();

  // ------------------------------------------------------------ chooser
  function setupChooser() {
    const inp = document.getElementById("chooser"), ul = document.getElementById("chooserList");
    let hl = 0, items = [];
    const render = () => {
      const q = inp.value.trim().toLowerCase();
      items = parishes.filter((p) => !q || (p.label + " " + p.sites.map((s) => s.site_name).join(" ")).toLowerCase().includes(q)).slice(0, 40);
      hl = Math.min(hl, items.length - 1);
      ul.innerHTML = items.map((p, i) => `<li><a class="${i === hl ? "hl" : ""}" href="parish.html?id=${encodeURIComponent(p.id)}${location.hash}">${AM.esc(p.label)}</a></li>`).join("");
      ul.hidden = !items.length;
    };
    inp.addEventListener("focus", render);
    inp.addEventListener("input", () => { hl = 0; render(); });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { hl = Math.min(hl + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { hl = Math.max(hl - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter" && items[hl]) location.href = `parish.html?id=${encodeURIComponent(items[hl].id)}${location.hash}`;
      else if (e.key === "Escape") ul.hidden = true;
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".chooser")) ul.hidden = true; });
  }
})();
