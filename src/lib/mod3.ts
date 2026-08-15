export type Cell = {
  id: string;
  site: string;
  cellName: string;
  band: string;
  lat: number;
  lon: number;
  azimuth: number;
  pci: number;
  mod3: number;
  /** Nokia identifiers — taken from the file when present, otherwise derived. */
  mrbts: string;
  lnbts: string;
  lncel: string;
};

export type Clash = {
  a: Cell;
  b: Cell;
  distanceM: number;
  type: "mod3" | "pci";
  facing: boolean;
  /** Why the two sectors are linked. */
  reason: string;
  /** All same-Mod3 sectors sharing this overlap area (3-way or more). */
  groupMembers?: string[];
  /** Number of shared-coverage tiles that triggered this link. */
  tileCount?: number;
  /** Approximate shared (tile-covered) area in m². */
  tileAreaM2?: number;
  /** Tile ids (grid keys) that triggered the link. */
  tileKeys?: string[];
  /** Id of the multi-sector overlap group this clash belongs to. */
  groupId?: string;
  manual?: boolean;
};

/** A multi-sector (3-way or more) shared-coverage overlap. */
export type ClashGroup = {
  id: string;
  mod3: number;
  members: Cell[];
  tileKeys: string[];
  tileCount: number;
  areaM2: number;
  tileM: number;
};

/** Stable key for a pair of cells, order independent. */
export const pairKey = (a: string, b: string) => [a, b].sort().join("||");

const num = (v: string) =>
  Number(
    String(v ?? "")
      .trim()
      .replace(",", "."),
  );
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Numeric part of a site name, used as MRBTS/LNBTS when the file has no such column. */
function deriveBtsId(site: string) {
  const m = String(site).match(/\d+/g);
  return m ? m.join("") : String(site).trim();
}

/** Local cell id from a cell name: trailing number, else sector letter A/B/C → 1/2/3. */
function deriveLncel(cellName: string, idx: number) {
  const trailing = String(cellName).match(/(\d+)\s*$/);
  if (trailing) return trailing[1];
  const letter = String(cellName).match(/[_-]([A-Za-z])\s*$/);
  if (letter) return String(letter[1].toUpperCase().charCodeAt(0) - 64);
  return String((idx % 3) + 1);
}

/** Parses pasted CSV / TSV text with a header row. */
export function parseSites(text: string, rowOffset = 0): { cells: Cell[]; errors: string[] } {
  const errors: string[] = [];
  const cells: Cell[] = [];
  // Guard against a broken file producing hundreds of thousands of strings.
  const ERROR_LIMIT = 200;
  const addError = (msg: string) => {
    if (errors.length < ERROR_LIMIT) errors.push(msg);
    else if (errors.length === ERROR_LIMIT) errors.push("… more rows with issues were skipped.");
  };

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { cells, errors };

  const split = (l: string) => l.split(/\t|;|,(?![^(]*\))/).map((c) => c.trim());
  const header = split(lines[0]).map(norm);

  const used = new Set<number>();
  const pick = (exact: string[], partial: string[] = []) => {
    let i = header.findIndex((h, k) => !used.has(k) && exact.includes(h));
    if (i < 0) i = header.findIndex((h, k) => !used.has(k) && partial.some((p) => h.includes(p)));
    if (i >= 0) used.add(i);
    return i;
  };

  // PCI first so "PHY_CELL_ID" is not mistaken for a cell-name column.
  const iPci = pick(["pci", "phycellid", "physicalcellid", "phycellid"], ["pci", "phycell"]);
  const iLat = pick(["latitude", "lat"], ["latitud"]);
  const iLon = pick(["longitude", "lon", "lng", "long"], ["longitud"]);
  const iAz = pick(["azimut", "azimuth", "az", "bearing"], ["azimut", "bearing"]);
  const iBand = pick(
    ["celllayer", "band", "layer", "frequencyband", "earfcn"],
    ["celllayer", "band", "layer"],
  );
  const iCell = pick(
    ["txid", "cellname", "cellid", "cell", "sector", "sitelayer"],
    ["cellname", "txid", "sector"],
  );
  const iSite = pick(["name", "sitename", "site", "enodebname"], ["sitename", "site", "name"]);
  const iMrbts = pick(["mrbts", "mrbtsid"], ["mrbts"]);
  const iLnbts = pick(["lnbts", "lnbtsid", "enbid", "enodebid"], ["lnbts", "enbid"]);
  const iLncel = pick(["lncel", "lncelid", "localcellid", "cellidlocal"], ["lncel"]);

  if (iLat < 0 || iLon < 0 || iPci < 0) {
    errors.push("Header must include latitude, longitude and PCI columns.");
    return { cells, errors };
  }

  lines.slice(1).forEach((line, idx) => {
    const c = split(line);
    let lat = num(c[iLat]);
    let lon = num(c[iLon]);
    const pci = num(c[iPci]);
    const azimuth = iAz >= 0 ? num(c[iAz]) : 0;
    const cellName = (iCell >= 0 ? c[iCell] : iSite >= 0 ? c[iSite] : "") || `Cell ${idx + 1}`;
    const siteName = (iSite >= 0 ? c[iSite] : "") || cellName;
    const band = (iBand >= 0 ? c[iBand] : "") || "All";
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(pci)) {
      addError(`Row ${idx + 2 + rowOffset}: invalid lat/lon/PCI — skipped.`);
      return;
    }
    // Swapped columns: latitude can never exceed 90, longitude can.
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) {
      const t = lat;
      lat = lon;
      lon = t;
      addError(`Row ${idx + 2 + rowOffset}: latitude/longitude looked swapped — corrected.`);
    }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      addError(`Row ${idx + 2 + rowOffset}: coordinates out of range (${lat}, ${lon}) — skipped.`);
      return;
    }
    if (lat === 0 && lon === 0) {
      addError(`Row ${idx + 2 + rowOffset}: coordinates are 0,0 — skipped.`);
      return;
    }
    if (pci < 0 || pci > 503) addError(`Row ${idx + 2 + rowOffset}: PCI ${pci} is outside 0–503.`);

    const mrbts = (iMrbts >= 0 ? c[iMrbts] : "").trim() || deriveBtsId(siteName);
    const lnbts = (iLnbts >= 0 ? c[iLnbts] : "").trim() || mrbts;
    const lncel = (iLncel >= 0 ? c[iLncel] : "").trim() || deriveLncel(cellName, idx);
    cells.push({
      id: `${cellName}-${idx + rowOffset}`,

      site: siteName,
      cellName,
      band,
      lat,
      lon,
      azimuth: isFinite(azimuth) ? ((azimuth % 360) + 360) % 360 : 0,
      pci,
      mod3: ((pci % 3) + 3) % 3,
      mrbts,
      lnbts,
      lncel,
    });
  });

  return { cells, errors };
}

/**
 * Chunked parse: the same result as parseSites(), but processed in row blocks so
 * the UI can paint progress (percent + rows parsed) between chunks instead of
 * freezing on one long synchronous pass.
 */
export async function parseSitesChunked(
  text: string,
  opts: {
    chunkRows?: number;
    signal?: AbortSignal;
    onProgress?: (p: { percent: number; rows: number; totalRows: number; cells: number }) => void;
  } = {},
): Promise<{ cells: Cell[]; errors: string[]; rows: number; parseMs: number }> {
  const t0 = now();
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? "";
  const body = lines.slice(1).filter((l) => l.trim());
  const totalRows = body.length;
  const chunkRows = opts.chunkRows ?? 4000;

  const cells: Cell[] = [];
  const errors: string[] = [];

  for (let start = 0; start < totalRows; start += chunkRows) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const slice = body.slice(start, start + chunkRows);
    const res = parseSites([header, ...slice].join("\n"), start);
    cells.push(...res.cells);
    for (const e of res.errors) if (errors.length < 200) errors.push(e);
    const rows = Math.min(start + chunkRows, totalRows);
    opts.onProgress?.({
      percent: totalRows ? Math.round((rows / totalRows) * 100) : 100,
      rows,
      totalRows,
      cells: cells.length,
    });
    // Yield to the browser so the overlay repaints between chunks.
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  if (!totalRows) {
    const res = parseSites(text);
    return { ...res, rows: 0, parseMs: now() - t0 };
  }
  return { cells, errors, rows: totalRows, parseMs: now() - t0 };
}

export function distanceMeters(a: Cell, b: Cell) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a: Cell, b: Cell) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const angleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** Cells closer than this are treated as serving the same area regardless of azimuth. */
const SAME_AREA_M = 60;

/** Offsets a point by a distance/bearing, returning [lat, lon]. */
function project(lat: number, lon: number, brg: number, distM: number): [number, number] {
  const ang = (brg * Math.PI) / 180;
  const dLat = (distM * Math.cos(ang)) / 111320;
  const dLon = (distM * Math.sin(ang)) / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  return [lat + dLat, lon + dLon];
}

/** True when the point falls inside the cell's beam footprint. */
function inBeam(c: Cell, lat: number, lon: number, beamwidth: number, coverageM: number) {
  const p = { lat, lon } as Cell;
  const d = distanceMeters(c, p);
  if (d > coverageM) return false;
  if (d < 5) return true;
  return angleDiff(c.azimuth, bearing(c, p)) <= beamwidth / 2;
}

/** Cache of beam sample grids, keyed by sector geometry + beam settings. */
const sampleCache = new Map<string, [number, number][]>();

/** Dense sample points covering a sector wedge (radial x angular grid), cached per sector. */
function beamSamples(c: Cell, beamwidth: number, coverageM: number): [number, number][] {
  const ck = `${c.id}|${c.lat}|${c.lon}|${c.azimuth}|${beamwidth}|${coverageM}`;
  const hit = sampleCache.get(ck);
  if (hit) return hit;

  const pts: [number, number][] = [[c.lat, c.lon]];
  const rings = 8;
  const arcs = 10;
  for (let r = 1; r <= rings; r++) {
    const dist = (coverageM * r) / rings;
    for (let i = 0; i <= arcs; i++) {
      const brg = c.azimuth - beamwidth / 2 + (beamwidth * i) / arcs;
      pts.push(project(c.lat, c.lon, brg, dist));
    }
  }
  if (sampleCache.size > 20000) sampleCache.clear();
  sampleCache.set(ck, pts);
  return pts;
}

/** Two beams overlap when either footprint contains sample points of the other. */
function beamsOverlap(a: Cell, b: Cell, beamwidth: number, coverageM: number) {
  return (
    beamSamples(a, beamwidth, coverageM).some(([la, lo]) =>
      inBeam(b, la, lo, beamwidth, coverageM),
    ) ||
    beamSamples(b, beamwidth, coverageM).some(([la, lo]) => inBeam(a, la, lo, beamwidth, coverageM))
  );
}

export type OverlapInfo = {
  members: string[];
  tileKeys: string[];
  tileCount: number;
  areaM2: number;
  groupId?: string;
};

/** Cache of tile stamps, keyed by sector geometry + beam + grid settings. */
const tileCache = new Map<string, string[]>();

function sectorTiles(c: Cell, beamwidth: number, coverageM: number, tileM: number): string[] {
  const ck = `${c.id}|${c.lat}|${c.lon}|${c.azimuth}|${beamwidth}|${coverageM}|${tileM}`;
  const hit = tileCache.get(ck);
  if (hit) return hit;

  const latStep = tileM / 111320;
  const lonStep = tileM / (111320 * Math.cos((c.lat * Math.PI) / 180) || 1);
  const set = new Set<string>();
  for (const [la, lo] of beamSamples(c, beamwidth, coverageM))
    set.add(`${Math.round(la / latStep)}:${Math.round(lo / lonStep)}`);
  const out = [...set];
  if (tileCache.size > 20000) tileCache.clear();
  tileCache.set(ck, out);
  return out;
}

/**
 * Builds a shared-coverage map: the ground is divided into small tiles and every
 * beam stamps the tiles it covers. Any tile touched by 2+ same-Mod3 sectors means
 * those sectors all interfere over the same area — this catches multi-sector
 * (3-way and more) clashes that a strict pairwise "facing" test misses.
 */
function sharedAreaGroups(
  cells: Cell[],
  beamwidth: number,
  coverageM: number,
  tileM = 30,
): { pairs: Map<string, OverlapInfo>; groups: ClashGroup[] } {
  const tiles = new Map<string, Set<number>>();

  cells.forEach((c, idx) => {
    for (const key of sectorTiles(c, beamwidth, coverageM, tileM)) {
      if (!tiles.has(key)) tiles.set(key, new Set());
      tiles.get(key)!.add(idx);
    }
  });

  const tileArea = tileM * tileM;
  const pairs = new Map<string, OverlapInfo>();
  // signature (sorted member idxs + mod3) -> tiles
  const groupTiles = new Map<string, { idxs: number[]; mod3: number; tiles: string[] }>();

  tiles.forEach((set, tileKey) => {
    if (set.size < 2) return;
    const byMod = new Map<number, number[]>();
    [...set].forEach((i) => {
      const m = cells[i].mod3;
      if (!byMod.has(m)) byMod.set(m, []);
      byMod.get(m)!.push(i);
    });
    byMod.forEach((group, mod3) => {
      if (group.length < 2) return;
      const sig = `${mod3}#${[...group].sort((x, y) => x - y).join("-")}`;
      if (!groupTiles.has(sig)) groupTiles.set(sig, { idxs: group, mod3, tiles: [] });
      groupTiles.get(sig)!.tiles.push(tileKey);
    });
  });

  const groups: ClashGroup[] = [];
  groupTiles.forEach((g, sig) => {
    const members = g.idxs.map((i) => cells[i]);
    const info: ClashGroup = {
      id: sig,
      mod3: g.mod3,
      members,
      tileKeys: g.tiles,
      tileCount: g.tiles.length,
      areaM2: g.tiles.length * tileArea,
      tileM,
    };
    if (members.length > 2) groups.push(info);

    const names = members.map((m) => m.cellName);
    for (let x = 0; x < members.length; x++)
      for (let y = x + 1; y < members.length; y++) {
        const key = pairKey(members[x].id, members[y].id);
        const prev = pairs.get(key);
        if (
          !prev ||
          prev.members.length < names.length ||
          (prev.members.length === names.length && prev.tileCount < g.tiles.length)
        )
          pairs.set(key, {
            members: names,
            tileKeys: g.tiles,
            tileCount: g.tiles.length,
            areaM2: g.tiles.length * tileArea,
            groupId: members.length > 2 ? sig : undefined,
          });
      }
  });

  return {
    pairs,
    groups: groups.sort((a, b) => b.members.length - a.members.length || b.areaM2 - a.areaM2),
  };
}

/**
 * Relationship between two sectors: facing each other, co-sited beams pointing to the
 * same area, or footprints overlapping anywhere (e.g. three sectors covering one square).
 */
function relate(
  a: Cell,
  b: Cell,
  beamwidth: number,
  distanceM: number,
  coverageM: number,
  shared?: OverlapInfo,
): { facing: boolean; reason: string; groupMembers?: string[] } | null {
  const tol = beamwidth / 2 + 15;
  if (
    distanceM > SAME_AREA_M &&
    angleDiff(a.azimuth, bearing(a, b)) <= tol &&
    angleDiff(b.azimuth, bearing(b, a)) <= tol
  )
    return { facing: true, reason: "Sectors point at each other (back-to-back interference)" };

  if (distanceM <= SAME_AREA_M || a.site === b.site) {
    if (angleDiff(a.azimuth, b.azimuth) <= beamwidth)
      return { facing: true, reason: "Co-sited / co-located sectors covering the same area" };
  }

  if (shared && shared.members.length > 2)
    return {
      facing: true,
      reason: `${shared.members.length} same-Mod3 sectors overlap the same area (${shared.members.join(", ")})`,
      groupMembers: shared.members,
    };

  if (shared || beamsOverlap(a, b, beamwidth, coverageM))
    return { facing: true, reason: "Beam footprints overlap over the same area" };

  return null;
}

export type ClashOptions = {
  radiusM: number;
  beamwidth: number;
  facingOnly: boolean;
  sameBandOnly?: boolean;
  coverageM?: number;
  /** Shared-coverage grid resolution in metres. */
  tileM?: number;
  /** Ignore relations between two cells belonging to the same site (default true). */
  ignoreSameSite?: boolean;
  /** Manually drawn links (pairKey) — always included. */
  addedPairs?: string[];
  /** Manually deleted links (pairKey) — always excluded. */
  removedPairs?: string[];
};

/** Performance counters from the most recent analyzeClashes() run. */
export type PerfStats = {
  cells: number;
  pairsTotal: number;
  pairsCompared: number;
  comparisonsAvoided: number;
  analyzeMs: number;
};

export const getPerf = (): PerfStats => lastPerf;

export const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export let lastPerf: PerfStats = {
  cells: 0,
  pairsTotal: 0,
  pairsCompared: 0,
  comparisonsAvoided: 0,
  analyzeMs: 0,
};

/**
 * Candidate pair index list built from a lat/lon bucket grid sized to the search
 * radius. Cells further apart than the radius can never clash, so the scan drops
 * from O(n^2) distance tests to roughly O(n) without changing any result.
 */
function nearbyPairs(cells: Cell[], radiusM: number): Array<[number, number]> {
  const n = cells.length;
  if (n < 2) return [];
  // Small inputs: the grid overhead is not worth it.
  if (n <= 200) {
    const all: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push([i, j]);
    return all;
  }

  const meanLat = cells.reduce((s, c) => s + c.lat, 0) / n;
  const latStep = Math.max(radiusM, 1) / 111320;
  const lonStep = Math.max(radiusM, 1) / (111320 * Math.cos((meanLat * Math.PI) / 180) || 1);

  const buckets = new Map<string, number[]>();
  const gx = new Int32Array(n);
  const gy = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = Math.floor(cells[i].lon / lonStep);
    const y = Math.floor(cells[i].lat / latStep);
    gx[i] = x;
    gy[i] = y;
    const k = `${x}:${y}`;
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  }

  const out: Array<[number, number]> = [];
  const done = new Set<number>();
  for (let i = 0; i < n; i++) {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(`${gx[i] + dx}:${gy[i] + dy}`);
        if (!list) continue;
        for (const j of list) {
          if (j <= i) continue;
          const id = i * n + j;
          if (done.has(id)) continue;
          done.add(id);
          out.push([i, j]);
        }
      }
  }
  return out;
}

export function findClashes(cells: Cell[], opts: ClashOptions): Clash[] {
  return analyzeClashes(cells, opts).clashes;
}

/** Full analysis: pairwise clashes plus multi-sector (3-way+) overlap groups. */
export function analyzeClashes(
  cells: Cell[],
  opts: ClashOptions,
): { clashes: Clash[]; groups: ClashGroup[] } {
  const t0 = now();
  const coverageM = opts.coverageM ?? Math.min(opts.radiusM, 300);
  const removed = new Set(opts.removedPairs ?? []);
  const added = new Set(opts.addedPairs ?? []);
  const out: Clash[] = [];
  const seen = new Set<string>();
  const byId = new Map(cells.map((c) => [c.id, c]));
  const { pairs: shared, groups } = sharedAreaGroups(
    cells,
    opts.beamwidth,
    coverageM,
    opts.tileM ?? 30,
  );

  const candidates = nearbyPairs(cells, opts.radiusM);
  const n = cells.length;
  lastPerf = {
    cells: n,
    pairsTotal: (n * (n - 1)) / 2,
    pairsCompared: candidates.length,
    comparisonsAvoided: Math.max(0, (n * (n - 1)) / 2 - candidates.length),
    analyzeMs: 0,
  };

  for (const [i, j] of candidates) {
    {
      const a = cells[i];
      const b = cells[j];

      if (a.site === b.site && a.cellName === b.cellName) continue;
      // Cells on the same physical site are not a real Mod3 neighbour relation.
      if (opts.ignoreSameSite !== false && a.site === b.site) continue;
      const key = pairKey(a.id, b.id);
      if (removed.has(key)) continue;
      if (opts.sameBandOnly !== false && a.band !== b.band) continue;
      const d = distanceMeters(a, b);
      if (d > opts.radiusM) continue;
      if (a.mod3 !== b.mod3) continue;
      const info = shared.get(key);
      const rel = relate(a, b, opts.beamwidth, d, coverageM, info);
      if (opts.facingOnly && !rel) continue;
      seen.add(key);
      out.push({
        a,
        b,
        distanceM: d,
        type: a.pci === b.pci ? "pci" : "mod3",
        facing: !!rel,
        reason: rel?.reason ?? "Within the neighbour search radius",
        groupMembers: rel?.groupMembers,
        tileCount: info?.tileCount,
        tileAreaM2: info?.areaM2,
        tileKeys: info?.tileKeys,
        groupId: info?.groupId,
      });
    }
  }

  added.forEach((key) => {
    if (seen.has(key) || removed.has(key)) return;
    const [ia, ib] = key.split("||");
    const a = byId.get(ia);
    const b = byId.get(ib);
    if (!a || !b) return;
    // A manual link is only a clash while the two cells actually conflict; once
    // the re-plan clears it, no line is drawn between them any more.
    if (a.mod3 !== b.mod3 && a.pci !== b.pci) return;
    out.push({
      a,
      b,
      distanceM: distanceMeters(a, b),
      type: a.pci === b.pci ? "pci" : "mod3",
      facing: true,
      reason: "Manually added link",
      manual: true,
    });
  });

  lastPerf = { ...lastPerf, analyzeMs: now() - t0 };
  return {
    clashes: out.sort((x, y) => x.distanceM - y.distanceM),
    groups:
      opts.ignoreSameSite === false
        ? groups
        : groups.filter((g) => new Set(g.members.map((m) => m.site)).size > 1),
  };
}

export type PciSuggestion = {
  cell: Cell;
  oldPci: number;
  newPci: number | null;
  oldMod3: number;
  newMod3: number | null;
  clashCount: number;
  conflictsWith: string[];
  note: string;
};

/**
 * Every neighbour relation between cells (same geometry rules as the clash
 * scan, but WITHOUT the Mod3 / PCI test). The re-plan uses this so a same-site
 * PCI rotation is accepted only when it also stays clash-free against nearby
 * cells of other sites that are not clashing today.
 */
export function relationPairs(cells: Cell[], opts: ClashOptions): { a: string; b: string }[] {
  const coverageM = opts.coverageM ?? Math.min(opts.radiusM, 300);
  const removed = new Set(opts.removedPairs ?? []);
  const added = new Set(opts.addedPairs ?? []);
  const byId = new Map(cells.map((c) => [c.id, c]));
  const { pairs: shared } = sharedAreaGroups(cells, opts.beamwidth, coverageM, opts.tileM ?? 30);
  const out: { a: string; b: string }[] = [];
  const seen = new Set<string>();

  for (const [i, j] of nearbyPairs(cells, opts.radiusM)) {
    {
      const a = cells[i];
      const b = cells[j];

      if (a.site === b.site && a.cellName === b.cellName) continue;
      if (opts.ignoreSameSite !== false && a.site === b.site) continue;
      const key = pairKey(a.id, b.id);
      if (removed.has(key)) continue;
      if (opts.sameBandOnly !== false && a.band !== b.band) continue;
      const d = distanceMeters(a, b);
      if (d > opts.radiusM) continue;
      const rel = relate(a, b, opts.beamwidth, d, coverageM, shared.get(key));
      if (opts.facingOnly && !rel) continue;
      seen.add(key);
      out.push({ a: a.id, b: b.id });
    }
  }
  added.forEach((key) => {
    if (seen.has(key) || removed.has(key)) return;
    const [ia, ib] = key.split("||");
    if (byId.has(ia) && byId.has(ib)) out.push({ a: ia, b: ib });
  });
  return out;
}

/**
 * Iterative PCI re-plan. Existing same-site PCI rotations are preferred; when
 * rotations cannot reduce the remaining conflicts, a free PCI in the LTE
 * 0–503 range is assigned to the most constrained sector.
 */
export function suggestPciPlan(
  cells: Cell[],
  clashes: Clash[],
  opts?: ClashOptions,
): PciSuggestion[] {
  if (!clashes.length) return [];

  const byId = new Map(cells.map((c) => [c.id, { ...c }]));
  const original = new Map(cells.map((c) => [c.id, { pci: c.pci, mod3: c.mod3 }]));
  const neighbours = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  const pairs: { a: string; b: string }[] = [];
  const pairSeen = new Set<string>();
  const pushPair = (x: string, y: string) => {
    if (!byId.has(x) || !byId.has(y)) return;
    const k = pairKey(x, y);
    if (pairSeen.has(k)) return;
    pairSeen.add(k);
    add(x, y);
    add(y, x);
    pairs.push({ a: x, b: y });
  };
  // Full neighbour graph when options are known, so fixing one clash cannot
  // silently create a new one with another site; otherwise fall back to the
  // clashing pairs only.
  if (opts) relationPairs(cells, opts).forEach((p) => pushPair(p.a, p.b));
  clashes.forEach((c) => pushPair(c.a.id, c.b.id));

  const degree = new Map<string, number>();
  neighbours.forEach((set, id) => degree.set(id, set.size));

  const conflicting = (a: Cell, b: Cell) => a.mod3 === b.mod3 || a.pci === b.pci;
  /** Pairs touching each cell, so a site rotation only re-scores what it can affect. */
  const pairsOf = new Map<string, { a: string; b: string }[]>();
  for (const p of pairs) {
    if (!pairsOf.has(p.a)) pairsOf.set(p.a, []);
    if (!pairsOf.has(p.b)) pairsOf.set(p.b, []);
    pairsOf.get(p.a)!.push(p);
    pairsOf.get(p.b)!.push(p);
  }

  /**
   * Sectors grouped per physical site, so PCIs can be rotated within a site.
   * Real exports do not always carry a usable LNBTS/site column (it can be blank
   * or unique per row), which used to leave every group with a single sector and
   * therefore produce zero suggestions. Co-located sectors (identical rounded
   * coordinates) are treated as the same physical site in that case.
   */
  const siteKey = (c: Cell) => `${c.lnbts || c.mrbts || c.site || ""}`.trim();
  const coordKey = (c: Cell) => `@${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  const primary = new Map<string, string[]>();
  const coord = new Map<string, string[]>();
  cells.forEach((c) => {
    const k = siteKey(c);
    if (k) {
      if (!primary.has(k)) primary.set(k, []);
      primary.get(k)!.push(c.id);
    }
    const ck = coordKey(c);
    if (!coord.has(ck)) coord.set(ck, []);
    coord.get(ck)!.push(c.id);
  });
  // Use the named-site group when it has something to rotate, else fall back to
  // the co-location group.
  const bySite = new Map<string, string[]>();
  const groupOf = new Map<string, string>();
  cells.forEach((c) => {
    const k = siteKey(c);
    const named = k ? (primary.get(k) ?? []) : [];
    const key = named.length >= 2 ? k : coordKey(c);
    bySite.set(key, named.length >= 2 ? named : (coord.get(coordKey(c)) ?? []));
    groupOf.set(c.id, key);
  });

  const changed = new Set<string>();
  const notes = new Map<string, string>();

  /** Pairs (and therefore sites) each site rotation can affect — computed once. */
  const affectedOf = new Map<string, { a: string; b: string }[]>();
  const membersOf = new Map<string, string[]>();
  for (const [key] of bySite) {
    const ids = (bySite.get(key) ?? []).filter((id) => byId.has(id));
    membersOf.set(key, ids);
    const seen = new Set<{ a: string; b: string }>();
    for (const id of ids) for (const p of pairsOf.get(id) ?? []) seen.add(p);
    affectedOf.set(key, [...seen]);
  }

  // Worklist hill-climbing: only sites whose neighbourhood changed are re-scored,
  // instead of re-scoring every site on every pass.
  const queued = new Set<string>(bySite.keys());
  const queue: string[] = [...queued];
  const maxMoves = bySite.size * 8 + 200;
  let moves = 0;

  while (queue.length && moves < maxMoves) {
    const key = queue.shift()!;
    queued.delete(key);
    const ids = membersOf.get(key) ?? [];
    if (ids.length < 2) continue;
    const affected = affectedOf.get(key) ?? [];
    if (!affected.length) continue;
    if (!affected.some((p) => conflicting(byId.get(p.a)!, byId.get(p.b)!))) continue;

    const member = new Set(ids);
    // Score a rotation from per-member neighbour tallies (O(1) per member) plus
    // the few pairs internal to the site, instead of re-summing every affected pair.
    const outer = ids.map((id) => {
      const mod3 = [0, 0, 0];
      const pciCount = new Map<number, number>();
      for (const n of neighbours.get(id) ?? []) {
        if (member.has(n)) continue;
        const nb = byId.get(n);
        if (!nb) continue;
        mod3[((nb.pci % 3) + 3) % 3]++;
        pciCount.set(nb.pci, (pciCount.get(nb.pci) ?? 0) + 1);
      }
      return { mod3, pciCount };
    });
    const index = new Map(ids.map((id, i) => [id, i]));
    const internal = affected
      .filter((p) => member.has(p.a) && member.has(p.b))
      .map((p) => [index.get(p.a)!, index.get(p.b)!] as const);

    const current = ids.map((id) => byId.get(id)!.pci);
    const score = (pcis: number[]) => {
      let n = 0;
      for (let i = 0; i < pcis.length; i++) {
        const p = pcis[i];
        n += 2 * outer[i].mod3[((p % 3) + 3) % 3] + (outer[i].pciCount.get(p) ?? 0);
      }
      for (const [i, j] of internal) {
        if (pcis[i] % 3 === pcis[j] % 3) n += 2;
        if (pcis[i] === pcis[j]) n += 1;
      }
      return n;
    };
    const before = score(current);
    const apply = (pcis: number[]) =>
      ids.forEach((id, i) => {
        const c = byId.get(id)!;
        c.pci = pcis[i];
        c.mod3 = pcis[i] % 3;
      });

    let bestPcis: number[] | null = null;
    let bestGain = 0;
    const consider = (candidate: number[]) => {
      const gain = before - score(candidate);
      if (gain > bestGain) {
        bestGain = gain;
        bestPcis = [...candidate];
      }
    };

    if (ids.length <= 6) {
      const permute = (rest: number[], acc: number[]) => {
        if (!rest.length) {
          consider(acc);
          return;
        }
        for (let i = 0; i < rest.length; i++)
          permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
      };
      permute(current, []);
    } else {
      for (let i = 0; i < current.length; i++)
        for (let j = i + 1; j < current.length; j++) {
          const swapped = [...current];
          [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
          consider(swapped);
        }
    }

    if (!bestPcis) {
      apply(current);
      continue;
    }
    apply(bestPcis);
    moves++;
    ids.forEach((id, i) => {
      const c = byId.get(id)!;
      if (current[i] === c.pci) return;
      changed.add(id);
      notes.set(
        id,
        `Rotate PCI inside site ${c.site}: PCI ${current[i]} → ${c.pci} (Mod3 ${
          current[i] % 3
        } → ${c.pci % 3}) — uses only PCI values already assigned to this site.`,
      );
    });

    // Re-queue only the sites this move could have affected.
    for (const p of affected)
      for (const endpoint of [p.a, p.b]) {
        const k = groupOf.get(endpoint);
        if (!k || queued.has(k)) continue;
        queued.add(k);
        queue.push(k);
      }
  }

  // A rotation-only plan cannot repair sites whose available PCI values all
  // have the wrong Mod3 (or sites represented by a single sector). Finish the
  // plan with strict cost-reducing PCI assignments across the valid LTE range.
  // The score includes every neighbour relation, so fixing an existing clash
  // cannot silently create another one elsewhere.
  /**
   * Neighbour tallies per cell: Mod3 counts plus a PCI histogram. With these the
   * cost of any candidate PCI is O(1) instead of a walk over every neighbour,
   * which turns the 0–503 scan from 504×degree work into 504 lookups.
   */
  const tallies = (id: string) => {
    const mod3 = [0, 0, 0];
    const pciCount = new Map<number, number>();
    for (const neighbourId of neighbours.get(id) ?? []) {
      const neighbour = byId.get(neighbourId);
      if (!neighbour) continue;
      mod3[((neighbour.pci % 3) + 3) % 3]++;
      pciCount.set(neighbour.pci, (pciCount.get(neighbour.pci) ?? 0) + 1);
    }
    return { mod3, pciCount };
  };

  // Worklist again: only cells whose neighbourhood changed get re-scanned.
  const dirty = new Set<string>(pairs.flatMap((p) => [p.a, p.b]));
  const work: string[] = [...dirty];
  const maxAssignments = Math.min(pairs.length * 3 + 20, cells.length * 4 + 50);
  let assigned = 0;

  while (work.length && assigned < maxAssignments) {
    const id = work.shift()!;
    dirty.delete(id);
    const cell = byId.get(id);
    if (!cell) continue;
    const nbrIds = neighbours.get(id);
    if (!nbrIds?.size) continue;
    let conflicted = false;
    for (const n of nbrIds) {
      const other = byId.get(n);
      if (other && conflicting(cell, other)) {
        conflicted = true;
        break;
      }
    }
    if (!conflicted) continue;

    const { mod3, pciCount } = tallies(id);
    const costFor = (pci: number) => 2 * mod3[((pci % 3) + 3) % 3] + (pciCount.get(pci) ?? 0);
    const currentCost = costFor(cell.pci);
    const groupKey = groupOf.get(id);
    const usedAtSite = new Set(
      (groupKey ? (bySite.get(groupKey) ?? []) : [])
        .filter((otherId) => otherId !== id)
        .map((otherId) => byId.get(otherId)?.pci)
        .filter((pci): pci is number => pci != null),
    );

    let best: { pci: number; improvement: number } | null = null;
    for (let pci = 0; pci <= 503; pci++) {
      if (pci === cell.pci || usedAtSite.has(pci)) continue;
      const improvement = currentCost - costFor(pci);
      if (improvement <= 0) continue;
      if (
        !best ||
        improvement > best.improvement ||
        (improvement === best.improvement &&
          Math.abs(pci - cell.pci) < Math.abs(best.pci - cell.pci))
      )
        best = { pci, improvement };
    }
    if (!best) continue;

    const orig = original.get(id);
    if (!orig) continue;
    cell.pci = best.pci;
    cell.mod3 = ((best.pci % 3) + 3) % 3;
    assigned++;
    changed.add(id);
    notes.set(
      id,
      `Assign safe PCI ${best.pci} to ${cell.cellName}: PCI ${orig.pci} → ${best.pci} (Mod3 ${orig.mod3} → ${cell.mod3}); checked against all detected neighbours.`,
    );

    for (const n of nbrIds) {
      if (dirty.has(n)) continue;
      dirty.add(n);
      work.push(n);
    }
    if (!dirty.has(id)) {
      dirty.add(id);
      work.push(id);
    }
  }

  const suggestions: PciSuggestion[] = [];
  changed.forEach((id) => {
    const cell = byId.get(id)!;
    const orig = original.get(id)!;
    if (cell.pci === orig.pci) return;
    const nbrs = [...(neighbours.get(id) ?? [])].map((n) => byId.get(n)!).filter(Boolean);
    suggestions.push({
      cell: { ...cell, pci: orig.pci, mod3: orig.mod3 },
      oldPci: orig.pci,
      newPci: cell.pci,
      oldMod3: orig.mod3,
      newMod3: cell.mod3,
      clashCount: nbrs.length,
      conflictsWith: nbrs.map((n) => n.cellName),
      note: notes.get(id) ?? "",
    });
  });

  return suggestions.sort((a, b) => b.clashCount - a.clashCount);
}

/** Explains the rare conflicts that remain after rotations and safe assignments. */
export function explainUnresolvedClash(clash: Clash, cells: Cell[]): string {
  const siteKey = (c: Cell) => `${c.lnbts || c.mrbts || c.site || ""}`.trim();
  const coordKey = (c: Cell) => `@${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  const sectorCount = (c: Cell) => {
    const named = siteKey(c) ? cells.filter((x) => siteKey(x) === siteKey(c)).length : 0;
    return named >= 2 ? named : cells.filter((x) => coordKey(x) === coordKey(c)).length;
  };
  const na = sectorCount(clash.a);
  const nb = sectorCount(clash.b);

  if (na < 2 && nb < 2)
    return `${clash.a.site} and ${clash.b.site} are both highly constrained by their other neighbours; changing either PCI would create an equal or larger conflict elsewhere.`;
  return `All same-site rotations and safe PCI values from 0–503 were evaluated for ${clash.a.site} and ${clash.b.site}; no single cost-reducing change is available without creating an equal or larger neighbour conflict.`;
}

/** Polygon points for a sector wedge, in [lat, lon] pairs. */
export function sectorPolygon(
  lat: number,
  lon: number,
  azimuth: number,
  beamwidth: number,
  radiusM: number,
): [number, number][] {
  const pts: [number, number][] = [[lat, lon]];
  const start = azimuth - beamwidth / 2;
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const ang = ((start + (beamwidth * i) / steps) * Math.PI) / 180;
    const dLat = (radiusM * Math.cos(ang)) / 111320;
    const dLon = (radiusM * Math.sin(ang)) / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
    pts.push([lat + dLat, lon + dLon]);
  }
  return pts;
}

/** Representative point of a sector beam (used to draw links cell-to-cell, not site-to-site). */
export function sectorCenter(
  c: { lat: number; lon: number; azimuth: number },
  radiusM: number,
): { lat: number; lng: number } {
  const ang = (c.azimuth * Math.PI) / 180;
  const d = radiusM * 0.6;
  return {
    lat: c.lat + (d * Math.cos(ang)) / 111320,
    lng: c.lon + (d * Math.sin(ang)) / (111320 * Math.cos((c.lat * Math.PI) / 180) || 1),
  };
}

/** Ray-casting point-in-polygon test. Path is [lat, lng] pairs. */
export function pointInPolygon(lat: number, lng: number, path: [number, number][]) {
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const [yi, xi] = path[i];
    const [yj, xj] = path[j];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export const MOD3_COLORS = ["#22d3ee", "#f59e0b", "#a78bfa"];

export const SAMPLE_CSV = `NAME	TX_ID	LONGITUDE	LATITUDE	HEIGHT	AZIMUT	Site+Layer	Cell Layer	PHY_CELL_ID	PRACH_RSI_LIST
CAI001	CAI001_L18_A	31.23570	30.04420	25	0	CAI001_L18	L1800	10	0
CAI001	CAI001_L18_B	31.23570	30.04420	25	120	CAI001_L18	L1800	11	4
CAI001	CAI001_L18_C	31.23570	30.04420	25	240	CAI001_L18	L1800	12	8
CAI001	CAI001_L21_A	31.23570	30.04420	25	0	CAI001_L21	L2100	40	12
CAI002	CAI002_L18_A	31.23980	30.04780	30	180	CAI002_L18	L1800	22	16
CAI002	CAI002_L18_B	31.23980	30.04780	30	300	CAI002_L18	L1800	23	20
CAI002	CAI002_L21_A	31.23980	30.04780	30	180	CAI002_L21	L2100	43	24
CAI003	CAI003_L18_A	31.24300	30.04120	22	300	CAI003_L18	L1800	37	28
CAI003	CAI003_L18_B	31.24300	30.04120	22	60	CAI003_L18	L1800	38	32
CAI004	CAI004_L21_A	31.23100	30.05010	28	150	CAI004_L21	L2100	55	36
CAI004	CAI004_L21_B	31.23100	30.05010	28	270	CAI004_L21	L2100	56	40`;
