/* Parish / site editor. Works on the same rows as data/parishes.csv and data/locations.csv. */
(async function () {
  "use strict";
  AM.header("edit");
  const base = await AM.loadBase();
  const { tracts } = base;
  const PF = ["parish_id", "name", "city", "category", "boundary", "region", "tags", "notes"];
  const LF = ["location_id", "parish_id", "site_name", "address", "city", "lat", "lng", "phone", "url", "active", "notes"];
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const committed = { parishes: base.committed.parishes, locations: base.committed.locations };
  const src = base.edits || committed;
  let P = clone(src.parishes), Ls = clone(src.locations);
  let current = new URLSearchParams(location.search).get("id");
  let placing = null; // location row awaiting a map click
  const cP = new Map(committed.parishes.map((r) => [r.parish_id, r]));
  const cL = new Map(committed.locations.map((r) => [r.location_id, r]));

  const isChangedP = (r) => { const c = cP.get(r.parish_id); return !c || PF.some((f) => (c[f] ?? "") !== (r[f] ?? "")); };
  const isChangedL = (r) => { const c = cL.get(r.location_id); return !c || LF.some((f) => String(c[f] ?? "") !== String(r[f] ?? "")); };
  const changeCount = () => P.filter(isChangedP).length + Ls.filter(isChangedL).length +
    committed.parishes.filter((c) => !P.some((r) => r.parish_id === c.parish_id)).length +
    committed.locations.filter((c) => !Ls.some((r) => r.location_id === c.location_id)).length;

  function save() {
    const n = changeCount();
    if (n) AM.saveEdits({ parishes: P, locations: Ls });
    else AM.clearEdits();
    document.getElementById("status").textContent = n ? `${n} changed row(s) saved in this browser — not yet exported` : "No changes from the published data";
  }

  // ------------------------------------------------------------ map
  const map = L.map("emap", { zoomSnap: 0.5 }).setView([43.05, -88.1], 9);
  AM.baseLayer(map);
  const tractLyr = L.geoJSON(base.tractsGJ, { style: { color: "#999", weight: 0.4, fill: false }, interactive: false }).addTo(map);
  map.fitBounds(tractLyr.getBounds(), { animate: false });
  const terrLyr = L.layerGroup().addTo(map);
  const allLyr = L.layerGroup().addTo(map);
  const selLyr = L.layerGroup().addTo(map);
  map.on("click", (e) => {
    if (!placing) return;
    placing.lat = e.latlng.lat.toFixed(6);
    placing.lng = e.latlng.lng.toFixed(6);
    placing = null;
    map.getContainer().style.cursor = "";
    changed();
  });

  function drawMap() {
    allLyr.clearLayers(); selLyr.clearLayers(); terrLyr.clearLayers();
    const parishes = AM.assembleParishes(P, Ls, tracts);
    for (const p of parishes) {
      if (p.id === current) continue;
      for (const s of p.sites) {
        L.circleMarker([s.lat, s.lng], { radius: 4, weight: 1, color: "#fff", fillColor: s.active ? "#555" : "#bbb", fillOpacity: 1 })
          .bindTooltip(AM.esc(p.label + (p.sites.length > 1 ? " — " + s.site_name : "")), { className: "tt" })
          .on("click", () => selectParish(p.id, true)).addTo(allLyr);
      }
    }
    if (!current) return;
    const terr = AM.computeTerritories(parishes, tracts, "nearest", 0);
    const gs = terr.byParish.get(current);
    if (gs) {
      L.geoJSON({ type: "FeatureCollection", features: [...gs.keys()].map((g) => base.tractById.get(g)) },
        { style: { color: "#7a1f2b", weight: 1, fillColor: "#a8323f", fillOpacity: 0.2 }, interactive: false }).addTo(terrLyr);
    }
    for (const l of Ls.filter((l) => l.parish_id === current)) {
      const lat = parseFloat(l.lat), lng = parseFloat(l.lng);
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const m = L.marker([lat, lng], { draggable: true, title: l.site_name }).addTo(selLyr);
      m.bindTooltip(AM.esc(l.site_name), { permanent: false, className: "tt" });
      m.on("dragend", () => {
        const ll = m.getLatLng();
        l.lat = ll.lat.toFixed(6); l.lng = ll.lng.toFixed(6);
        changed();
      });
    }
  }

  // ------------------------------------------------------------ parish list
  function issuesFor(pid) {
    const out = [];
    const p = P.find((r) => r.parish_id === pid);
    const sites = Ls.filter((l) => l.parish_id === pid);
    if (!sites.length) out.push("no sites");
    if (sites.length && !sites.some((s) => AM.yes(s.active))) out.push("no active sites");
    for (const s of sites) {
      const lat = parseFloat(s.lat), lng = parseFloat(s.lng);
      if (!isFinite(lat) || !isFinite(lng)) out.push(`${s.site_name}: missing coordinates`);
      else if (!tracts.some((t) => AM.pointInFeature(lng, lat, t))) out.push(`${s.site_name}: outside the archdiocese`);
      if (/review|verify/i.test(s.notes)) out.push(`${s.site_name}: note says review`);
    }
    if (p && /review|verify/i.test(p.notes)) out.push("note says review");
    return out;
  }
  function dupCoords() {
    const seen = new Map(), out = [];
    for (const l of Ls) {
      if (!AM.yes(l.active)) continue;
      const k = (+l.lat).toFixed(4) + "," + (+l.lng).toFixed(4);
      if (seen.has(k) && seen.get(k).parish_id !== l.parish_id) out.push([seen.get(k), l]);
      else seen.set(k, l);
    }
    return out;
  }

  function renderList() {
    const q = document.getElementById("q").value.trim().toLowerCase();
    const mode = document.getElementById("onlyIssues").value;
    const rows = P.filter((p) => {
      const sites = Ls.filter((l) => l.parish_id === p.parish_id);
      if (q && !(p.name + " " + p.city + " " + p.parish_id + " " + sites.map((s) => s.site_name + " " + s.address).join(" ")).toLowerCase().includes(q)) return false;
      if (mode === "issues" && !issuesFor(p.parish_id).length) return false;
      if (mode === "changed" && !isChangedP(p) && !sites.some(isChangedL)) return false;
      return true;
    }).sort((a, b) => (a.name + a.city).localeCompare(b.name + b.city));
    const tbl = document.getElementById("plist");
    tbl.innerHTML = `<thead><tr><th class="l">Parish</th><th>Sites</th><th class="l">Checks</th></tr></thead><tbody>${rows.map((p) => {
      const sites = Ls.filter((l) => l.parish_id === p.parish_id);
      const iss = issuesFor(p.parish_id);
      const ch = isChangedP(p) || sites.some(isChangedL);
      return `<tr data-id="${AM.esc(p.parish_id)}" class="${p.parish_id === current ? "sel" : ""} ${ch ? "changed" : ""}" style="cursor:pointer">
        <td class="l">${AM.esc(p.name)} <span class="muted small">${AM.esc(p.city)} · ${AM.esc(p.category)}${AM.yes(p.boundary) ? "" : " · no territory"}</span></td>
        <td>${sites.filter((s) => AM.yes(s.active)).length}/${sites.length}</td><td class="l">${iss.length ? `<span class="pill warn" title="${AM.esc(iss.join("; "))}">${iss.length}</span>` : ""}</td></tr>`;
    }).join("")}</tbody>`;
    tbl.querySelectorAll("tbody tr").forEach((tr) => tr.onclick = () => selectParish(tr.dataset.id));
  }

  function renderIssues() {
    const items = [];
    for (const p of P) for (const i of issuesFor(p.parish_id)) items.push([p.parish_id, `${p.name} (${p.city}): ${i}`]);
    for (const [a, b] of dupCoords()) {
      const pa = P.find((p) => p.parish_id === a.parish_id), pb = P.find((p) => p.parish_id === b.parish_id);
      items.push([b.parish_id, `Same location: ${pa?.name} – ${a.site_name} and ${pb?.name} – ${b.site_name}`]);
    }
    const known = new Set(P.map((p) => p.parish_id));
    for (const l of Ls) if (!known.has(l.parish_id)) items.push([null, `Site ${l.location_id} (${l.site_name}) belongs to unknown parish “${l.parish_id}”`]);
    document.getElementById("issues").innerHTML = items.length
      ? items.map(([id, t]) => `<li>${id ? `<a href="#" data-id="${AM.esc(id)}">${AM.esc(t)}</a>` : AM.esc(t)}</li>`).join("")
      : "<li>No problems found.</li>";
    document.querySelectorAll("#issues a").forEach((a) => a.onclick = (e) => { e.preventDefault(); selectParish(a.dataset.id); });
  }

  // ------------------------------------------------------------ editor form
  function selectParish(id, fromMap) {
    current = id;
    placing = null;
    history.replaceState(null, "", "?id=" + encodeURIComponent(id));
    renderList(); renderEditor(); drawMap();
    if (!fromMap) {
      const pts = Ls.filter((l) => l.parish_id === id).map((l) => [+l.lat, +l.lng]).filter((p) => isFinite(p[0]) && isFinite(p[1]));
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.5), { maxZoom: 14 });
    }
    const tr = document.querySelector(`#plist tr[data-id="${CSS.escape(id)}"]`);
    if (tr) tr.scrollIntoView({ block: "nearest" });
  }

  const input = (obj, f, attrs = "") => `<input type="text" data-f="${f}" value="${AM.esc(obj[f] ?? "")}" ${attrs}>`;
  function renderEditor() {
    const box = document.getElementById("editor");
    const p = P.find((r) => r.parish_id === current);
    if (!p) { box.innerHTML = '<p class="muted">Select a parish to edit it.</p>'; return; }
    const sites = Ls.filter((l) => l.parish_id === p.parish_id);
    const opts = P.slice().sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<option value="${AM.esc(x.parish_id)}">${AM.esc(x.name)} (${AM.esc(x.city)})</option>`).join("");
    box.innerHTML = `
      <div class="table-tools"><h2 style="margin:0">${AM.esc(p.name)}</h2><span class="spacer"></span>
        <a href="parish.html?id=${encodeURIComponent(p.parish_id)}">View profile</a>
        ${cP.has(p.parish_id) && isChangedP(p) ? '<button class="btn-secondary" id="revertP" type="button">Revert parish</button>' : ""}
        <button class="btn-secondary btn-danger" id="delP" type="button" ${sites.length ? 'disabled title="Move or delete its sites first"' : ""}>Delete parish</button></div>
      <div class="pform">
        <div class="form-row"><label>Parish ID</label><input type="text" value="${AM.esc(p.parish_id)}" disabled></div>
        <div class="form-row"><label>Name</label>${input(p, "name")}</div>
        <div class="form-row"><label>City</label>${input(p, "city")}</div>
        <div class="form-row"><label>Category</label>${input(p, "category", 'list="categories"')}</div>
        <div class="form-row"><label>Gets territory</label><select data-f="boundary"><option value="yes">yes — takes part in nearest-parish boundaries</option><option value="no">no — personal parish, shrine, ministry…</option></select></div>
        <div class="form-row"><label>Region / deanery</label>${input(p, "region", 'list="regions"')}</div>
        <div class="form-row"><label>Tags</label>${input(p, "tags", 'placeholder="separate with ;"')}</div>
        <div class="form-row"><label>Notes</label><textarea data-f="notes" rows="2">${AM.esc(p.notes)}</textarea></div>
      </div>
      <h3 style="margin-top:.8rem">Sites</h3>
      <div class="tscroll"><table class="data edit"><thead><tr><th class="l">Site name</th><th class="l">Address</th><th class="l">Lat</th><th class="l">Lng</th><th>Active</th><th class="l">Parish</th><th></th></tr></thead>
      <tbody>${sites.map((l) => `<tr data-lid="${AM.esc(l.location_id)}" class="${isChangedL(l) ? "changed" : ""}">
        <td class="l">${input(l, "site_name")}</td><td class="l">${input(l, "address")}</td>
        <td class="l"><input type="text" class="num" data-f="lat" value="${AM.esc(l.lat)}"></td><td class="l"><input type="text" class="num" data-f="lng" value="${AM.esc(l.lng)}"></td>
        <td class="chk"><input type="checkbox" data-f="active" ${AM.yes(l.active) ? "checked" : ""}></td>
        <td class="l"><select data-f="parish_id">${opts}</select></td>
        <td class="l" style="white-space:nowrap"><button class="btn" data-act="place" type="button" title="Click the map to set this site's location">Place on map</button>
          <button class="btn" data-act="geo" type="button" title="Look up the address with OpenStreetMap Nominatim">Find address</button>
          ${cL.has(l.location_id) && isChangedL(l) ? '<button class="btn" data-act="revert" type="button">Revert</button>' : ""}
          <button class="btn btn-danger" data-act="del" type="button" title="Delete site">×</button></td></tr>
        <tr data-lid="${AM.esc(l.location_id)}"><td colspan="7" class="l"><input type="text" data-f="notes" placeholder="Site notes" value="${AM.esc(l.notes)}" style="width:100%"> <span class="muted small">ID ${AM.esc(l.location_id)} · ${AM.esc(l.city)} · ${AM.esc(l.phone)}</span></td></tr>`).join("")}</tbody></table></div>
      <div class="table-tools" style="margin-top:.6rem"><button class="btn-secondary" id="addSite" type="button">+ Add site</button>
        <span class="muted small">To merge two parishes, change the “Parish” of the sites of one to the other, then delete the empty parish.</span></div>`;
    box.querySelector("select[data-f=boundary]").value = AM.yes(p.boundary) ? "yes" : "no";
    box.querySelectorAll(".pform [data-f]").forEach((e) => e.addEventListener("change", () => { p[e.dataset.f] = e.value; changed(true); }));
    box.querySelectorAll("tr[data-lid]").forEach((tr) => {
      const l = Ls.find((x) => x.location_id === tr.dataset.lid);
      tr.querySelectorAll("[data-f]").forEach((e) => {
        if (e.dataset.f === "parish_id") e.value = l.parish_id;
        e.addEventListener("change", () => {
          l[e.dataset.f] = e.type === "checkbox" ? (e.checked ? "yes" : "no") : e.value.trim();
          changed(e.dataset.f === "parish_id");
        });
      });
      tr.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", async () => {
        const act = b.dataset.act;
        if (act === "place") { placing = l; map.getContainer().style.cursor = "crosshair"; b.textContent = "Click the map…"; }
        else if (act === "del") { if (confirm(`Delete site “${l.site_name}”?`)) { Ls = Ls.filter((x) => x !== l); changed(true); } }
        else if (act === "revert") { Object.assign(l, clone(cL.get(l.location_id))); changed(true); }
        else if (act === "geo") {
          b.disabled = true; b.textContent = "Searching…";
          try {
            const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=" + encodeURIComponent(l.address));
            const j = await r.json();
            if (j[0]) { l.lat = (+j[0].lat).toFixed(6); l.lng = (+j[0].lon).toFixed(6); changed(true); }
            else { alert("Address not found. Try simplifying it, or use “Place on map”."); renderEditor(); }
          } catch (e) { alert("Lookup failed: " + e.message); renderEditor(); }
        }
      }));
    });
    const rp = box.querySelector("#revertP");
    if (rp) rp.onclick = () => { Object.assign(p, clone(cP.get(p.parish_id))); changed(true); };
    box.querySelector("#delP").onclick = () => {
      if (!confirm(`Delete parish “${p.name}”?`)) return;
      P = P.filter((x) => x !== p); current = null; changed(true);
    };
    box.querySelector("#addSite").onclick = () => {
      const c = map.getCenter();
      Ls.push({ location_id: "custom-" + Date.now().toString(36), parish_id: p.parish_id, site_name: p.name + " Church", address: "", city: p.city,
        lat: c.lat.toFixed(6), lng: c.lng.toFixed(6), phone: "", url: "", active: "yes", notes: "Added in editor" });
      changed(true);
    };
  }

  function changed(rerenderForm) {
    save();
    renderList();
    renderIssues();
    drawMap();
    if (rerenderForm || !document.activeElement || !document.getElementById("editor").contains(document.activeElement)) renderEditor();
    else document.querySelectorAll("#editor tr[data-lid]").forEach((tr) => {
      const l = Ls.find((x) => x.location_id === tr.dataset.lid);
      if (!l) return;
      tr.classList.toggle("changed", isChangedL(l) && !!tr.querySelector("[data-f=site_name]"));
      tr.querySelectorAll("[data-f=lat],[data-f=lng]").forEach((e) => { if (e !== document.activeElement) e.value = l[e.dataset.f]; });
    });
  }

  // ------------------------------------------------------------ toolbar
  document.getElementById("q").addEventListener("input", renderList);
  document.getElementById("onlyIssues").addEventListener("change", renderList);
  document.getElementById("dlP").onclick = () => AM.download("parishes.csv", AM.toCSV(PF, P));
  document.getElementById("dlL").onclick = () => AM.download("locations.csv", AM.toCSV(LF, Ls));
  document.getElementById("discard").onclick = () => {
    if (!confirm("Discard all edits stored in this browser and go back to the published data?")) return;
    AM.clearEdits(); location.reload();
  };
  document.getElementById("upload").onchange = async (e) => {
    for (const f of e.target.files) {
      const rows = AM.parseCSV(await f.text());
      if (!rows.length) continue;
      if ("location_id" in rows[0]) Ls = rows.map((r) => Object.fromEntries(LF.map((k) => [k, r[k] ?? ""])));
      else if ("parish_id" in rows[0] && "name" in rows[0]) P = rows.map((r) => Object.fromEntries(PF.map((k) => [k, r[k] ?? ""])));
      else alert(`${f.name}: not a parishes.csv or locations.csv file`);
    }
    e.target.value = "";
    changed(true);
  };
  document.getElementById("newParish").onclick = () => {
    const name = prompt("Name of the new parish (e.g. St. Example):");
    if (!name) return;
    const city = prompt("City:") || "";
    let id = (name + " " + city).toLowerCase().replace(/\bst\.?\b/g, "st").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    while (P.some((p) => p.parish_id === id)) id += "-2";
    P.push({ parish_id: id, name, city, category: "Parish", boundary: "yes", region: "", tags: "", notes: "Added in editor" });
    current = id;
    changed(true);
    selectParish(id);
  };
  const fillList = (id, vals) => (document.getElementById(id).innerHTML = [...new Set(vals.filter(Boolean))].sort().map((v) => `<option value="${AM.esc(v)}">`).join(""));
  fillList("categories", ["Parish", "Personal parish", "Shrine", "Campus ministry", "Eastern Catholic", "Mission", ...P.map((p) => p.category)]);
  fillList("regions", P.map((p) => p.region));

  save();
  renderList();
  renderIssues();
  if (current && P.some((p) => p.parish_id === current)) selectParish(current);
  else { current = null; drawMap(); }
})();
