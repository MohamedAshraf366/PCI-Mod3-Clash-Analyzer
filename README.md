# LTE PCI Mod3 Clash Analyzer

A browser-based tool for LTE RF engineers that turns a raw site table into an
interactive sector map, detects **PCI / Mod3 clashes** between neighbouring
cells, and produces a ready-to-implement **PCI re-plan** — exportable as CSV,
PDF, or KML for Google Earth.

The heavy geometry and graph work (clash detection + PCI re-planning) runs in a
Web Worker, so the UI stays responsive even with very large site tables.

![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-149eca?logo=react)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-v4-38bdf8?logo=tailwindcss)
![Leaflet](https://img.shields.io/badge/Leaflet-1.9-199900?logo=leaflet)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)

---

## Description

In LTE networks, two neighbouring cells that share the same **PCI modulo 3**
value transmit their cell-specific reference signals on the same sub-carrier
offsets, causing **CRS interference** and degraded throughput. This analyzer:

1. **Imports** a site table (CSV / TSV / XLSX / XLS) with a header row.
2. **Maps** every sector as a beam wedge coloured by its Mod3 value.
3. **Detects** Mod3 and same-PCI clashes between neighbouring sectors using
   distance, beam geometry, and shared-coverage tiles (including 3-way+
   multi-sector overlaps).
4. **Re-plans** PCIs — preferring safe same-site PCI rotations, then assigning
   the lowest-conflict PCI from the LTE 0–503 range.
5. **Exports** the solved plan as CSV, a PDF report, or a KML map for Google
   Earth.

Everything runs **entirely in the browser** — no server, no data upload.

---

## Features

### Data import
- Drag & drop or file-picker upload: **CSV, TSV, TXT, XLSX, XLS, XLSM, ODS**
- Paste a table manually into the textarea
- Flexible column auto-detection (`NAME`, `TX_ID`, `LATITUDE`, `LONGITUDE`,
  `AZIMUT`, `Cell Layer`/band, `PHY_CELL_ID`/PCI, `MRBTS`, `LNBTS`, `LNCEL`, …)
- Automatic fixes with warnings: swapped lat/lon, out-of-range coordinates,
  `0,0` rows, invalid PCI values
- Chunked parsing with **live progress** (rows/s, ETA, parsed cells)
- Downloadable blank template and one-click sample data

### Map & analysis scope
- Leaflet map with **Google Roadmap / Hybrid / Satellite / Terrain**, **Bing
  Road / Hybrid / Satellite**, and **OpenStreetMap** layers — no API keys
- Sector beam wedges coloured by Mod3, with clashed sectors enlarged + glowing
- Draw a **polygon / rectangle / circle** analysis area; only cells inside are
  analysed, while outside cells can stay visible for context
- Band / layer filter and multi-term site-name filter
- Map search that jumps to any site or cell
- Full-screen map mode (Esc to exit)
- Virtualised rendering for large datasets (>300 cells)

### Clash detection
- Neighbour search radius, sector beamwidth, and coverage length controls
- Facing-sector test, co-sited sector test, and shared-coverage tile grid
- **Multi-sector (3-way+) overlap groups** with tile counts and shared area (m²)
- Toggle: facing-only, same-band-only, ignore-same-site
- Clash links with per-link hover popups and colour pickers
- Manual link editing: select any number of sectors and link them together;
  delete individual links (deletions are excluded from the analysis)
- Live summary: cells, clash pairs, same-PCI pairs, sectors to re-plan, groups

### PCI re-plan
- Same-site PCI **rotations** preferred (exhaustive for ≤6 sectors, pairwise
  swaps above that)
- Falls back to the **lowest-conflict PCI in 0–503**, checked against every
  detected neighbour relation so fixes never create new clashes
- Worklist hill-climbing for performance on large networks
- Side-by-side **after-solve map** with changed sectors, remaining clashes, and
  explanations for conflicts that cannot be auto-fixed
- Mod3 distribution before → after

### Exports
- **PCI re-plan CSV** (`pci_replan.csv`)
- **Clashes CSV** (`mod3_clashes.csv`) with reason, group, tiles, shared area
- **Overlap groups CSV** (`mod3_overlap_groups.csv`)
- **Full resolved site table CSV** (`sites_after_mod3_resolve.csv`)
- **PDF report** (`mod3_clash_report.pdf`) — clashes, groups, and re-plan
- **KML for Google Earth** (`mod3_clash_analysis.kml`) — sector polygons with
  resolved PCIs, the clash links exactly as drawn on the map (colours, width,
  manual links), and a separate folder of links remaining after the solve

### UX & engineering
- Light/dark theme persisted in `localStorage`
- Accessible controls (ARIA live regions, keyboard navigation, focus rings)
- Off-main-thread analysis via Web Worker with synchronous fallback
- Spatial bucket index that skips impossible pairs (O(n) instead of O(n²))
- Cached beam samples and coverage tiles
- Strict TypeScript, ESLint + Prettier

---

## How to run

### Prerequisites
- **Node.js 18.18+** (Node 20 LTS recommended)
- **npm** (bundled with Node.js)

### 1. Install dependencies

```sh
npm install
```

### 2. Start the development server

```sh
npm run dev
```

Open <http://localhost:3000> in your browser.

### 3. Production build

```sh
npm run build
npm start
```

`npm start` serves the optimized build on <http://localhost:3000>.

### 4. Lint / format (optional)

```sh
npm run lint
npm run format
```

### Quick start in the app
1. Click **Load sample** (or drop your own site table).
2. Optionally pick a band, filter sites, or draw an analysis area on the map.
3. Tune the neighbour radius / beamwidth if needed.
4. Review the clash pairs and the suggested PCI re-plan.
5. Export the plan (CSV / PDF / KML) and the after-solve site table.

---

## Deploying to Vercel

This is a standard Next.js app and deploys with no extra configuration:

1. Push the repository to GitHub/GitLab/Bitbucket.
2. Import it in the [Vercel](https://vercel.com) dashboard (or run `vercel` from
   the project root).
3. Vercel auto-detects Next.js and uses `npm run build` / `.next`.
4. Optionally set the `SITE_URL` environment variable (e.g.
   `https://your-app.vercel.app`) so `/sitemap.xml` emits absolute URLs.

---

## Tech stack

| Area | Technology |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19 |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4, `tw-animate-css`, OKLCH design tokens |
| UI primitives | Radix UI / shadcn-ui patterns |
| Map | Leaflet 1.9 |
| Spreadsheets | `xlsx` |
| PDF | `jspdf` + `jspdf-autotable` |
| Async state | TanStack Query |
| Off-thread compute | Web Worker (`src/lib/clash-worker.ts`) |

---

## Project structure

```
app/                         Next.js App Router routes, layout, metadata, sitemap
  layout.tsx                 Root layout + metadata
  page.tsx                   Landing page (renders HomeClient)
  providers.tsx              TanStack Query provider
  globals.css                Tailwind v4 + design tokens
  sitemap.ts                 Dynamic sitemap

src/
  components/
    home-client.tsx          Main UI: import, controls, tables, exports, KML
    ClashMap.tsx             Leaflet map: sectors, clash links, drawing tools
    client-only.tsx          SSR guard for browser-only components
    ui/                      Radix-based UI components
  hooks/
    use-clash-worker.ts      Web Worker bridge (+ synchronous fallback)
    use-theme.ts             Light/dark theme persistence
    use-mobile.tsx           Mobile breakpoint hook
  lib/
    mod3.ts                  Core clash detection, shared-area groups, PCI re-plan
    clash-worker.ts          Worker entry point (analyze + replan)
    read-table-file.ts       CSV/TSV/XLSX reading with progress
    utils.ts                 cn() helper
```

---

## How it works (short version)

1. **Parse** the site table into `Cell` records (id, site, band, lat/lon,
   azimuth, PCI, Mod3, Nokia identifiers).
2. **Index** cells into a lat/lon bucket grid sized to the search radius, so
   only plausible neighbour pairs are compared.
3. **Stamp** each sector's beam footprint onto a ground tile grid; tiles shared
   by 2+ same-Mod3 sectors reveal pairwise and 3-way+ interference.
4. **Relate** each candidate pair (facing beams, co-sited beams, or overlapping
   footprints) and record a clash when Mod3 (or PCI) matches.
5. **Re-plan**: rotate PCIs within each physical site to reduce conflicts, then
   assign safe 0–503 PCIs where rotation cannot help — always re-scoring every
   neighbour relation so no new clash is introduced.
6. **Re-analyse** the resolved cells and present before/after maps, tables,
   and exports.

---

## License

© Mohamed Ashraf — all rights reserved.
