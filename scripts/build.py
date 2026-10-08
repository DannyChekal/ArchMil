#!/usr/bin/env python3
"""Build the website data in docs/data/ from the curated inputs in data/.

    python3 scripts/build.py

Inputs
  data/config.json          counties, default variables, ...
  data/parishes.csv         curated parish list      (see scripts/import_places.py)
  data/locations.csv        curated church/site list
  data/geo/tracts.geojson   tract boundaries         (see scripts/fetch_tracts.py)
  data/acs/*.zip            ACS table downloads from data.census.gov, unmodified
                            (any number; subject "S", detailed "B"/"C", profile "DP")
  data/acs_overrides.csv    optional manual fixes to how a column is aggregated

Outputs (all static, served by the site)
  docs/data/tracts.geojson  tracts + representative point + county + land area
  docs/data/parishes.json   parishes with their sites
  docs/data/acs/catalog.json, docs/data/acs/<TABLE>.json

How ACS columns are combined across tracts
  count   -> summed; margin of error = sqrt(sum of squared MOEs)
  percent -> exact ratio sum(numerator)/sum(denominator) when a numerator and
             denominator count column can be found in the table and verified
             against the published tract percentages; otherwise a weighted
             average using the nearest universe count as weight
  median / mean -> weighted average of tract values (an approximation; true
             medians cannot be rebuilt from tract medians)
Every decision is listed in docs/data/acs/<TABLE>.report.txt so it can be
checked and, if needed, corrected in data/acs_overrides.csv.
"""
import csv
import io
import json
import re
import statistics
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "docs" / "data"
CONFIG = json.loads((DATA / "config.json").read_text())

csv.field_size_limit(sys.maxsize)


# --------------------------------------------------------------------------- geometry

def ring_area_centroid(ring, kx):
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
        x0, x1 = x0 * kx, x1 * kx
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    if a == 0:
        return 0.0, ring[0][0], ring[0][1]
    return a / 2, cx / (3 * a) / kx, cy / (3 * a)


def polygons(geom):
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def point_in_ring(x, y, ring):
    inside = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            inside = not inside
    return inside


def point_in_geom(x, y, geom):
    for poly in polygons(geom):
        if point_in_ring(x, y, poly[0]) and not any(point_in_ring(x, y, h) for h in poly[1:]):
            return True
    return False


def representative_point(geom):
    """Area centroid of the largest polygon, moved inside the shape if needed."""
    import math
    best = None
    for poly in polygons(geom):
        lat = poly[0][0][1]
        kx = math.cos(math.radians(lat))
        a, cx, cy = ring_area_centroid(poly[0], kx)
        holes = [ring_area_centroid(h, kx) for h in poly[1:]]
        area = abs(a) - sum(abs(h[0]) for h in holes)
        if best is None or area > best[0]:
            best = (area, cx, cy, poly)
    _, cx, cy, poly = best
    if point_in_geom(cx, cy, {"type": "Polygon", "coordinates": poly}):
        return cx, cy
    # scan a horizontal line through the centroid; take the middle of the widest inside span
    for dy in [0] + [s * k for k in (0.1, 0.2, 0.3, 0.4) for s in (1, -1)]:
        ys = [p[1] for p in poly[0]]
        y = cy + dy * (max(ys) - min(ys))
        xs = []
        for ring in poly:
            for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
                if (y0 > y) != (y1 > y):
                    xs.append((x1 - x0) * (y - y0) / (y1 - y0) + x0)
        xs.sort()
        spans = [(xs[i + 1] - xs[i], (xs[i] + xs[i + 1]) / 2) for i in range(0, len(xs) - 1, 2)]
        if spans:
            return max(spans)[1], y
    return cx, cy


def build_tracts():
    src = json.loads((DATA / "geo" / "tracts.geojson").read_text())
    feats = []
    for f in src["features"]:
        x, y = representative_point(f["geometry"])
        p = f["properties"]
        p["lng"], p["lat"] = round(x, 5), round(y, 5)
        p["ALAND_SQMI"] = round((p.get("ALAND") or 0) / 2589988.11, 4)
        feats.append(f)
    add_neighbors(feats)
    (OUT / "tracts.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                                   separators=(",", ":")))
    print(f"tracts: {len(feats)}")
    return feats


# --------------------------------------------------------------------------- parishes

def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def build_parishes(tracts):
    parishes = read_csv(DATA / "parishes.csv")
    locations = read_csv(DATA / "locations.csv")
    pids = {p["parish_id"] for p in parishes}
    problems = []
    for l in locations:
        if l["parish_id"] not in pids:
            problems.append(f"location {l['location_id']} refers to unknown parish_id '{l['parish_id']}'")
        try:
            lat, lng = float(l["lat"]), float(l["lng"])
        except ValueError:
            problems.append(f"location {l['location_id']} has no valid lat/lng")
            continue
        if not any(point_in_geom(lng, lat, t["geometry"]) for t in tracts):
            problems.append(f"location {l['location_id']} ({l['site_name']}) is outside the archdiocese tracts")
    used = {l["parish_id"] for l in locations}
    problems += [f"parish {p} has no sites" for p in sorted(pids - used)]
    for msg in problems:
        print("  WARNING:", msg)
    (OUT / "parishes.json").write_text(json.dumps({"parishes": parishes, "locations": locations}, indent=0))
    print(f"parishes: {len(parishes)} with {len(locations)} sites")


def add_neighbors(feats):
    """Tracts that share a boundary vertex are neighbours (used to colour territories)."""
    owners = {}
    for i, f in enumerate(feats):
        for poly in polygons(f["geometry"]):
            for ring in poly:
                for pt in ring:
                    owners.setdefault((pt[0], pt[1]), set()).add(i)
    nb = [set() for _ in feats]
    for s in owners.values():
        if 1 < len(s) < 6:
            for i in s:
                nb[i] |= s - {i}
    for i, f in enumerate(feats):
        f["properties"]["nb"] = sorted(feats[j]["properties"]["GEOID"] for j in nb[i])


# --------------------------------------------------------------------------- ACS

MISSING = {"", "-", "N", "(X)", "*", "**", "***", "*****", "null", "nan"}


def parse_num(s):
    s = (s or "").strip()
    if s in MISSING:
        return None
    s = s.replace(",", "")
    if s.endswith(("+", "-")) and len(s) > 1:  # top/bottom-coded e.g. 250,000+ / 2,500-
        s = s[:-1]
    try:
        return float(s)
    except ValueError:
        return None


def read_notes(text):
    out = {}
    for key in ("Table Title", "Table ID", "Year", "Dataset", "Source", "Universe"):
        m = re.search(re.escape(key) + r"\s*\n\s*\n?\s*(.+)", text)
        if m:
            out[key] = m.group(1).strip()
    return out


def load_zip(path):
    """Return dict(table_id, notes, labels{col:label}, rows{geoid:{col:str}})."""
    files = {}
    if path.is_dir():
        for f in path.iterdir():
            files[f.name] = f.read_bytes()
    else:
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                files[Path(n).name] = z.read(n)
    data_name = next((n for n in files if n.endswith("-Data.csv")), None)
    meta_name = next((n for n in files if n.endswith("-Column-Metadata.csv")), None)
    if not data_name:
        raise ValueError(f"{path.name}: no *-Data.csv inside")
    table_id = data_name[: -len("-Data.csv")]
    notes_name = next((n for n in files if n.endswith("-Table-Notes.txt")), None)
    notes = read_notes(files[notes_name].decode("utf-8-sig", "replace")) if notes_name else {}
    rows = list(csv.reader(io.StringIO(files[data_name].decode("utf-8-sig"))))
    header = rows[0]
    labels = {}
    if meta_name:
        for r in csv.reader(io.StringIO(files[meta_name].decode("utf-8-sig"))):
            if len(r) >= 2:
                labels[r[0]] = r[1]
    if not labels:  # the second row of the data file repeats the labels
        labels = dict(zip(header, rows[1]))
    data = {}
    for r in rows[1:]:
        if not r or not r[0].startswith("1400000US"):
            continue
        data[r[0][9:]] = dict(zip(header, r))
    return dict(table_id=table_id, notes=notes, labels=labels, rows=data, header=header)


def clean_seg(s):
    return s.strip().rstrip(":").strip()


class Col:
    def __init__(self, cid, label):
        self.id = cid
        segs = [clean_seg(s) for s in label.split("!!") if clean_seg(s)]
        if segs and segs[0] in ("Estimate", "Margin of Error"):
            segs = segs[1:]
        m = re.search(r"_C(\d+)_", cid)
        if m:  # subject table: first segment names the column group (Total, Male, Percent ...)
            self.group = "C" + m.group(1)
            self.header = segs[0] if segs else ""
            self.row = segs[1:]
        elif re.search(r"\d+PE$", cid):  # data profile percent
            self.group = "PE"
            self.header = "Percent"
            self.row = segs[1:] if segs and segs[0] == "Percent" else segs
        else:
            self.group = "E"
            self.header = "Estimate"
            self.row = segs
        self.path = segs
        self.type = None
        self.agg = None
        self.values = {}
        self.raw_has_decimal = False


def classify(col):
    text = " ".join(col.path).lower()
    last = (col.row[-1] if col.row else col.header).lower()
    if "median" in text:
        return "median"
    if re.search(r"\bmean\b|\baverage\b|per capita|\bper\b|\bratio\b|\bindex\b|\(minutes\)|\(years\)", last) \
            or re.search(r"\bmean\b|\baverage\b", col.header.lower()):
        return "mean"
    if "percent" in col.header.lower() or "percent" in text or re.search(r"\brate\b", last):
        return "percent"
    vals = [v for v in col.values.values() if v is not None]
    if col.raw_has_decimal:
        return "percent" if vals and max(vals) <= 100 else "mean"
    return "count"


def is_prefix(a, b):
    return len(a) < len(b) and b[: len(a)] == a


def is_subseq(a, b):
    it = iter(b)
    return all(x in it for x in a)


def ratio_error(num, den, pct, geoids):
    errs = []
    for g in geoids:
        p, n, d = pct.get(g), num.get(g), den.get(g)
        if p is None or n is None or not d:
            continue
        errs.append(abs(100.0 * n / d - p))
    if len(errs) < 5:
        return None
    errs.sort()
    return statistics.median(errs), errs[int(len(errs) * 0.95)]


def nearest_ancestor(col, counts, same_group=True):
    best = None
    for c in counts:
        if c is col or (same_group and c.group != col.group):
            continue
        if is_prefix(c.row, col.row) and (best is None or len(c.row) > len(best.row)):
            best = c
    return best


def assign_aggregation(cols, geoids, overrides, tid):
    counts = [c for c in cols if c.type == "count"]
    first_by_group = {}
    for c in counts:
        first_by_group.setdefault(c.group, c)
    by_id = {c.id: c for c in cols}
    for c in cols:
        ov = overrides.get(f"{tid}:{c.id}") or overrides.get(c.id, {})
        if ov.get("type"):
            c.type = ov["type"]
        if c.type == "count":
            c.agg = {"kind": "sum"}
            parent = nearest_ancestor(c, counts)
            if parent:
                c.agg["parent"] = parent.id
            continue
        if ov.get("numerator") and ov.get("denominator"):
            c.agg = {"kind": "ratio", "num": ov["numerator"], "den": ov["denominator"], "how": "override"}
            continue
        if ov.get("weight"):
            c.agg = {"kind": "wavg", "w": ov["weight"], "how": "override"}
            continue
        if c.type == "percent":
            cands = [k for k in counts if k is not c and (
                (k.row and c.row and k.row[-1] == c.row[-1] and is_subseq(k.row, c.row))
                or is_prefix(k.row, c.row) or k.row == c.row)]
            cands = cands[:40]
            best = None
            for n in cands:
                for d in cands:
                    if n is d:
                        continue
                    r = ratio_error(n.values, d.values, c.values, geoids)
                    if r and r[0] <= 0.11 and r[1] <= 0.8 and (best is None or r < best[0]):
                        best = (r, n, d)
            if best:
                c.agg = {"kind": "ratio", "num": best[1].id, "den": best[2].id, "how": "verified"}
                continue
        # weighted average fallback
        w = None
        how = ""
        if c.type in ("median", "mean"):
            w = next((k for k in counts if k.row == c.row and k.group != c.group), None)
            how = "same row, other column"
        if w is None:
            w, how = nearest_ancestor(c, counts), "universe in same column"
        if w is None:
            w, how = nearest_ancestor(c, counts, same_group=False), "universe in other column"
        if w is None:
            w, how = first_by_group.get(c.group), "first count in column"
        if w is None and counts:
            w, how = counts[0], "first count in table"
        c.agg = {"kind": "wavg", "w": w.id, "how": how} if w else {"kind": "mean", "how": "unweighted"}
    for c in cols:
        for k in ("num", "den", "w", "parent"):
            if c.agg and k in c.agg and c.agg[k] not in by_id:
                raise ValueError(f"{c.id}: aggregation refers to unknown column {c.agg[k]}")


def read_overrides():
    p = DATA / "acs_overrides.csv"
    if not p.exists():
        return {}
    return {r["column"].strip(): {k: (v or "").strip() for k, v in r.items()} for r in read_csv(p)
            if r.get("column")}


def build_acs(tracts):
    tract_ids = {t["properties"]["GEOID"] for t in tracts}
    acs_dir = OUT / "acs"
    acs_dir.mkdir(parents=True, exist_ok=True)
    for old in acs_dir.glob("*"):
        old.unlink()
    overrides = read_overrides()

    tables = {}
    for path in sorted((DATA / "acs").iterdir()):
        if not (path.suffix.lower() == ".zip" or path.is_dir()):
            continue
        t = load_zip(path)
        tid = t["table_id"]
        if tid in tables:  # several downloads of the same table (e.g. different counties): merge rows
            tables[tid]["rows"].update(t["rows"])
            print(f"  merged {path.name} into {tid}")
        else:
            tables[tid] = t

    catalog = []
    for tid, t in sorted(tables.items()):
        geoids = [g for g in sorted(t["rows"]) if g in tract_ids]
        missing = sorted(tract_ids - set(geoids))
        est_ids = [h for h in t["header"] if re.search(r"(?<!M)E$", h) and h not in ("GEO_ID", "NAME")
                   and not h.endswith("EA")]
        cols = []
        for cid in est_ids:
            c = Col(cid, t["labels"].get(cid, cid))
            for g in geoids:
                raw = t["rows"][g].get(cid, "")
                if "." in raw:
                    c.raw_has_decimal = True
                c.values[g] = parse_num(raw)
            if all(v is None for v in c.values.values()):
                continue
            ov = overrides.get(f"{tid}:{cid}") or overrides.get(cid, {})
            if ov.get("hide", "").lower() in ("yes", "true", "1"):
                continue
            cols.append(c)
        for c in cols:
            c.type = classify(c)
        assign_aggregation(cols, geoids, overrides, tid)

        # margins of error are kept for counts only (that is where they can be combined)
        out_cols, rows = [], {g: [] for g in geoids}
        for c in cols:
            spec = {"id": c.id, "header": c.header, "row": c.row, "group": c.group, "type": c.type, "agg": c.agg}
            moe_id = c.id[:-1] + "M"
            has_moe = c.type == "count" and moe_id in t["header"]
            spec["moe"] = has_moe
            out_cols.append(spec)
            for g in geoids:
                v = c.values[g]
                rows[g].append(None if v is None else (int(v) if v == int(v) else round(v, 3)))
                if has_moe:
                    m = parse_num(t["rows"][g].get(moe_id, ""))
                    rows[g].append(None if m is None else int(m) if m == int(m) else round(m, 3))
        notes = t["notes"]
        short = tid.split(".")[-1]
        meta = {
            "id": tid,
            "table": short,
            "title": notes.get("Table Title", short),
            "year": notes.get("Year", ""),
            "dataset": notes.get("Dataset", ""),
            "source": notes.get("Source", ""),
            "tracts": len(geoids),
            "missing_tracts": len(missing),
        }
        (acs_dir / f"{tid}.json").write_text(json.dumps({**meta, "columns": out_cols, "data": rows},
                                                        separators=(",", ":")))
        catalog.append({**meta, "columns": len(out_cols)})

        # human-readable report of how each column is aggregated
        lines = [f"{tid}  {meta['title']}", f"tracts with data: {len(geoids)}; tracts missing: {len(missing)}"]
        if missing:
            lines.append("missing: " + ", ".join(missing))
        kinds = {}
        for c in cols:
            a = c.agg
            k = a["kind"] + ("/" + a.get("how", "") if a.get("how") else "")
            kinds[k] = kinds.get(k, 0) + 1
            detail = {"sum": "", "ratio": f"{a.get('num')} / {a.get('den')}", "wavg": f"weight {a.get('w')}",
                      "mean": ""}[a["kind"]]
            lines.append(f"{c.id:18} {c.type:8} {a['kind']:6} {a.get('how', ''):26} {detail:36} "
                         f"{' > '.join([c.header] + c.row)}")
        (acs_dir / f"{tid}.report.txt").write_text("\n".join(lines) + "\n")
        print(f"acs {tid}: {len(out_cols)} columns, {len(geoids)} tracts"
              + (f" ({len(missing)} tracts missing - download the table for all archdiocese counties)"
                 if missing else "")
              + "; " + ", ".join(f"{k}={v}" for k, v in sorted(kinds.items())))

    custom = build_derived(tables, tracts, acs_dir)
    if custom:
        catalog.insert(0, custom)
    known = {c["id"] for c in catalog}
    defaults = [v for v in CONFIG.get("default_variables", []) if v.split(":")[0] in known]
    (acs_dir / "catalog.json").write_text(json.dumps({"tables": catalog, "defaults": defaults}, indent=1))


def build_derived(tables, tracts, acs_dir):
    """Custom ratios from data/derived_variables.csv -> table "CUSTOM".

    numerator / denominator are ';'-separated lists of TABLE:COLUMN (summed), or
    GEO:ALAND_SQMI for land area. The value is scale * sum(num) / sum(den), which
    is also how it is combined across tracts, so it is exact for any area.
    """
    path = DATA / "derived_variables.csv"
    if not path.exists():
        return None
    geo = {t["properties"]["GEOID"]: t["properties"] for t in tracts}

    def value(ref, g):
        tid, cid = ref.strip().split(":")
        if tid == "GEO":
            return geo[g].get(cid)
        row = tables[tid]["rows"].get(g)
        return parse_num(row.get(cid, "")) if row else None

    cols, rows = [], {g: [] for g in sorted(geo)}
    for d in read_csv(path):
        if not d.get("id"):
            continue
        refs = {k: [r for r in d[k].split(";") if r.strip()] for k in ("numerator", "denominator")}
        bad = [r for r in refs["numerator"] + refs["denominator"]
               if r.split(":")[0] != "GEO" and r.split(":")[0] not in tables]
        if bad:
            print(f"  WARNING: derived variable {d['id']} skipped; table not loaded: {', '.join(bad)}")
            continue
        scale = float(d.get("scale") or 1)
        vid = d["id"]
        cols += [
            {"id": vid + "__num", "header": "", "row": [d["label"], "numerator"], "group": "X",
             "type": "count", "agg": {"kind": "sum"}, "moe": False, "hidden": True},
            {"id": vid + "__den", "header": "", "row": [d["label"], "denominator"], "group": "X",
             "type": "count", "agg": {"kind": "sum"}, "moe": False, "hidden": True},
            {"id": vid, "header": "", "row": [d["label"]], "group": "X", "type": d.get("type") or "percent",
             "agg": {"kind": "ratio", "num": vid + "__num", "den": vid + "__den", "scale": scale,
                     "how": "derived"}, "moe": False},
        ]
        for g in rows:
            parts = [[value(r, g) for r in refs[k]] for k in ("numerator", "denominator")]
            if any(v is None for v in parts[0] + parts[1]):
                rows[g] += [None, None, None]
                continue
            n, dn = sum(parts[0]), sum(parts[1])
            rows[g] += [round(n, 4), round(dn, 4), round(scale * n / dn, 3) if dn else None]
    if not cols:
        return None
    rows = {g: r for g, r in rows.items() if any(v is not None for v in r)}
    meta = {"id": "CUSTOM", "table": "Custom", "title": "Key indicators (data/derived_variables.csv)",
            "year": "", "dataset": "Derived from the ACS tables above", "source": "",
            "tracts": len(rows), "missing_tracts": len(geo) - len(rows)}
    (acs_dir / "CUSTOM.json").write_text(json.dumps({**meta, "columns": cols, "data": rows},
                                                    separators=(",", ":")))
    print(f"custom indicators: {sum(1 for c in cols if not c.get('hidden'))}")
    return {**meta, "columns": len(cols) // 3}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tracts = build_tracts()
    build_parishes(tracts)
    build_acs(tracts)
    site = {k: CONFIG[k] for k in ("title", "default_radius_miles", "counties")}
    (OUT / "site.json").write_text(json.dumps(site, indent=1))
    print("done -> docs/data/")


if __name__ == "__main__":
    main()
