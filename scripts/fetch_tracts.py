#!/usr/bin/env python3
"""Download census tract boundaries and keep only the archdiocese counties.

Writes data/geo/tracts.geojson. Run once (or when moving to a new tract
vintage). The default source is the Census cartographic boundary file
(1:500k, 2022 vintage = 2020 tract definitions, which match ACS 2020-2029
releases) mirrored on GitHub. You can also pass a local GeoJSON file:

    python3 scripts/fetch_tracts.py                 # download from config URL
    python3 scripts/fetch_tracts.py path/to/tracts.geojson
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "data" / "config.json").read_text())


def round_coords(coords, nd=5):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], nd), round(coords[1], nd)]
    out = [round_coords(c, nd) for c in coords]
    # drop consecutive duplicate points created by rounding
    if out and isinstance(out[0][0], (int, float)):
        dedup = [out[0]]
        for p in out[1:]:
            if p != dedup[-1]:
                dedup.append(p)
        if dedup[0] != dedup[-1]:
            dedup.append(dedup[0])
        out = dedup
    return out


def main():
    if len(sys.argv) > 1:
        src = json.loads(Path(sys.argv[1]).read_text())
    else:
        url = CONFIG["tract_source_url"]
        print(f"Downloading {url}")
        with urllib.request.urlopen(url) as r:
            src = json.loads(r.read())

    counties = CONFIG["counties"]
    feats = []
    for f in src["features"]:
        p = f["properties"]
        geoid = p.get("GEOID") or p.get("GEOID20")
        if not geoid.startswith(CONFIG["state_fips"]) or geoid[2:5] not in counties:
            continue
        feats.append({
            "type": "Feature",
            "properties": {
                "GEOID": geoid,
                "NAME": p.get("NAMELSAD") or p.get("NAME"),
                "COUNTY": counties[geoid[2:5]],
                "ALAND": p.get("ALAND"),
                "AWATER": p.get("AWATER"),
            },
            "geometry": {
                "type": f["geometry"]["type"],
                "coordinates": round_coords(f["geometry"]["coordinates"]),
            },
        })
    feats.sort(key=lambda f: f["properties"]["GEOID"])
    out = ROOT / "data" / "geo" / "tracts.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    print(f"Wrote {len(feats)} tracts to {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
