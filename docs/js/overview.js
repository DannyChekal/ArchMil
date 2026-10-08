/* Archdiocese overview: territory map + sortable, filterable table of parishes. */
(async function () {
  "use strict";
  AM.header("overview");
  const base = await AM.loadBase();
  const { tracts, parishes, catalog, site } = base;
  const allTractIds = tracts.map((t) => t.properties.GEOID);

  const bstate = AM.readBoundaryState(site);
  let vars = AM.selectedVars(catalog.defaults || []);
  const st0 = AM.getState();
  const ui = {
    sort: st0.sort || "name", dir: st0.dir === "desc" ? -1 : 1,
    colorBy: st0.color || "territory", level: st0.level === "parish" ? "parish" : "tract",
    selected: null, filters: {},
  };
  let terr, cols = [], values = new Map(), totals = new Map(), tractVals = new Map(), colors;

  // ------------------------------------------------------------ map
  const map = L.map("map", { preferCanvas: true, zoomSnap: 0.5 }).setView([43.05, -88.1], 9);
  AM.baseLayer(map);
  const tractLayer = L.geoJSON(base.tractsGJ, { style: () => ({}), onEachFeature: bindTract }).addTo(map);
  const selLayer = L.layerGroup().addTo(map);
  const siteLayer = L.layerGroup().addTo(map);
  map.fitBounds(tractLayer.getBounds(), { padding: [10, 10], animate: false });

  function bindTract(f, layer) {
    layer.on("click", () => {
      const ps = terr.byTract.get(f.properties.GEOID) || [];
      if (ps.length) select(ps[0], true);
    });
    layer.bindTooltip(() => tractTooltip(f), { sticky: true, className: "tt" });
  }
  function tractTooltip(f) {
    const g = f.properties.GEOID;
    const ps = (terr.byTract.get(g) || []).map((id) => base.parishById.get(id).label);
    const c = currentColorCol();
    let val = "";
    if (c) {
      const v = ui.level === "parish" && terr.mode === "nearest" ? parishValueForTract(g, c) : tractVals.get(c.key)?.get(g);
      val = `<br>${AM.esc(AM.colShort(c))}: <b>${AM.fmt(c, v)}</b>${ui.level === "parish" ? " (parish)" : ""}`;
    }
    return `<b>${AM.esc(f.properties.NAME)}</b>, ${AM.esc(f.properties.COUNTY)} Co.${val}<br>` +
      (ps.length ? AM.esc(ps.join(" · ")) : '<span class="muted">no parish</span>');
  }

  function drawSites() {
    siteLayer.clearLayers();
    for (const p of parishes) {
      for (const s of p.sites) {
        const m = L.circleMarker([s.lat, s.lng], {
          radius: s.active ? 5 : 3, weight: 1.5, color: "#fff", fillColor: s.active ? (p.boundary ? "#7a1f2b" : "#4a3aa7") : "#999",
          fillOpacity: 1,
        });
        m.bindTooltip(`<b>${AM.esc(p.label)}</b>${p.sites.length > 1 ? "<br>" + AM.esc(s.site_name) : ""}${s.active ? "" : " (inactive)"}`, { className: "tt" });
        m.on("click", () => select(p.id, true));
        m.addTo(siteLayer);
      }
    }
  }

  function currentColorCol() {
    return ui.colorBy.includes(":") ? cols.find((c) => c.key === ui.colorBy) : null;
  }
  function parishValueForTract(g, c) {
    const ps = terr.byTract.get(g) || [];
    return ps.length ? values.get(ps[0])?.get(c.key)?.v ?? null : null;
  }

  function styleMap() {
    const c = currentColorCol();
    const legend = document.getElementById("legend");
    if (ui.colorBy === "territory") {
      if (terr.mode === "nearest") {
        tractLayer.setStyle((f) => {
          const ps = terr.byTract.get(f.properties.GEOID) || [];
          return { color: "#ffffff", weight: 0.6, fillOpacity: ps.length ? 0.5 : 0.05, fillColor: ps.length ? colors.get(ps[0]) : "#999" };
        });
        legend.innerHTML = `<div class="legend-title">Nearest-parish territories</div><div class="legend-note">Colours only separate neighbouring parishes. Hover a tract for its parish.</div>`;
      } else {
        const counts = new Map(tracts.map((t) => [t.properties.GEOID, (terr.byTract.get(t.properties.GEOID) || []).length]));
        const sc = AM.quantileScale([...counts.values()].filter((x) => x > 0));
        tractLayer.setStyle((f) => {
          const n = counts.get(f.properties.GEOID);
          return { color: "#ffffff", weight: 0.6, fillOpacity: n ? 0.7 : 0.05, fillColor: n ? sc.color(n) : "#999" };
        });
        AM.legend(legend, `Parishes within ${terr.radius} mi`, sc, { type: "count" });
      }
      return;
    }
    if (!c) return;
    const byParish = ui.level === "parish" && terr.mode === "nearest";
    const get = byParish ? (g) => parishValueForTract(g, c) : (g) => tractVals.get(c.key)?.get(g) ?? null;
    const vals = byParish ? parishes.map((p) => values.get(p.id)?.get(c.key)?.v ?? null) : allTractIds.map(get);
    const sc = AM.quantileScale(vals);
    tractLayer.setStyle((f) => {
      const col = sc.color(get(f.properties.GEOID));
      return { color: byParish ? "#ffffff" : "#ffffff", weight: byParish ? 0.3 : 0.6, fillOpacity: col ? 0.75 : 0.25, fillColor: col || "#bbb" };
    });
    AM.legend(legend, AM.colShort(c) + (byParish ? " — parish value" : " — tract value"), sc, c);
  }

  function drawSelection() {
    selLayer.clearLayers();
    if (!ui.selected) return;
    const gs = terr.byParish.get(ui.selected);
    if (!gs) return;
    const feats = [...gs.keys()].map((g) => base.tractById.get(g));
    const lyr = L.geoJSON({ type: "FeatureCollection", features: feats }, {
      style: { color: "#1d1d1b", weight: 2, fill: true, fillOpacity: 0.08, fillColor: "#000" }, interactive: false,
    }).addTo(selLayer);
    if (terr.mode === "radius") {
      for (const s of base.parishById.get(ui.selected).activeSites) {
        L.circle([s.lat, s.lng], { radius: terr.radius * 1609.34, color: "#7a1f2b", weight: 1.5, dashArray: "4 4", fill: false, interactive: false }).addTo(selLayer);
      }
    }
    return lyr;
  }

  function select(pid, fromMap) {
    ui.selected = ui.selected === pid && !fromMap ? null : pid;
    const lyr = drawSelection();
    document.querySelectorAll("#ptable tbody tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.id === ui.selected));
    if (ui.selected && fromMap) {
      const tr = document.querySelector(`#ptable tbody tr[data-id="${CSS.escape(pid)}"]`);
      if (tr) tr.scrollIntoView({ block: "nearest" });
    } else if (ui.selected && lyr) {
      map.fitBounds(lyr.getBounds(), { maxZoom: 13, padding: [30, 30] });
    }
  }

  // ------------------------------------------------------------ data
  async function loadCols() {
    const found = await Promise.all(vars.map((k) => AM.getColumn(k)));
    cols = found.filter(Boolean);
    if (cols.length !== vars.length) { vars = cols.map((c) => c.key); }
  }

  function computeValues() {
    values = new Map();
    totals = new Map();
    tractVals = new Map();
    const byTable = new Map();
    for (const c of cols) {
      if (!byTable.has(c.table)) byTable.set(c.table, []);
      byTable.get(c.table).push(c);
    }
    for (const p of parishes) values.set(p.id, new Map());
    for (const [t, tcols] of byTable) {
      for (const p of parishes) {
        const gs = terr.byParish.get(p.id);
        if (!gs) continue;
        const agg = AM.aggregate(t, gs.keys(), tcols);
        for (const c of tcols) values.get(p.id).set(c.key, agg.get(c.id));
      }
      const all = AM.aggregate(t, allTractIds, tcols);
      for (const c of tcols) {
        totals.set(c.key, all.get(c.id));
        const m = new Map();
        for (const g of allTractIds) {
          const r = t.data[g];
          if (!r) continue;
          if (c.agg.kind === "ratio") {
            const n = r[t.colById.get(c.agg.num).ei], d = r[t.colById.get(c.agg.den).ei];
            m.set(g, n !== null && d ? ((c.agg.scale ?? 100) * n) / d : null);
          } else m.set(g, r[c.ei]);
        }
        tractVals.set(c.key, m);
      }
    }
  }

  function recompute() {
    terr = AM.computeTerritories(parishes, tracts, bstate.mode, bstate.radius);
    colors = AM.territoryColors(terr, tracts);
    computeValues();
    fillColorSelect();
    styleMap();
    drawSelection();
    renderTable();
  }

  // ------------------------------------------------------------ controls
  AM.boundaryControls(document.getElementById("bctl"), bstate, () => {
    AM.writeBoundaryState(bstate);
    document.getElementById("levelSeg").style.opacity = bstate.mode === "nearest" ? 1 : 0.4;
    recompute();
  });
  document.getElementById("levelSeg").style.opacity = bstate.mode === "nearest" ? 1 : 0.4;
  document.querySelectorAll("input[name=level]").forEach((r) => {
    r.checked = r.value === ui.level;
    r.addEventListener("change", () => { ui.level = r.value; AM.setState({ level: ui.level === "parish" ? "parish" : "" }); styleMap(); });
  });

  const colorSel = document.getElementById("colorBy");
  function fillColorSelect() {
    if (ui.colorBy !== "territory" && !cols.some((c) => c.key === ui.colorBy)) ui.colorBy = "territory";
    colorSel.innerHTML = `<option value="territory">${bstate.mode === "nearest" ? "Parish territories" : "Parish coverage (count)"}</option>` +
      cols.map((c) => `<option value="${AM.esc(c.key)}">${AM.esc(AM.colShort(c))} (${AM.esc(c.table.table)})</option>`).join("");
    colorSel.value = ui.colorBy;
  }
  colorSel.addEventListener("change", () => { ui.colorBy = colorSel.value; AM.setState({ color: ui.colorBy === "territory" ? "" : ui.colorBy }); styleMap(); renderTable(); });

  const uniq = (a) => [...new Set(a.filter(Boolean))].sort();
  const fill = (id, items) => {
    const s = document.getElementById(id);
    for (const v of items) s.appendChild(AM.el("option", { value: v }, AM.esc(v)));
    s.addEventListener("change", renderTable);
    if (items.length === 0 && id === "fRegion") s.hidden = true;
  };
  fill("fCategory", uniq(parishes.map((p) => p.category)));
  fill("fCounty", uniq(parishes.map((p) => p.county)));
  fill("fRegion", uniq(parishes.map((p) => p.region)));
  document.getElementById("q").addEventListener("input", renderTable);
  document.getElementById("addVars").onclick = () =>
    AM.pickVariables(catalog, vars, async (v) => { vars = v; AM.saveVars(vars); await loadCols(); computeValues(); fillColorSelect(); styleMap(); renderTable(); });
  document.getElementById("csv").onclick = exportCSV;

  // ------------------------------------------------------------ table
  const baseCols = [
    { key: "name", label: "Parish", get: (p) => p.label, cls: "l" },
    { key: "county", label: "County", get: (p) => p.county, cls: "l" },
    { key: "category", label: "Category", get: (p) => p.category, cls: "l" },
    { key: "sites", label: "Sites", get: (p) => p.activeSites.length },
    { key: "tracts", label: "Tracts", get: (p) => terr.byParish.get(p.id)?.size ?? 0 },
  ];
  const valOf = (p, key) => {
    const b = baseCols.find((c) => c.key === key);
    if (b) return b.get(p);
    return values.get(p.id)?.get(key)?.v ?? null;
  };

  function filtered() {
    const q = document.getElementById("q").value.trim().toLowerCase();
    const cat = document.getElementById("fCategory").value, co = document.getElementById("fCounty").value, rg = document.getElementById("fRegion").value;
    return parishes.filter((p) => {
      if (cat && p.category !== cat) return false;
      if (co && p.county !== co) return false;
      if (rg && p.region !== rg) return false;
      if (q && !(p.label + " " + p.region + " " + p.tags.join(" ") + " " + p.sites.map((s) => s.site_name + " " + s.city).join(" ")).toLowerCase().includes(q)) return false;
      for (const [k, f] of Object.entries(ui.filters)) {
        const v = valOf(p, k);
        if (f.min !== "" && f.min !== undefined && !(v !== null && v >= +f.min)) return false;
        if (f.max !== "" && f.max !== undefined && !(v !== null && v <= +f.max)) return false;
      }
      return true;
    });
  }

  function sorted(rows) {
    const k = ui.sort, dir = ui.dir;
    return rows.slice().sort((a, b) => {
      const va = valOf(a, k), vb = valOf(b, k);
      if (va === null && vb === null) return a.label.localeCompare(b.label);
      if (va === null) return 1;
      if (vb === null) return -1;
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * dir || a.label.localeCompare(b.label);
    });
  }

  function renderTable() {
    const tbl = document.getElementById("ptable");
    const arrow = (k) => (ui.sort === k ? `<span class="arrow">${ui.dir > 0 ? "▲" : "▼"}</span>` : "");
    const head = baseCols.map((c) => `<th class="sortable ${c.cls || ""}" data-k="${c.key}">${c.label} ${arrow(c.key)}</th>`).join("") +
      cols.map((c) => `<th class="sortable var" data-k="${AM.esc(c.key)}" title="${AM.esc(AM.colFull(c))} — ${AM.esc(c.table.title)} (${AM.esc(c.id)})">
        <span class="vname">${AM.esc(AM.colShort(c))} ${arrow(c.key)}</span>
        <span class="vtab">${AM.esc(c.table.table)} ${c.type === "median" ? "· approx." : ""}
          <button class="colorby ${ui.colorBy === c.key ? "on" : ""}" data-color="${AM.esc(c.key)}" title="Show on map" type="button">◐</button>
          <button class="rm" data-rm="${AM.esc(c.key)}" title="Remove column" type="button">×</button></span></th>`).join("");
    const filt = baseCols.map((c) => (["sites", "tracts"].includes(c.key) ? filterCell(c.key) : "<th></th>")).join("") + cols.map((c) => filterCell(c.key)).join("");
    const rows = sorted(filtered());
    const body = rows.map((p) => {
      const tds = baseCols.map((c) => {
        if (c.key === "name") {
          const flag = !p.boundary ? ' <span class="pill" title="Not assigned territory in nearest-parish mode">no territory</span>' : "";
          return `<td class="l"><a href="parish.html?id=${encodeURIComponent(p.id)}${location.hash}">${AM.esc(p.name)}</a> <span class="muted small">${AM.esc(p.city)}</span>${flag}</td>`;
        }
        return `<td class="${c.cls || ""}">${AM.esc(c.get(p))}</td>`;
      }).join("") + cols.map((c) => {
        const r = values.get(p.id)?.get(c.key);
        return `<td>${AM.fmt(c, r?.v)}</td>`;
      }).join("");
      return `<tr data-id="${AM.esc(p.id)}" class="${ui.selected === p.id ? "sel" : ""}">${tds}</tr>`;
    }).join("");
    const foot = `<tr><td class="l">Archdiocese (all ${allTractIds.length} tracts)</td><td></td><td></td><td>${parishes.reduce((s, p) => s + p.activeSites.length, 0)}</td><td>${allTractIds.length}</td>` +
      cols.map((c) => `<td>${AM.fmt(c, totals.get(c.key)?.v)}</td>`).join("") + "</tr>";
    tbl.innerHTML = `<thead><tr>${head}</tr><tr class="filters">${filt}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot>`;
    const h = tbl.querySelector("thead tr").getBoundingClientRect().height;
    tbl.style.setProperty("--head-h", h + "px");
    document.getElementById("rowCount").textContent = `${rows.length} of ${parishes.length} parishes`;

    tbl.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const k = th.dataset.k;
      if (ui.sort === k) ui.dir = -ui.dir;
      else { ui.sort = k; ui.dir = ["name", "county", "category"].includes(k) ? 1 : -1; }
      AM.setState({ sort: ui.sort, dir: ui.dir < 0 ? "desc" : "" });
      renderTable();
    }));
    tbl.querySelectorAll("button[data-rm]").forEach((b) => b.addEventListener("click", () => {
      vars = vars.filter((k) => k !== b.dataset.rm);
      cols = cols.filter((c) => c.key !== b.dataset.rm);
      delete ui.filters[b.dataset.rm];
      AM.saveVars(vars);
      fillColorSelect(); styleMap(); renderTable();
    }));
    tbl.querySelectorAll("button[data-color]").forEach((b) => b.addEventListener("click", () => {
      ui.colorBy = ui.colorBy === b.dataset.color ? "territory" : b.dataset.color;
      colorSel.value = ui.colorBy;
      AM.setState({ color: ui.colorBy === "territory" ? "" : ui.colorBy });
      styleMap(); renderTable();
    }));
    tbl.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("a")) select(tr.dataset.id, false); }));
    tbl.querySelectorAll(".filters input").forEach((inp) => inp.addEventListener("change", () => {
      const k = inp.dataset.k;
      ui.filters[k] = ui.filters[k] || {};
      ui.filters[k][inp.dataset.b] = inp.value;
      renderTable();
    }));
    const notes = [];
    if (bstate.mode === "nearest") notes.push("Parish area = census tracts closer to one of the parish's active sites than to any other parish; a tract containing sites of several parishes is shared.");
    else notes.push(`Parish area = census tracts whose centre lies within ${bstate.radius} miles of an active site (areas overlap).`);
    const missing = catalog.tables.filter((t) => t.missing_tracts && cols.some((c) => c.table.id === t.id));
    if (missing.length) notes.push(`Note: ${missing.map((t) => `${t.table} has no data for ${t.missing_tracts} tracts`).join("; ")} — re-download for all ten counties.`);
    if (cols.some((c) => c.type === "median")) notes.push("Medians are approximated by a weighted average of tract medians.");
    document.getElementById("tableNote").textContent = notes.join(" ");
  }
  function filterCell(k) {
    const f = ui.filters[k] || {};
    return `<th><input type="number" placeholder="min" data-k="${AM.esc(k)}" data-b="min" value="${AM.esc(f.min ?? "")}"> <input type="number" placeholder="max" data-k="${AM.esc(k)}" data-b="max" value="${AM.esc(f.max ?? "")}"></th>`;
  }

  function exportCSV() {
    const fields = ["parish_id", "parish", "city", "county", "category", "region", "boundary", "sites", "tracts", "area_definition",
      ...cols.map((c) => `${AM.colFull(c)} [${c.table.table} ${c.id}]`)];
    const def = bstate.mode === "nearest" ? "nearest-parish tracts" : `tracts within ${bstate.radius} mi`;
    const rows = sorted(filtered()).map((p) => [p.id, p.name, p.city, p.county, p.category, p.region, p.boundary ? "yes" : "no",
      p.activeSites.length, terr.byParish.get(p.id)?.size ?? 0, def,
      ...cols.map((c) => { const v = values.get(p.id)?.get(c.key)?.v; return v === null || v === undefined ? "" : +v.toFixed(3); })]);
    rows.push(["ARCHDIOCESE", "All tracts", "", "", "", "", "", "", allTractIds.length, "all tracts",
      ...cols.map((c) => { const v = totals.get(c.key)?.v; return v === null || v === undefined ? "" : +v.toFixed(3); })]);
    AM.download(`parishes_${bstate.mode}${bstate.mode === "radius" ? "_" + bstate.radius + "mi" : ""}.csv`, AM.toCSV(fields, rows));
  }

  await loadCols();
  drawSites();
  recompute();
})();
