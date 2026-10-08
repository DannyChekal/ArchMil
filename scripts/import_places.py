#!/usr/bin/env python3
"""Import parish locations scraped from the archmil.org "places" map.

Source: data/source/archmil_places.html (the <div class="entry" ...> list from
https://www.archmil.org/ parish finder; save the page HTML there to refresh).

The curated, hand-editable files are:
    data/parishes.csv   one row per parish (name, category, boundary flag, ...)
    data/locations.csv  one row per church/worship site, linked by parish_id

First run: both CSVs are created from the HTML using naming heuristics
("X Parish - Y Church" => one parish with several sites) plus a few seeded
corrections below.

Later runs NEVER overwrite curated rows. New places are appended (flagged
"review" in notes), and differences between the scrape and the curated data
(moved coordinates, changed addresses, places that disappeared) are written to
data/source/import_report.txt for you to review.

    python3 scripts/import_places.py [path/to/html]
"""
import csv
import html
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PARISH_FIELDS = ["parish_id", "name", "city", "category", "boundary", "region", "tags", "notes"]
LOCATION_FIELDS = ["location_id", "parish_id", "site_name", "address", "city", "lat", "lng",
                   "phone", "url", "active", "notes"]

SITE_WORDS = re.compile(r"\b(church|chapel|site|campus)\b", re.I)

# Seeded corrections for the first import, keyed by archmil place-id.
# parish: override parish grouping/name; p_*: parish fields; l_*: location fields.
SEED = {
    "2941": dict(parish="St. Joseph", parish_key="st-joseph-wauwatosa", l_active="no",
                 l_notes="School listing at the same spot as St. Joseph Catholic Church; inactive to avoid a duplicate site."),
    "33710": dict(parish="St. Joseph", parish_key="st-joseph-wauwatosa"),
    "28944": dict(p_category="Shrine", p_boundary="no",
                  p_notes="Basilica/shrine, not a territorial parish. St. Mary of the Hill parish is at the same site."),
    "2690": dict(p_category="Campus ministry", p_boundary="no"),
    "5348": dict(p_category="Eastern Catholic", p_boundary="no",
                 p_notes="Ukrainian Catholic (separate eparchy); excluded from territorial boundaries."),
    "2738": dict(p_category="Personal parish", p_boundary="no",
                 p_notes="Ethnic/personal parish; excluded from territorial boundaries."),
    "2595": dict(p_category="Personal parish", p_boundary="no",
                 p_notes="Native American personal parish; excluded from territorial boundaries."),
    "3034": dict(parish="St. Matthew", l_site="St. Matthew Church",
                 p_notes="Listed on archmil.org as 'Youth formation' (URL st-matthew-neosho). Verify name and location."),
    "3094": dict(parish="St. Rafael the Archangel",
                 p_notes="Listed as 'St. Rafael the Archangel School'; coordinates may be the school rather than the church. Verify."),
    "3017": dict(p_boundary="no",
                 p_notes="Same address and coordinates as Mother of Perpetual Help - West site; probably a merged/duplicate listing. Verify, then set boundary=yes or mark inactive."),
    "3019": dict(parish="St. Mary"),
    "14345": dict(l_city="Cedarburg"),
}


def slug(s):
    s = s.lower().replace("&", "and")
    s = re.sub(r"\bst\.?\b", "st", s)
    s = re.sub(r"\bss\.?\b", "ss", s)
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def parse_city(address):
    toks = [t.strip() for t in address.split(",") if t.strip()]
    keep = []
    for t in toks:
        if re.fullmatch(r"(United States|USA|US)", t, re.I):
            continue
        if re.search(r"County$", t):
            continue
        if re.fullmatch(r"\d{5}(-\d{4})?", t):
            continue
        if re.fullmatch(r"(Wisconsin|WI)( \d{5}(-\d{4})?)?", t, re.I):
            continue
        keep.append(t)
    return keep[-1] if len(keep) > 1 else ""


def read_entries(path):
    text = Path(path).read_text(encoding="utf-8-sig")
    out = []
    for attrs in re.findall(r'<div class="entry"([^>]*)>', text):
        d = {k: html.unescape(v).strip() for k, v in re.findall(r'data-([a-z-]+)="([^"]*)"', attrs)}
        out.append(d)
    return out


def split_title(title):
    """'Christ King Parish - St. Bernard Church' -> ('Christ King', 'St. Bernard Church')."""
    if " - " in title:
        left, right = title.split(" - ", 1)
        if SITE_WORDS.search(right):
            return re.sub(r"\s+Parish$", "", left.strip()), right.strip()
    return None, None


def seed(entries):
    parishes, locations, group_keys = {}, [], {}
    for e in entries:
        pid = e["place-id"]
        s = SEED.get(pid, {})
        group, site = split_title(e["title"])
        city = s.get("l_city") or parse_city(e["address"])
        if s.get("parish"):
            pname = s["parish"]
        elif group:
            pname = group
        else:
            pname = re.sub(r"\s+-\s+.*$", "", e["title"]) if " - " in e["title"] else e["title"]
        # ids are name + city; multi-site parishes share the id of their first site
        key = s.get("parish_key") or (group_keys.setdefault(pname, slug(f"{pname} {city}"))
                                      if group else slug(f"{pname} {city}"))
        if key not in parishes:
            parishes[key] = dict(parish_id=key, name=pname, city=city, category="Parish",
                                 boundary="yes", region="", tags="", notes="")
        p = parishes[key]
        for f in ("category", "boundary", "notes"):
            if s.get("p_" + f):
                p[f] = s["p_" + f]
        locations.append(dict(
            location_id=pid, parish_id=key,
            site_name=s.get("l_site") or site or e["title"],
            address=re.sub(r",?\s*United States$", "", e["address"]), city=city,
            lat=e["lat"], lng=e["lng"], phone=e.get("phone", ""), url=e.get("url", ""),
            active=s.get("l_active", "yes"), notes=s.get("l_notes", ""),
        ))
    return list(parishes.values()), locations


def write_csv(path, fields, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def read_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def miles(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (float(a[0]), float(a[1]), float(b[0]), float(b[1])))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DATA / "source" / "archmil_places.html"
    entries = read_entries(src)
    print(f"Read {len(entries)} places from {src}")
    ppath, lpath = DATA / "parishes.csv", DATA / "locations.csv"
    new_parishes, new_locations = seed(entries)

    if not lpath.exists():
        write_csv(ppath, PARISH_FIELDS, new_parishes)
        write_csv(lpath, LOCATION_FIELDS, new_locations)
        print(f"Created {ppath.name} ({len(new_parishes)} parishes) and {lpath.name} ({len(new_locations)} sites)")
        return

    parishes = read_csv(ppath)
    locations = read_csv(lpath)
    known = {l["location_id"]: l for l in locations}
    pids = {p["parish_id"] for p in parishes}
    report, added = [], 0
    scraped_ids = set()
    for nl in new_locations:
        lid = nl["location_id"]
        scraped_ids.add(lid)
        cur = known.get(lid)
        if cur is None:
            nl["notes"] = ("REVIEW: new on archmil.org. " + nl["notes"]).strip()
            locations.append(nl)
            added += 1
            if nl["parish_id"] not in pids:
                np = next(p for p in new_parishes if p["parish_id"] == nl["parish_id"])
                np["notes"] = ("REVIEW: new on archmil.org. " + np["notes"]).strip()
                parishes.append(np)
                pids.add(np["parish_id"])
            report.append(f"NEW      {lid}: {nl['site_name']} ({nl['address']})")
            continue
        d = miles((cur["lat"], cur["lng"]), (nl["lat"], nl["lng"]))
        if d > 0.05:
            report.append(f"MOVED    {lid}: {cur['site_name']} scraped point is {d:.2f} mi from curated point "
                          f"(scraped {nl['lat']},{nl['lng']})")
        if cur["address"].strip() != nl["address"].strip():
            report.append(f"ADDRESS  {lid}: curated '{cur['address']}' vs scraped '{nl['address']}'")
    for l in locations:
        if l["location_id"] not in scraped_ids and not l["location_id"].startswith("custom"):
            report.append(f"MISSING  {l['location_id']}: {l['site_name']} is no longer on archmil.org")

    write_csv(ppath, PARISH_FIELDS, parishes)
    write_csv(lpath, LOCATION_FIELDS, locations)
    rp = DATA / "source" / "import_report.txt"
    rp.write_text("\n".join(report) + "\n")
    print(f"Added {added} new sites. {len(report)} report lines written to {rp.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
