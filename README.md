# Archdiocese of Milwaukee — Parish Demographics

A static website for exploring American Community Survey (ACS) demographics of the
parishes of the Archdiocese of Milwaukee.

* **Overview** (`docs/index.html`) — map of parish areas and a sortable, filterable
  table of parishes; add any ACS variable as a column, filter by min/max, colour the
  map by it, download as CSV.
* **Parish profile** (`docs/parish.html?id=…`) — map of the parish area, key figures
  compared with the archdiocese, and every loaded ACS table combined over the parish.
* **Edit parishes** (`docs/edit.html`) — correct site locations (drag on map / address
  lookup), group sites into parishes, set categories, regions and tags. Edits preview
  live across the site and are exported as CSV to commit.
* **Methods & data** (`docs/about.html`).

Both the overview and profiles can define a parish's area as **nearest-parish tracts**
(each tract goes to the parish with the closest active site; the only overlap is a
tract containing sites of several parishes) or **tracts within X miles** (adjustable).

## Layout

```
data/
  config.json             counties, default variables, default radius
  parishes.csv            curated parishes (one row per parish)         <- edit
  locations.csv           curated church/worship sites (linked by parish_id) <- edit
  acs/*.zip               ACS downloads from data.census.gov, unmodified   <- add more
  derived_variables.csv   custom ratio indicators (may span tables)        <- edit
  acs_overrides.csv       optional per-column aggregation fixes / hiding
  geo/tracts.geojson      tract boundaries for the 10 counties
  source/archmil_places.html  parish-finder HTML scraped from archmil.org
scripts/
  build.py                data/ -> docs/data/  (standard library only)
  import_places.py        seed / reconcile parishes from the archmil HTML
  fetch_tracts.py         download tract boundaries
docs/                     the website (static; GitHub Pages serves this folder)
```

## Common tasks

```bash
python3 scripts/build.py                  # rebuild docs/data after any change in data/
python3 -m http.server -d docs 8000       # preview at http://localhost:8000
python3 scripts/import_places.py          # after saving a fresh archmil HTML scrape
```

**Adding ACS tables:** download any Subject (S), Data Profile (DP) or Detailed (B/C)
table from data.census.gov at *Census Tract* level for all ten counties (Dodge, Fond du
Lac, Kenosha, Milwaukee, Ozaukee, Racine, Sheboygan, Walworth, Washington, Waukesha),
drop the ZIP in `data/acs/`, and rebuild. The build decides for every column whether it
is a count (summed), a percentage (recomputed exactly from numerator/denominator columns
when they can be verified, otherwise universe-weighted), or a median/mean (weighted
average, approximate). Each decision is listed in `docs/data/acs/<TABLE>.report.txt`;
override any of them in `data/acs_overrides.csv` (columns: `column` as `COL` or
`TABLE:COL`, `type`, `numerator`, `denominator`, `weight`, `hide`).

> The included S1603 download covers only 7 of the 10 counties (Dodge, Fond du Lac and
> Kenosha are missing). Re-download it with all ten counties and replace the ZIP; the
> site flags tables with missing tracts.

**Correcting parishes:** use the *Edit parishes* page, then download `parishes.csv` and
`locations.csv` into `data/` (or edit them in Excel). Key fields:

| file | field | meaning |
|---|---|---|
| parishes.csv | `boundary` | `yes` = takes part in nearest-parish territories; `no` for shrines, campus ministries, personal/ethnic or Eastern Catholic parishes |
| parishes.csv | `category`, `region`, `tags` | free text for grouping/filtering (`tags` separated by `;`) |
| locations.csv | `parish_id` | which parish a site belongs to (several sites → one multi-site parish) |
| locations.csv | `active` | `no` keeps the site listed but ignores it for areas |

The first import applied some judgement calls worth reviewing — search the CSVs for
"Verify": St. Mary Magdalen (same point as Mother of Perpetual Help West site, set to
no territory), "Youth formation" (renamed St. Matthew, Neosho), St. Rafael (school
address), the St. Joseph Wauwatosa school duplicate (inactive), and Holy Hill, the
Newman Center, Sacred Heart Croatian, Congregation of the Great Spirit and St. Michael's
Ukrainian (no territory).

## Publishing

The workflow in `.github/workflows/pages.yml` rebuilds the data and deploys `docs/` to
GitHub Pages on every push to `main`. Enable it under *Settings → Pages → Source:
GitHub Actions*. Built data is also committed, so serving `docs/` from a branch works too.
