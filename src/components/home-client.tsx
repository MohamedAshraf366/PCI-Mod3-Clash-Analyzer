"use client";

import { createPortal } from "react-dom";
import {
  lazy,
  memo,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ClientOnly } from "@/components/client-only";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useTheme } from "@/hooks/use-theme";
import { useClashWorker } from "@/hooks/use-clash-worker";
import { TABLE_ACCEPT, readTableFile } from "@/lib/read-table-file";
import { readKmlFile } from "@/lib/read-kml";
import type { Cell, Clash, ClashGroup } from "@/lib/mod3";
import { ChevronDown, Github, Link2, Linkedin, Globe, Search, X } from "lucide-react";

import {
  MOD3_COLORS,
  SAMPLE_CSV,
  explainUnresolvedClash,
  pairKey,
  parseSites,
  parseSitesChunked,
  pointInPolygon,
  sectorPolygon,
  sectorCenter,
} from "@/lib/mod3";

const ClashMap = lazy(() => import("@/components/ClashMap"));

const MAP_VIEWS = [
  { id: "roadmap", label: "GoogleMap" },
  { id: "hybrid", label: "GoogleHybridMap" },
  { id: "satellite", label: "GoogleSatelliteMap" },
  { id: "terrain", label: "GoogleTerrainMap" },
  { id: "bing_road", label: "BingMap" },
  { id: "bing_hybrid", label: "BingHybridMap" },
  { id: "bing_satellite", label: "BingSatelliteMap" },
  { id: "osm", label: "OpenStreetMap" },
];

/** Column headers used by the downloadable blank template. */
const TEMPLATE_HEADERS = [
  "NAME",
  "TX_ID",
  "LONGITUDE",
  "LATITUDE",
  "HEIGHT",
  "AZIMUT",
  "Site+Layer",
  "Cell Layer",
  "PHY_CELL_ID",
  "PRACH_RSI_LIST",
];

/** Shown only while the textarea is empty — never treated as data. */
const PLACEHOLDER_TABLE = `${TEMPLATE_HEADERS.join("\t")}
CAI001\tCAI001_L18_A\t31.23570\t30.04420\t25\t0\tCAI001_L18\tL1800\t10\t0`;

/** Full diagnostic text for the error panel: message, stack and the context it failed in. */
function errorTrace(error: unknown, context: Record<string, unknown> = {}): string {
  const lines: string[] = [];
  lines.push(`Time: ${new Date().toISOString()}`);
  for (const [k, v] of Object.entries(context)) lines.push(`${k}: ${String(v)}`);
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth++) {
    const label = depth === 0 ? "" : "Caused by: ";
    if (current instanceof Error) {
      lines.push(`${label}${current.name}: ${current.message}`);
      if (current.stack) lines.push(current.stack);
      current = current.cause;
    } else {
      lines.push(`${label}${typeof current === "string" ? current : JSON.stringify(current)}`);
      break;
    }
  }
  return lines.join("\n").slice(0, 8000);
}

export default function HomeClient() {
  const { theme, toggleTheme } = useTheme();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [task, setTask] = useState<{
    step: string;
    label: string;
    percent: number | null;
    detail?: string;
    rate?: string;
    etaSeconds?: number;
  } | null>(null);
  const [metrics, setMetrics] = useState<{
    loadMs?: number;
    parseMs?: number;
    analyzeMs?: number;
    rows?: number;
    cellsParsed?: number;
    pairsCompared?: number;
    comparisonsAvoided?: number;
  }>({});
  const abortRef = useRef<AbortController | null>(null);

  const [errorPanel, setErrorPanel] = useState<{
    title: string;
    detail: string;
    hint: string;
    trace?: string;
  } | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [raw, setRaw] = useState("");
  const [parsedUpload, setParsedUpload] = useState<{
    text: string;
    cells: Cell[];
    errors: string[];
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [radius, setRadius] = useState(800);
  const [beamwidth, setBeamwidth] = useState(65);
  const [sectorRadius, setSectorRadius] = useState(180);
  const [linkWidth, setLinkWidth] = useState(4);
  const [glow, setGlow] = useState(100);
  const [linkStyle, setLinkStyle] = useState<"solid" | "dashed" | "dotted">("solid");
  const [linkColor, setLinkColor] = useState<string>("#000000");
  const [linkColors, setLinkColors] = useState<Record<string, string>>({});
  const [mapFull, setMapFull] = useState(false);

  const [facingOnly, setFacingOnly] = useState(true);
  const [sameBandOnly, setSameBandOnly] = useState(true);
  const [ignoreSameSite, setIgnoreSameSite] = useState(true);
  const [clashedOnly, setClashedOnly] = useState(false);
  const [band, setBand] = useState("all");
  const [linkMode, setLinkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [addedPairs, setAddedPairs] = useState<string[]>([]);
  const [removedPairs, setRemovedPairs] = useState<string[]>([]);
  const [mapType, setMapType] = useState("roadmap");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drawShape, setDrawShape] = useState<"polygon" | "rectangle" | "circle" | null>(null);
  const [selectionPath, setSelectionPath] = useState<[number, number][] | null>(null);
  /** Keep sites outside the drawn area visible on the map (analysis still uses the area only). */
  const [showOutside, setShowOutside] = useState(true);

  const [tileM, setTileM] = useState(30);
  const [siteFilter, setSiteFilter] = useState("");

  // Leave the full-screen map with Esc.
  useEffect(() => {
    if (!mapFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMapFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mapFull]);

  const deferredRaw = useDeferredValue(raw);
  const { cells: allCells, errors } = useMemo(
    () =>
      parsedUpload && parsedUpload.text === deferredRaw
        ? { cells: parsedUpload.cells, errors: parsedUpload.errors }
        : parseSites(deferredRaw),
    [deferredRaw, parsedUpload],
  );

  const bands = useMemo(() => Array.from(new Set(allCells.map((c) => c.band))).sort(), [allCells]);

  /** Band + site-name filtered pool, ignoring the drawn area. */
  const filteredCells = useMemo(() => {
    const terms = siteFilter
      .split(/[,\s]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    return allCells.filter((c) => {
      if (band !== "all" && c.band !== band) return false;
      if (
        terms.length &&
        !terms.some((t) => c.site.toLowerCase().includes(t) || c.cellName.toLowerCase().includes(t))
      )
        return false;
      return true;
    });
  }, [allCells, band, siteFilter]);

  const hasArea = !!(selectionPath && selectionPath.length > 2);

  /** Only cells inside the drawn analysis area take part in the calculations. */
  const cells = useMemo(
    () =>
      hasArea
        ? filteredCells.filter((c) => pointInPolygon(c.lat, c.lon, selectionPath!))
        : filteredCells,
    [filteredCells, hasArea, selectionPath],
  );

  /** Cells outside the drawn area, kept on the map as context when enabled. */
  const outsideCells = useMemo(
    () =>
      hasArea ? filteredCells.filter((c) => !pointInPolygon(c.lat, c.lon, selectionPath!)) : [],
    [filteredCells, hasArea, selectionPath],
  );

  const dRadius = useDeferredValue(radius);
  const dBeamwidth = useDeferredValue(beamwidth);
  const dSectorRadius = useDeferredValue(sectorRadius);
  const dTileM = useDeferredValue(tileM);

  // Clash analysis and PCI re-planning run on a background Web Worker (see
  // use-clash-worker.ts) so the geometry / graph work below never blocks the
  // main thread, no matter how large the loaded site table is.
  const { runAnalyze, runReplan } = useClashWorker();

  // Heavy scan — deliberately does NOT depend on removedPairs, so deleting a
  // link never triggers a full re-analysis.
  const baseAnalyzeOpts = useMemo(
    () => ({
      radiusM: dRadius,
      beamwidth: dBeamwidth,
      facingOnly,
      sameBandOnly,
      ignoreSameSite,
      coverageM: dSectorRadius,
      tileM: dTileM,
      addedPairs,
    }),
    [
      dRadius,
      dBeamwidth,
      facingOnly,
      sameBandOnly,
      ignoreSameSite,
      dSectorRadius,
      dTileM,
      addedPairs,
    ],
  );

  const [baseResult, setBaseResult] = useState<{ clashes: Clash[]; groups: ClashGroup[] }>({
    clashes: [],
    groups: [],
  });
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAnalyzing(true);
    runAnalyze(cells, baseAnalyzeOpts).then((res) => {
      if (cancelled) return;
      setBaseResult({ clashes: res.clashes, groups: res.groups });
      // Roll the analysis run's counters into the metrics shown in the overlay.
      setMetrics((m) => ({
        ...m,
        analyzeMs: res.perf.analyzeMs,
        pairsCompared: res.perf.pairsCompared,
        comparisonsAvoided: res.perf.comparisonsAvoided,
      }));
      setAnalyzing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [cells, baseAnalyzeOpts, runAnalyze]);

  const { clashes: baseClashes, groups } = baseResult;

  // Deleted links are just filtered out — O(n) and instant.
  const clashes = useMemo(() => {
    if (!removedPairs.length) return baseClashes;
    const removed = new Set(removedPairs);
    return baseClashes.filter((c) => !removed.has(pairKey(c.a.id, c.b.id)));
  }, [baseClashes, removedPairs]);

  const degrees = useMemo(() => {
    const d: Record<string, number> = {};
    clashes.forEach((c) => {
      d[c.a.id] = (d[c.a.id] ?? 0) + 1;
      d[c.b.id] = (d[c.b.id] ?? 0) + 1;
    });
    return d;
  }, [clashes]);

  const clashedIds = useMemo(() => new Set(Object.keys(degrees)), [degrees]);

  const mapCells = useMemo(() => {
    const base = clashedOnly ? cells.filter((c) => clashedIds.has(c.id)) : cells;
    return showOutside && outsideCells.length ? [...base, ...outsideCells] : base;
  }, [cells, clashedOnly, clashedIds, showOutside, outsideCells]);

  const [reasonsOpen, setReasonsOpen] = useState(false);

  // Header is sticky in normal flow — no manual height offset needed.

  const analyzeOpts = useMemo(
    () => ({
      radiusM: dRadius,
      beamwidth: dBeamwidth,
      facingOnly,
      sameBandOnly,
      ignoreSameSite,
      coverageM: dSectorRadius,
      tileM: dTileM,
      addedPairs,
      removedPairs,
    }),
    [
      dRadius,
      dBeamwidth,
      facingOnly,
      sameBandOnly,
      ignoreSameSite,
      dSectorRadius,
      dTileM,
      addedPairs,
      removedPairs,
    ],
  );

  /**
   * Prefer same-site rotations, then assign safe LTE PCI values for unresolved
   * clashes. Runs on the background worker — suggestPciPlan rebuilds the same
   * expensive geometry graph as the main scan, which used to risk Chrome's
   * "Page Unresponsive" dialog on larger files when it ran on the UI thread.
   */
  const [replanResult, setReplanResult] = useState<{
    suggestions: import("@/lib/clash-worker").ReplanSuggestion[];
    resolvedCells: Cell[];
    resolvedClashes: Clash[];
    resolvedGroups: ClashGroup[];
  }>({ suggestions: [], resolvedCells: [], resolvedClashes: [], resolvedGroups: [] });
  const [replanning, setReplanning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReplanning(true);
    runReplan(cells, clashes, analyzeOpts).then((res) => {
      if (cancelled) return;
      setReplanResult(res);
      setReplanning(false);
    });
    return () => {
      cancelled = true;
    };
  }, [cells, clashes, analyzeOpts, runReplan]);

  const { suggestions, resolvedCells, resolvedClashes, resolvedGroups } = replanResult;

  /** Why each surviving clash couldn't be cleared by same-site PCI rotation. */
  const unresolvedReasons = useMemo(
    () =>
      resolvedClashes.map((c) => ({
        clash: c,
        reason: explainUnresolvedClash(c, resolvedCells),
      })),
    [resolvedClashes, resolvedCells],
  );

  const recomputing =
    deferredRaw !== raw ||
    dRadius !== radius ||
    dBeamwidth !== beamwidth ||
    dSectorRadius !== sectorRadius ||
    dTileM !== tileM ||
    analyzing ||
    replanning;
  const activeTask =
    task ??
    (recomputing && raw.trim()
      ? { step: "computing", label: "Updating results", percent: 95 }
      : null);

  const resolvedDegrees = useMemo(() => {
    const d: Record<string, number> = {};
    resolvedClashes.forEach((c) => {
      d[c.a.id] = (d[c.a.id] ?? 0) + 1;
      d[c.b.id] = (d[c.b.id] ?? 0) + 1;
    });
    return d;
  }, [resolvedClashes]);

  const mod3Dist = useMemo(() => {
    const count = (list: Cell[]) => [0, 1, 2].map((m) => list.filter((c) => c.mod3 === m).length);
    return { before: count(cells), after: count(resolvedCells) };
  }, [cells, resolvedCells]);

  const changedCount = useMemo(
    () => resolvedCells.filter((c, i) => c.pci !== cells[i]?.pci).length,
    [cells, resolvedCells],
  );

  /** Cap rendered rows in the drawn-area table to keep the page responsive. */
  const AREA_ROW_LIMIT = 300;

  /** Map search: jump to the first matching site / cell. Returns a status message. */
  const findAndFocus = (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const pool = mapCells.length ? mapCells : cells;
    const hit =
      pool.find((c) => c.site.toLowerCase() === q || c.cellName.toLowerCase() === q) ??
      pool.find((c) => c.site.toLowerCase().includes(q) || c.cellName.toLowerCase().includes(q));
    if (!hit) return `No site or cell matching “${query.trim()}”.`;
    setFocusId(null);
    setTimeout(() => setFocusId(hit.id), 0);
    return `Moved to ${hit.site} · ${hit.cellName}`;
  };

  const cancelTask = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTask(null);
  };

  const handleKmlUpload = async (file: File) => {
    try {
      const res = await readKmlFile(file);
      if (res.errors.length) {
        setFileError(res.errors.join("; "));
        setErrorPanel({
          title: "Some KML points could not be read",
          detail: res.errors.join("\n"),
          hint: "The file may contain legend overlays or unsupported placemark types. Points with 'Serving Cell Identity: N' are used directly.",
        });
      }
      if (res.cells.length) {
        // Merge with existing site-table cells instead of replacing
        const existing = parsedUpload?.cells ?? [];
        const merged = res.cells.map((kmlCell) => {
          // Find nearest existing cell by lat/lon (within ~100m = ~0.001°)
          const nearest = existing.find((c) => {
            const dLat = Math.abs(c.lat - kmlCell.lat);
            const dLon = Math.abs(c.lon - kmlCell.lon);
            return dLat < 0.001 && dLon < 0.001;
          });
          return nearest
            ? { ...nearest, pci: kmlCell.pci, mod3: kmlCell.mod3 }
            : kmlCell;
        });
        // Also keep existing cells not matched by KML
        const kmlIds = new Set(res.cells.map((c) => c.id));
        const kept = existing.filter((c) => !merged.some((m) => m.id === c.id));
        const finalCells = [...merged, ...kept];

        setFileName(file.name);
        setFileError(null);
        setParsedUpload({
          text: parsedUpload?.text ?? "",
          cells: finalCells,
          errors: res.errors,
        });
        setMetrics((m) => ({
          ...m,
          cellsParsed: finalCells.length,
          loadMs: 0,
          parseMs: 0,
        }));
      } else {
        setFileError("No Serving Cell Identity points found in KML.");
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : "Failed to read KML/KMZ.");
    }
  };

  const handleUpload = async (file?: File | null) => {
    if (!file) return;
    setFileError(null);
    setErrorPanel(null);
    setMetrics({});
    setParsedUpload(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t0 = performance.now();
    setTask({
      step: "loading",
      label: `Loading ${file.name}`,
      percent: 0,
      detail: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
    });
    // Let the overlay paint before the (blocking) read + parse work starts.
    await nextFrame();
    try {
      const text = await readTableFile(file, {
        signal: ctrl.signal,
        onProgress: (percent) => {
          const elapsedS = Math.max((performance.now() - t0) / 1000, 0.01);
          const loadedBytes = file.size * (percent / 100);
          const bytesPerSecond = loadedBytes / elapsedS;
          setTask({
            step: "loading",
            label: `Loading ${file.name}`,
            percent: Math.round(percent * 0.2),
            detail: `${formatBytes(loadedBytes)} / ${formatBytes(file.size)}`,
            rate: `${formatBytes(bytesPerSecond)}/s`,
            etaSeconds: bytesPerSecond > 0 ? (file.size - loadedBytes) / bytesPerSecond : undefined,
          });
        },
      });
      if (ctrl.signal.aborted) return;
      const loadMs = performance.now() - t0;
      setMetrics((m) => ({ ...m, loadMs }));
      setTask({ step: "parsing", label: "Parsing rows", percent: 0 });
      await nextFrame();
      const parseStarted = performance.now();
      // Chunked parse: progress and intermediate row counts while work continues.
      const parsed = await parseSitesChunked(text, {
        signal: ctrl.signal,
        chunkRows: 1000,
        onProgress: ({ percent, rows, totalRows, cells: parsedCells }) => {
          const elapsedS = Math.max((performance.now() - parseStarted) / 1000, 0.01);
          const rowsPerSecond = rows / elapsedS;
          setTask({
            step: "parsing",
            label: "Parsing rows",
            percent: 20 + Math.round(percent * 0.6),
            detail: `${rows.toLocaleString()} / ${totalRows.toLocaleString()} rows · ${parsedCells.toLocaleString()} cells`,
            rate: `${Math.round(rowsPerSecond).toLocaleString()} rows/s`,
            etaSeconds: rowsPerSecond > 0 ? (totalRows - rows) / rowsPerSecond : undefined,
          });
          setMetrics((m) => ({ ...m, rows, cellsParsed: parsedCells }));
        },
      });
      if (ctrl.signal.aborted) return;
      setMetrics((m) => ({
        ...m,
        parseMs: parsed.parseMs,
        rows: parsed.rows,
        cellsParsed: parsed.cells.length,
      }));
      setTask({
        step: "computing",
        label: "Computing clashes",
        percent: 80,
        detail: `${parsed.cells.length.toLocaleString()} cells ready · building spatial index`,
      });
      await nextFrame();
      const analyzeStarted = performance.now();
      const { perf } = await runAnalyze(parsed.cells, {
        radiusM: dRadius,
        beamwidth: dBeamwidth,
        facingOnly,
        sameBandOnly,
        ignoreSameSite,
        coverageM: dSectorRadius,
        tileM: dTileM,
        addedPairs: [],
        removedPairs: [],
      });
      if (ctrl.signal.aborted) return;
      setMetrics((m) => ({
        ...m,
        analyzeMs: performance.now() - analyzeStarted,
        pairsCompared: perf.pairsCompared,
        comparisonsAvoided: perf.comparisonsAvoided,
      }));
      setTask({
        step: "computing",
        label: "Displaying results",
        percent: 100,
        detail: `${parsed.cells.length.toLocaleString()} cells · ${perf.pairsCompared.toLocaleString()} comparisons`,
        etaSeconds: 0,
      });
      setParsedUpload({ text, cells: parsed.cells, errors: parsed.errors });
      setRaw(text);
      setFileName(file.name);
      await nextFrame();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setFileName(null);
        return;
      }
      const detail = e instanceof Error ? e.message : "Could not read that file.";
      setFileError(detail);
      setErrorPanel({
        title: "Could not load this file",
        detail,
        hint: "Use a CSV, TSV or XLSX export with a header row. If the file is open in Excel, close it and try again, or paste the table manually below.",
        trace: errorTrace(e, { file: file.name, size: file.size, type: file.type }),
      });
      setFileName(null);
    } finally {
      abortRef.current = null;
      setTask(null);
    }
  };

  // Link mode selects any number of sectors; linking connects them all together.
  const handleSectorClick = (cell: Cell) => {
    setSelectedIds((ids) =>
      ids.includes(cell.id) ? ids.filter((i) => i !== cell.id) : [...ids, cell.id],
    );
  };

  const commitLinks = () => {
    if (selectedIds.length < 2) return;
    const keys: string[] = [];
    for (let i = 0; i < selectedIds.length; i++)
      for (let j = i + 1; j < selectedIds.length; j++)
        keys.push(pairKey(selectedIds[i], selectedIds[j]));
    setRemovedPairs((r) => r.filter((k) => !keys.includes(k)));
    setAddedPairs((a) => Array.from(new Set([...a, ...keys])));
    setSelectedIds([]);
  };

  const handleDeleteLink = (key: string) => {
    setTask({
      step: "computing",
      label: "Deleting link…",
      percent: null,
      detail: "Removing the relation and refreshing the clash list",
    });
    // Paint the overlay first, then apply the state change.
    requestAnimationFrame(() => {
      setAddedPairs((a) => a.filter((k) => k !== key));
      setRemovedPairs((r) => (r.includes(key) ? r : [...r, key]));
      requestAnimationFrame(() => setTask(null));
    });
  };

  function downloadCsv(name: string, rows: (string | number)[][]) {
    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Empty workbook-style template: header row + one example row to overwrite. */
  const downloadTemplate = () =>
    downloadCsv("mod3_site_table_template.csv", [
      TEMPLATE_HEADERS,
      ["CAI001", "CAI001_L18_A", 31.2357, 30.0442, 25, 0, "CAI001_L18", "L1800", 10, 0],
    ]);

  const exportAreaCells = () =>
    downloadCsv("cells_inside_area.csv", [
      ["MRBTS", "LNBTS", "LNCEL", "Site", "Cell", "Band", "PCI", "Mod3", "Azimuth"],
      ...cells.map((c) => [
        c.mrbts,
        c.lnbts,
        c.lncel,
        c.site,
        c.cellName,
        c.band,
        c.pci,
        c.mod3,
        c.azimuth,
      ]),
    ]);

  const exportClashes = () =>
    downloadCsv("mod3_clashes.csv", [
      [
        "Site A",
        "Cell A",
        "PCI A",
        "Site B",
        "Cell B",
        "PCI B",
        "Band",
        "Mod3",
        "Distance (m)",
        "Type",
        "Facing",
        "Reason",
        "Group id",
        "Group sectors",
        "Shared tiles",
        "Shared area (m2)",
        "Tile ids",
      ],
      ...clashes.map((c) => [
        c.a.site,
        c.a.cellName,
        c.a.pci,
        c.b.site,
        c.b.cellName,
        c.b.pci,
        c.a.band === c.b.band ? c.a.band : `${c.a.band}/${c.b.band}`,
        c.a.mod3,
        Math.round(c.distanceM),
        c.type === "pci" ? "Same PCI" : "Mod3",
        c.facing ? "yes" : "no",
        c.reason,
        c.groupId ?? "-",
        c.groupMembers?.join(" | ") ?? "-",
        c.tileCount ?? 0,
        Math.round(c.tileAreaM2 ?? 0),
        (c.tileKeys ?? []).slice(0, 40).join(" "),
      ]),
    ]);

  const exportGroups = () =>
    downloadCsv("mod3_overlap_groups.csv", [
      [
        "Group id",
        "Mod3",
        "Sectors",
        "Sites",
        "PCIs",
        "Tile size (m)",
        "Tiles",
        "Area (m2)",
        "Tile ids",
      ],
      ...groups.map((g) => [
        g.id,
        g.mod3,
        g.members.map((m) => m.cellName).join(" | "),
        Array.from(new Set(g.members.map((m) => m.site))).join(" | "),
        g.members.map((m) => m.pci).join(" | "),
        g.tileM,
        g.tileCount,
        Math.round(g.areaM2),
        g.tileKeys.slice(0, 60).join(" "),
      ]),
    ]);

  const exportPdf = async () => {
    setErrorPanel(null);
    setTask({ step: "exporting", label: "Building PDF report", percent: null });
    await nextFrame();
    try {
      const { default: jsPDF } = await import("jspdf");
      const { default: autoTable } = await import("jspdf-autotable");
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(14);
      doc.text("LTE PCI Mod3 Clash Report", 14, 14);
      doc.setFontSize(9);
      doc.text(
        `Cells ${cells.length} · Clash pairs ${clashes.length} · Multi-sector groups ${groups.length} · Beamwidth ${beamwidth}° · Coverage ${sectorRadius} m`,
        14,
        20,
      );

      autoTable(doc, {
        startY: 26,
        styles: { fontSize: 7 },
        head: [
          [
            "Cell A",
            "Cell B",
            "Band",
            "PCI",
            "Mod3",
            "Dist (m)",
            "Tiles",
            "Area (m2)",
            "Group",
            "Reason",
          ],
        ],
        body: clashes.map((c) => [
          c.a.cellName,
          c.b.cellName,
          c.a.band === c.b.band ? c.a.band : `${c.a.band}/${c.b.band}`,
          `${c.a.pci}/${c.b.pci}`,
          c.a.mod3,
          Math.round(c.distanceM),
          c.tileCount ?? 0,
          Math.round(c.tileAreaM2 ?? 0),
          c.groupId ?? "-",
          c.reason,
        ]),
      });

      if (groups.length) {
        doc.addPage("a4", "landscape");
        doc.setFontSize(12);
        doc.text("Multi-sector overlap groups (3-way+)", 14, 14);
        autoTable(doc, {
          startY: 20,
          styles: { fontSize: 7 },
          head: [["Group", "Mod3", "Sectors (PCI)", "Tiles", "Area (m2)", "Tile ids"]],
          body: groups.map((g) => [
            g.id,
            g.mod3,
            g.members.map((m) => `${m.cellName} (${m.pci})`).join(", "),
            g.tileCount,
            Math.round(g.areaM2),
            g.tileKeys.slice(0, 25).join(" "),
          ]),
        });
      }

      if (suggestions.length) {
        doc.addPage("a4", "landscape");
        doc.setFontSize(12);
        doc.text("Suggested PCI re-plan", 14, 14);
        autoTable(doc, {
          startY: 20,
          styles: { fontSize: 7 },
          head: [["Site", "Sector", "Band", "Old PCI", "New PCI", "Mod3", "Conflicts with"]],
          body: suggestions.map((s) => [
            s.cell.site,
            s.cell.cellName,
            s.cell.band,
            s.oldPci,
            s.newPci ?? "-",
            `${s.oldMod3} -> ${s.newMod3 ?? "-"}`,
            s.conflictsWith.join(", "),
          ]),
        });
      }

      doc.save("mod3_clash_report.pdf");
    } catch (e) {
      setErrorPanel({
        title: "PDF export failed",
        detail: e instanceof Error ? e.message : "Unknown export error.",
        hint: "Try narrowing the scope (band / drawn area) to reduce the report size, then export again. CSV export always works as a fallback.",
        trace: errorTrace(e, {
          cells: cells.length,
          clashes: clashes.length,
          groups: groups.length,
          suggestions: suggestions.length,
        }),
      });
    } finally {
      setTask(null);
    }
  };

  const exportPlan = () =>
    downloadCsv("pci_replan.csv", [
      [
        "Site",
        "Sector",
        "Band",
        "Old PCI",
        "Old Mod3",
        "New PCI",
        "New Mod3",
        "Clashes",
        "Conflicts with",
      ],
      ...suggestions.map((s) => [
        s.cell.site,
        s.cell.cellName,
        s.cell.band,
        s.oldPci,
        s.oldMod3,
        s.newPci ?? "-",
        s.newMod3 ?? "-",
        s.clashCount,
        s.conflictsWith.join(" | "),
      ]),
    ]);

  /**
   * Full clone of the loaded data for every cell in scope, using the same template
   * columns, but with the PCI / Mod3 after the Mod3 clash resolve.
   */
  const exportResolvedTable = () =>
    downloadCsv("sites_after_mod3_resolve.csv", [
      [
        ...TEMPLATE_HEADERS,
        "OLD_PCI",
        "OLD_MOD3",
        "NEW_MOD3",
        "CHANGED",
        "MRBTS",
        "LNBTS",
        "LNCEL",
      ],
      ...resolvedCells.map((c, i) => {
        const old = cells[i];
        return [
          c.site,
          c.cellName,
          c.lon,
          c.lat,
          "",
          c.azimuth,
          `${c.site}_${c.band}`,
          c.band,
          c.pci,
          "",
          old?.pci ?? c.pci,
          old?.mod3 ?? c.mod3,
          c.mod3,
          old && old.pci !== c.pci ? "YES" : "NO",
          c.mrbts,
          c.lnbts,
          c.lncel,
        ];
      }),
    ]);

  /**
   * KML export for Google Earth: sector polygons with the resolved PCIs plus the
   * clash links exactly as drawn on the map (own colours/width), and a second
   * folder with the links that remain after the re-plan.
   */
  const exportKml = () => {
    // KML colours are AABBGGRR (alpha, blue, green, red) — the reverse of #RRGGBB.
    const kmlColor = (hex: string, alpha = "ff") =>
      `${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`;
    // Escape text that goes inside XML elements (numeric character references,
    // valid in XML 1.0 and unaffected by template-literal quirks).
    const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

    const kmlParts: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<kml xmlns="http://www.opengis.net/kml/2.2">',
      "  <Document>",
      "    <name>PCI Mod3 Clash Analysis</name>",
      `    <description>LTE sectors with resolved PCI/Mod3 (${resolvedCells.length} cells), the clash links detected on the map (${clashes.length} pairs) and the links remaining after the PCI re-plan (${resolvedClashes.length} pairs)</description>`,
    ];

    // One style per Mod3 value, matching the on-map sector colours.
    MOD3_COLORS.forEach((color, m) => {
      kmlParts.push(
        `    <Style id="mod3-${m}">`,
        `      <LineStyle><color>${kmlColor(color)}</color><width>2</width></LineStyle>`,
        `      <PolyStyle><color>${kmlColor(color, "99")}</color><fill>1</fill><outline>1</outline></PolyStyle>`,
        `    </Style>`,
      );
    });

    kmlParts.push("    <Folder>", `      <name>Sectors (${resolvedCells.length})</name>`);

    // Sector polygons — the resolved cells, coloured by (new) Mod3.
    resolvedCells.forEach((c) => {
      const poly = sectorPolygon(c.lat, c.lon, c.azimuth, beamwidth, sectorRadius);
      // KML expects lon,lat,alt.
      const coords = poly.map(([lat, lon]) => `${lon},${lat},0`).join(" ");
      kmlParts.push(
        `      <Placemark>`,
        `        <name>${esc(c.cellName)}</name>`,
        `        <description><![CDATA[Site: ${esc(c.site)}<br/>Band: ${esc(c.band)}<br/>PCI: ${c.pci}<br/>Mod3: ${c.mod3}<br/>Azimuth: ${c.azimuth}°]]></description>`,
        `        <ExtendedData>`,
        `          <Data name="Site"><value>${esc(c.site)}</value></Data>`,
        `          <Data name="Cell"><value>${esc(c.cellName)}</value></Data>`,
        `          <Data name="Band"><value>${esc(c.band)}</value></Data>`,
        `          <Data name="PCI"><value>${c.pci}</value></Data>`,
        `          <Data name="Mod3"><value>${c.mod3}</value></Data>`,
        `          <Data name="Azimuth"><value>${c.azimuth}</value></Data>`,
        `          <Data name="MRBTS"><value>${esc(c.mrbts)}</value></Data>`,
        `          <Data name="LNBTS"><value>${esc(c.lnbts)}</value></Data>`,
        `          <Data name="LNCEL"><value>${esc(c.lncel)}</value></Data>`,
        `        </ExtendedData>`,
        `        <styleUrl>#mod3-${c.mod3}</styleUrl>`,
        `        <Polygon>`,
        `          <tessellate>1</tessellate>`,
        `          <outerBoundaryIs>`,
        `            <LinearRing>`,
        `              <coordinates>${coords}</coordinates>`,
        `            </LinearRing>`,
        `          </outerBoundaryIs>`,
        `        </Polygon>`,
        `      </Placemark>`,
      );
    });

    kmlParts.push("    </Folder>");

    // One placemark per clash link. Inline <Style> so each link keeps the exact
    // colour/thickness it has on the map.
    const linkPlacemark = (clash: Clash, color: string) => {
      const pa = sectorCenter(clash.a, sectorRadius);
      const pb = sectorCenter(clash.b, sectorRadius);
      const coords = `${pa.lng},${pa.lat},0 ${pb.lng},${pb.lat},0`;
      return [
        `      <Placemark>`,
        `        <name>${esc(clash.a.cellName)} ↔ ${esc(clash.b.cellName)}</name>`,
        `        <description><![CDATA[<b>${esc(clash.a.cellName)}</b> (${esc(clash.a.site)}) PCI ${clash.a.pci} Mod3 ${clash.a.mod3}<br/><b>${esc(clash.b.cellName)}</b> (${esc(clash.b.site)}) PCI ${clash.b.pci} Mod3 ${clash.b.mod3}<br/>Distance: ${Math.round(clash.distanceM)} m<br/>Type: ${clash.type === "pci" ? "Same PCI" : "Mod3 clash"}${clash.manual ? "<br/>Manually added link" : ""}<br/>Reason: ${esc(clash.reason)}]]></description>`,
        `        <Style>`,
        `          <LineStyle><color>${kmlColor(color)}</color><width>${linkWidth}</width></LineStyle>`,
        `        </Style>`,
        `        <LineString>`,
        `          <tessellate>1</tessellate>`,
        `          <coordinates>${coords}</coordinates>`,
        `        </LineString>`,
        `      </Placemark>`,
      ];
    };

    // Folder 1 — the clash links exactly as drawn on the map right now
    // (same colours, same width, manual links included, deleted links excluded).
    kmlParts.push("    <Folder>", `      <name>Clash links on map (${clashes.length})</name>`);
    clashes.forEach((clash) => {
      const key = pairKey(clash.a.id, clash.b.id);
      const stroke = linkColors[key] ?? linkColor ?? (clash.manual ? "#38bdf8" : "#ef4444");
      kmlParts.push(...linkPlacemark(clash, stroke));
    });
    kmlParts.push("    </Folder>");

    // Folder 2 — what still clashes after the PCI re-plan (toggle off in Google
    // Earth when only the before picture is needed).
    kmlParts.push(
      "    <Folder>",
      `      <name>Clash links remaining after solve (${resolvedClashes.length})</name>`,
    );
    resolvedClashes.forEach((clash) => {
      kmlParts.push(...linkPlacemark(clash, "#ef4444"));
    });
    kmlParts.push("    </Folder>", "  </Document>", "</kml>");
    const kml = kmlParts.join("\n");
    const url = URL.createObjectURL(
      new Blob([kml], { type: "application/vnd.google-earth.kml+xml" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "mod3_clash_analysis.kml";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="bg-background text-foreground">
      <header className="hero-surface shrink-0 border-b border-border/80 bg-background px-6 py-4 shadow-md">
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30">
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <circle cx="12" cy="12" r="2.2" />
              <path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 16.5a6.4 6.4 0 0 0 0-9M4.5 4.5a10.6 10.6 0 0 0 0 15M19.5 19.5a10.6 10.6 0 0 0 0-15" />
            </svg>
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">LTE PCI Mod3 Clash Analyzer</h1>
            <p className="text-sm text-muted-foreground">
              Sectors mapped from your site table — Mod3 conflicts highlighted and re-planned.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/60 px-3 py-1">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              {cells.length} cells in scope
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-destructive">
              {clashes.length} clash pairs
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={toggleTheme}
              aria-pressed={theme === "dark"}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              className="min-h-9 gap-2"
            >
              <span aria-hidden="true">{theme === "dark" ? "☾" : "☀"}</span>
              {theme === "dark" ? "Dark" : "Light"}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="grid gap-6 p-6 lg:grid-cols-[380px_1fr]">
          <section className="space-y-5">
            <Step n={1} title="Load your site table">
              <div className="space-y-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept={TABLE_ACCEPT}
                  className="sr-only"
                  aria-label="Upload a site table file"
                  onChange={(e) => {
                    void handleUpload(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />

                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => fileRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      fileRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    void handleUpload(e.dataTransfer.files?.[0]);
                  }}
                  className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
                    dragging
                      ? "border-primary bg-primary/10"
                      : "border-border bg-surface-2/40 hover:border-primary/60 hover:bg-primary/5"
                  }`}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-primary">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4.5 w-4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    >
                      <path d="M12 16V4m0 0L8 8m4-4 4 4" />
                      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                    </svg>
                  </span>
                  <span className="text-sm font-medium">
                    Drop your file here or click to browse
                  </span>
                  <span className="text-xs text-muted-foreground">
                    CSV · TSV · XLSX with a header row
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={downloadTemplate}>
                    Download template
                  </Button>
                  
                  <Button variant="ghost" size="sm" onClick={() => setRaw(SAMPLE_CSV)}>
                    Load sample
                  </Button>
                  {raw.trim() && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto text-destructive hover:text-destructive"
                      onClick={() => {
                        setRaw("");
                        setParsedUpload(null);
                        setFileName(null);
                        setFileError(null);
                      }}
                    >
                      Clear
                    </Button>
                  )}
                </div>

                <details open className="group rounded-lg border border-border bg-surface-2/30">
                  <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                    <span className="inline-block transition-transform group-open:rotate-90">
                      ›
                    </span>{" "}
                    Or paste the table manually
                  </summary>
                  <div className="space-y-2 px-3 pb-3">
                    <Label htmlFor="data" className="sr-only">
                      Paste CSV / TSV data
                    </Label>
                    <Textarea
                      id="data"
                      value={raw}
                      onChange={(e) => setRaw(e.target.value)}
                      spellCheck={false}
                      aria-describedby="data-help"
                      className="h-40 font-mono text-xs"
                      placeholder={PLACEHOLDER_TABLE}
                    />
                  </div>
                </details>

                <p id="data-help" className="text-xs leading-relaxed text-muted-foreground">
                  Detected columns: NAME / site, TX_ID / cell, LONGITUDE, LATITUDE, AZIMUT, Cell
                  Layer (band) and PHY_CELL_ID (PCI) — any extra columns are ignored.
                </p>
                <p aria-live="polite" className="text-xs">
                  {fileError ? (
                    <span className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-destructive">
                      {fileError}
                    </span>
                  ) : allCells.length ? (
                    <span className="flex items-center gap-1.5 rounded-md border border-success/40 bg-success/10 px-2.5 py-1.5 text-foreground">
                      <span className="h-1.5 w-1.5 rounded-full bg-success" />
                      {fileName ? `${fileName} · ` : ""}
                      {allCells.length} cells parsed
                    </span>
                  ) : null}
                </p>

                {errorPanel && (
                  <div
                    role="alert"
                    className="space-y-1.5 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-destructive">{errorPanel.title}</p>
                      <button
                        type="button"
                        aria-label="Dismiss error"
                        className="text-destructive/70 hover:text-destructive"
                        onClick={() => setErrorPanel(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="font-mono break-words text-destructive">{errorPanel.detail}</p>
                    <p className="text-muted-foreground">
                      <span className="font-medium text-foreground">How to fix: </span>
                      {errorPanel.hint}
                    </p>
                    {errorPanel.trace && (
                      <Collapsible open={errorOpen} onOpenChange={setErrorOpen}>
                        <div className="flex items-center gap-2">
                          <CollapsibleTrigger className="inline-flex items-center gap-1 text-[11px] font-medium text-destructive underline-offset-2 hover:underline">
                            <ChevronDown
                              className={`h-3 w-3 transition-transform ${errorOpen ? "rotate-180" : ""}`}
                            />
                            {errorOpen ? "Hide technical details" : "Show technical details"}
                          </CollapsibleTrigger>
                          <button
                            type="button"
                            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                            onClick={() => navigator.clipboard?.writeText(errorPanel.trace ?? "")}
                          >
                            Copy
                          </button>
                        </div>
                        <CollapsibleContent>
                          <pre className="mt-1.5 max-h-56 overflow-auto rounded-md border border-destructive/30 bg-background/70 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                            {errorPanel.trace}
                          </pre>
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                  </div>
                )}
              </div>
            </Step>

            <Step n={2} title="Choose the scope">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="band">Band / layer</Label>
                  <select
                    id="band"
                    value={band}
                    onChange={(e) => setBand(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="all">All bands ({bands.length})</option>
                    {bands.map((b) => (
                      <option key={b} value={b}>
                        {b} ({allCells.filter((c) => c.band === b).length} cells)
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sites">Site group filter</Label>
                  <Input
                    id="sites"
                    value={siteFilter}
                    onChange={(e) => setSiteFilter(e.target.value)}
                    placeholder="e.g. CAI001, CAI002 — blank = all sites"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Draw an analysis area</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {(["polygon", "rectangle", "circle"] as const).map((s) => (
                      <Button
                        key={s}
                        size="sm"
                        variant={drawShape === s ? "default" : "outline"}
                        onClick={() => setDrawShape(drawShape === s ? null : s)}
                      >
                        {s === "polygon"
                          ? "Pen / polygon"
                          : s === "rectangle"
                            ? "Square"
                            : "Circle"}
                      </Button>
                    ))}
                    {selectionPath && (
                      <Button size="sm" variant="ghost" onClick={() => setSelectionPath(null)}>
                        Clear area
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="showoutside"
                      checked={showOutside}
                      onCheckedChange={setShowOutside}
                    />
                    <Label htmlFor="showoutside" className="text-xs font-normal">
                      Keep sites outside the area visible on the map
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {selectionPath
                      ? `Area active — only the ${cells.length} cells inside are analysed.`
                      : drawShape === "polygon"
                        ? "Click to drop points, then click the first point again, double-click, or press Enter to close. Backspace undoes a point, Esc cancels."
                        : "Draw a closed shape on the map; everything outside it is excluded from the Mod3 analysis."}
                  </p>
                </div>
              </div>
            </Step>

            <Step n={3} title="Tune the detection">
              <div className="space-y-4">
                <Control
                  label="Neighbour search radius"
                  value={`${radius} m`}
                  min={100}
                  max={10000}
                  step={50}
                  v={radius}
                  onChange={setRadius}
                />
                <Control
                  label="Sector beamwidth"
                  value={`${beamwidth}°`}
                  min={20}
                  max={120}
                  step={5}
                  v={beamwidth}
                  onChange={setBeamwidth}
                />
                <Control
                  label="Sector draw length"
                  value={`${sectorRadius} m`}
                  min={50}
                  max={1000}
                  step={10}
                  v={sectorRadius}
                  onChange={setSectorRadius}
                />
                <Control
                  label="Clash line thickness"
                  value={`${linkWidth} px`}
                  min={1}
                  max={10}
                  step={1}
                  v={linkWidth}
                  onChange={setLinkWidth}
                />
                <Control
                  label="Clash sector glow"
                  value={`${glow}%`}
                  min={0}
                  max={200}
                  step={10}
                  v={glow}
                  onChange={setGlow}
                />

                <div className="space-y-2 rounded-lg border border-border bg-surface-2/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="link-style" className="text-sm font-normal">
                      Clash line style
                    </Label>
                    <select
                      id="link-style"
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                      value={linkStyle}
                      onChange={(e) => setLinkStyle(e.target.value as typeof linkStyle)}
                    >
                      <option value="solid">Solid</option>
                      <option value="dashed">Dashed</option>
                      <option value="dotted">Dotted</option>
                    </select>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="link-color" className="text-sm font-normal">
                      Clash line colour
                    </Label>
                    <div className="flex items-center gap-1.5">
                      <input
                        id="link-color"
                        type="color"
                        className="h-8 w-10 cursor-pointer rounded-md border border-input bg-background p-1"
                        value={linkColor}
                        onChange={(e) => {
                          setLinkColor(e.target.value);
                          setLinkColors({});
                        }}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2 text-xs"
                        onClick={() => {
                          setLinkColor("#000000");
                          setLinkColors({});
                        }}
                      >
                        Reset
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Sets every link at once. Click a single line on the map to recolour just that
                    link.
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="facing" className="text-sm font-normal">
                    Only sectors that interfere
                    <span className="block text-xs text-muted-foreground">
                      Facing sectors and any beams overlapping the same area
                    </span>
                  </Label>
                  <Switch id="facing" checked={facingOnly} onCheckedChange={setFacingOnly} />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="sameband" className="text-sm font-normal">
                    Compare only cells on the same band
                  </Label>
                  <Switch id="sameband" checked={sameBandOnly} onCheckedChange={setSameBandOnly} />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="samesite" className="text-sm font-normal">
                    Ignore cells of the same site
                    <span className="block text-xs text-muted-foreground">
                      Sectors on one physical site never count as a clash
                    </span>
                  </Label>
                  <Switch
                    id="samesite"
                    checked={ignoreSameSite}
                    onCheckedChange={setIgnoreSameSite}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="clashedonly" className="text-sm font-normal">
                    Show only cells with a Mod3 clash
                  </Label>
                  <Switch id="clashedonly" checked={clashedOnly} onCheckedChange={setClashedOnly} />
                </div>
              </div>
            </Step>

            <div className="flex flex-wrap gap-3 text-xs">
              {[0, 1, 2].map((m) => (
                <span key={m} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 rounded-sm"
                    style={{ background: MOD3_COLORS[m] }}
                  />
                  Mod3 = {m}
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-3 w-3 rounded-sm"
                  style={{ background: MOD3_COLORS[0], boxShadow: `0 0 8px 3px ${MOD3_COLORS[0]}` }}
                />
                Clashed (bigger + glowing)
              </span>
            </div>

            {errors.length > 0 && (
              <ul
                aria-live="polite"
                className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
              >
                {errors.slice(0, 6).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-4">
            <div
              className="flex flex-wrap gap-3 text-sm"
              role="group"
              aria-label="Analysis summary"
            >
              <Stat label="Cells" value={cells.length} />
              <Stat label="Clash pairs" value={clashes.length} />
              <Stat label="Same-PCI pairs" value={clashes.filter((c) => c.type === "pci").length} />
              <Stat label="Sectors to re-plan" value={suggestions.length} />
              <Stat label="3-way+ groups" value={groups.length} />
            </div>

            <div className="panel space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    4
                  </span>
                  <h2 className="text-sm font-semibold tracking-tight">
                    Explore the map &amp; link sectors
                  </h2>
                </div>
                {(addedPairs.length > 0 || removedPairs.length > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {addedPairs.length > 0 && (
                      <Badge variant="secondary">+{addedPairs.length} linked</Badge>
                    )}
                    {removedPairs.length > 0 && (
                      <Badge variant="secondary">−{removedPairs.length} unlinked</Badge>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => {
                        setAddedPairs([]);
                        setRemovedPairs([]);
                      }}
                    >
                      Reset links
                    </Button>
                  </div>
                )}
              </div>

              <div className="flex min-h-[44px] flex-wrap items-center gap-2">
                <MapSearch id="map-search" onSearch={findAndFocus} />

                <div className="flex items-center gap-2">
                  <label htmlFor="map-view" className="text-xs text-muted-foreground">
                    Map view
                  </label>
                  <select
                    id="map-view"
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    value={mapType}
                    onChange={(e) => setMapType(e.target.value)}
                  >
                    {MAP_VIEWS.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex min-h-[34px] items-center">
                <p className="w-full rounded-lg border border-transparent px-3 py-1.5 text-xs text-muted-foreground">
                  {linkMode
                    ? "Link mode active — use the floating panel on the top-right of the map."
                    : "Hover a link line for details · click it to delete (deleted links leave the analysis)."}
                </p>
              </div>
            </div>

            <div
              className={
                mapFull
                  ? "fixed inset-0 z-[70] bg-background p-2"
                  : "panel relative h-[520px] overflow-hidden"
              }
            >
              <div className={mapFull ? "panel relative h-full overflow-hidden" : "h-full w-full"}>
                <Button
                  size="sm"
                  variant="secondary"
                  className="absolute right-3 top-3 z-[1000] h-8 gap-1.5 shadow-md"
                  onClick={() => setMapFull((v) => !v)}
                >
                  {mapFull ? "Exit full screen (Esc)" : "Full screen map"}
                </Button>

                {/* Floating "link sectors" panel over the top-right of the map */}
                <div className="absolute right-3 top-14 z-[1000] flex w-[248px] flex-col gap-1.5 rounded-xl border border-border bg-background/95 p-2 shadow-lg backdrop-blur-sm">
                  <Button
                    size="sm"
                    variant={linkMode ? "default" : "outline"}
                    className="w-full justify-start gap-1.5"
                    aria-pressed={linkMode}
                    onClick={() => {
                      setLinkMode((v) => !v);
                      setSelectedIds([]);
                    }}
                  >
                    <Link2 className="h-3.5 w-3.5 shrink-0" />
                    {linkMode ? "Selecting sectors…" : "Link sectors manually"}
                  </Button>

                  {linkMode && (
                    <>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          className="flex-1"
                          onClick={commitLinks}
                          disabled={selectedIds.length < 2}
                        >
                          Link sectors
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1"
                          onClick={() => setSelectedIds([])}
                          disabled={!selectedIds.length}
                        >
                          <X className="h-3.5 w-3.5" />
                          Clear
                        </Button>
                      </div>
                      <div
                        role="status"
                        aria-live="polite"
                        className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-primary"
                      >
                        <span className="relative flex h-1.5 w-1.5 shrink-0">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                        </span>
                        <span className="flex-1 leading-tight">
                          {selectedIds.length === 0
                            ? "Click sectors to select"
                            : selectedIds.length === 1
                              ? "1 selected — pick another"
                              : `${selectedIds.length} selected — ready to link`}
                        </span>
                        <span className="font-mono text-xs font-semibold">
                          {selectedIds.length}
                        </span>
                      </div>
                    </>
                  )}
                </div>

                <ClientOnly fallback={<div className="h-full w-full bg-muted" />}>
                  <Suspense fallback={<div className="h-full w-full bg-muted" />}>
                    <ClashMap
                      cells={mapCells}
                      clashes={clashes}
                      beamwidth={dBeamwidth}
                      sectorRadius={dSectorRadius}
                      linkMode={linkMode}
                      selectedIds={selectedIds}
                      onSectorClick={handleSectorClick}
                      onDeleteLink={handleDeleteLink}
                      theme={theme}
                      mapType={mapType}
                      focusId={focusId}
                      drawShape={drawShape}
                      selectionPath={selectionPath}
                      onSelectionDrawn={(p) => {
                        setSelectionPath(p);
                        setDrawShape(null);
                      }}
                      degrees={degrees}
                      linkWidth={linkWidth}
                      glow={glow}
                      linkStyle={linkStyle}
                      linkColor={linkColor}
                      linkColors={linkColors}
                      onSetLinkColor={(k, color) => setLinkColors((m) => ({ ...m, [k]: color }))}
                    />
                  </Suspense>
                </ClientOnly>
              </div>
            </div>

            {selectionPath && selectionPath.length > 2 && (
              <details className="panel space-y-3 border-l-4 border-l-primary p-4">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
                    Drawn area
                  </span>
                  <h2 className="text-base font-semibold tracking-tight">
                    Sites &amp; cells inside the drawn area
                  </h2>
                  <Badge variant="secondary">{new Set(cells.map((c) => c.lnbts)).size} sites</Badge>
                  <Badge variant="secondary">{cells.length} cells</Badge>
                </summary>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={exportAreaCells}
                    disabled={!cells.length}
                  >
                    Export cells CSV
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Click a row to centre the map on it.
                  </span>
                </div>
                <div
                  className="mt-3 max-h-[420px] overflow-auto rounded-md border border-border focus-visible:ring-2 focus-visible:ring-ring"
                  tabIndex={0}
                  role="region"
                  aria-label="Scrollable table of cells inside the drawn area"
                >
                  <table className="w-full text-sm" aria-label="Cells inside the drawn area">
                    <caption className="sr-only">
                      Cells located inside the drawn analysis area
                    </caption>
                    <thead className="sticky top-0 z-10 bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
                      <tr>
                        {["MRBTS", "LNBTS", "LNCEL", "Site", "Cell", "Band", "PCI", "Mod3"].map(
                          (h) => (
                            <th key={h} scope="col" className="px-3 py-2 text-left font-medium">
                              {h}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {cells.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                            No cells fall inside the drawn area.
                          </td>
                        </tr>
                      ) : (
                        cells.slice(0, AREA_ROW_LIMIT).map((c) => (
                          <tr
                            key={c.id}
                            className="cursor-pointer border-t border-border transition-colors hover:bg-surface-2/60"
                            onClick={() => setFocusId(c.id)}
                          >
                            <td className="px-3 py-2 font-mono">{c.mrbts}</td>
                            <td className="px-3 py-2 font-mono">{c.lnbts}</td>
                            <td className="px-3 py-2 font-mono">{c.lncel}</td>
                            <td className="px-3 py-2">{c.site}</td>
                            <td className="px-3 py-2">{c.cellName}</td>
                            <td className="px-3 py-2">{c.band}</td>
                            <td className="px-3 py-2 font-mono">{c.pci}</td>
                            <td className="px-3 py-2 font-mono">{c.mod3}</td>
                          </tr>
                        ))
                      )}
                      {cells.length > AREA_ROW_LIMIT && (
                        <tr>
                          <td
                            colSpan={8}
                            className="px-3 py-3 text-center text-xs text-muted-foreground"
                          >
                            Showing first {AREA_ROW_LIMIT} of {cells.length} cells — export the CSV
                            for the full list.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </details>
            )}

            <details className="panel overflow-hidden">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-3 text-sm font-semibold tracking-tight">
                Detected Mod3 clash pairs
                <Badge variant="secondary">{clashes.length}</Badge>
              </summary>
              <div
                className="max-h-[520px] overflow-auto border-t border-border focus-visible:ring-2 focus-visible:ring-ring"
                tabIndex={0}
                role="region"
                aria-label="Scrollable results table"
              >
                <table className="w-full text-sm" aria-label="Detected Mod3 clash pairs">
                  <caption className="sr-only">
                    Mod3 clash pairs between neighbouring cells — click a row to centre the map on
                    it
                  </caption>
                  <thead className="sticky top-0 z-10 bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
                    <tr>
                      <th scope="col" className="p-2 text-left">
                        Cell A
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Cell B
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Band
                      </th>
                      <th scope="col" className="p-2 text-left">
                        PCI
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Mod3
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Distance
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Relations
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Type
                      </th>
                      <th scope="col" className="p-2 text-right">
                        Link
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {clashes.length === 0 && (
                      <tr>
                        <td colSpan={9} className="p-4 text-center text-muted-foreground">
                          No Mod3 clashes found with the current settings.
                        </td>
                      </tr>
                    )}
                    {clashes.slice(0, 200).map((c, i) => {
                      const deg = Math.max(degrees[c.a.id] ?? 0, degrees[c.b.id] ?? 0);
                      const tone =
                        deg >= 4
                          ? "bg-destructive/15 hover:bg-destructive/25"
                          : deg === 3
                            ? "bg-warning/15 hover:bg-warning/25"
                            : "hover:bg-surface-2/50";
                      return (
                        <tr
                          key={i}
                          tabIndex={0}
                          onClick={() => setFocusId(c.a.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setFocusId(c.a.id);
                            }
                          }}
                          className={`cursor-pointer border-t border-border/70 transition-colors ${tone}`}
                        >
                          <td className="p-2">{c.a.cellName}</td>
                          <td className="p-2">{c.b.cellName}</td>
                          <td className="p-2">
                            {c.a.band === c.b.band ? c.a.band : `${c.a.band} / ${c.b.band}`}
                          </td>
                          <td className="p-2">
                            {c.a.pci} / {c.b.pci}
                          </td>
                          <td className="p-2">{c.a.mod3}</td>
                          <td className="p-2">{Math.round(c.distanceM)} m</td>
                          <td className="p-2 font-mono">{deg}</td>
                          <td className="p-2">
                            <Badge variant={c.type === "pci" ? "destructive" : "secondary"}>
                              {c.type === "pci" ? "Same PCI" : "Mod3"}
                              {c.manual ? " · manual" : ""}
                            </Badge>
                          </td>
                          <td className="p-2 text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteLink(pairKey(c.a.id, c.b.id));
                              }}
                            >
                              Delete link
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>

            <div className="space-y-2">
              <h2 className="text-base font-semibold tracking-tight">
                Step 5 · Suggested PCI re-plan
              </h2>
              <p className="text-xs text-muted-foreground">
                Existing same-site PCI rotations are preferred. When rotation cannot clear a clash,
                the solver assigns a safe PCI from 0–503 after checking every detected neighbour
                relation.
              </p>
              <div className="flex flex-wrap items-center gap-2 pb-1">
                <Button size="sm" onClick={exportPlan} disabled={!suggestions.length}>
                  PCI plan after resolve Mod3 clash CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportClashes}
                  disabled={!clashes.length}
                >
                  Clashes CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportGroups}
                  disabled={!groups.length}
                >
                  Groups CSV
                </Button>
                <Button variant="outline" size="sm" onClick={exportPdf} disabled={!clashes.length}>
                  Export PDF report
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportKml}
                  disabled={!resolvedCells.length}
                  title="Download the map data (sector polygons + clash links as drawn on the map, plus the links remaining after solve) as a KML file for Google Earth"
                >
                  Export KML (Google Earth)
                </Button>
              </div>

              <div
                className="panel max-h-[520px] overflow-auto focus-visible:ring-2 focus-visible:ring-ring"
                tabIndex={0}
                role="region"
                aria-label="Scrollable PCI re-plan table"
              >
                <table className="w-full text-sm" aria-label="Suggested PCI re-plan">
                  <caption className="sr-only">
                    Suggested PCI changes per sector to remove Mod3 clashes
                  </caption>
                  <thead className="sticky top-0 z-10 bg-surface-2 text-xs uppercase tracking-wide text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
                    <tr>
                      <th scope="col" className="p-2 text-left">
                        Site
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Sector
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Band
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Old PCI
                      </th>
                      <th scope="col" className="p-2 text-left text-destructive">
                        New PCI
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Mod3
                      </th>
                      <th scope="col" className="p-2 text-left">
                        Conflicts with
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestions.length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-4 text-center text-muted-foreground">
                          {clashes.length
                            ? "No lower-conflict PCI assignment is available with the current neighbour constraints."
                            : "Nothing to re-plan — no Mod3 clashes with the current settings."}
                        </td>
                      </tr>
                    )}
                    {suggestions.map((s) => (
                      <tr
                        key={s.cell.id}
                        tabIndex={0}
                        onClick={() => setFocusId(s.cell.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setFocusId(s.cell.id);
                          }
                        }}
                        className="cursor-pointer border-t border-border/70 transition-colors hover:bg-surface-2/50"
                      >
                        <th scope="row" className="p-2 text-left font-medium">
                          {s.cell.site}
                        </th>
                        <td className="p-2">{s.cell.cellName}</td>
                        <td className="p-2">{s.cell.band}</td>
                        <td className="p-2">{s.oldPci}</td>
                        <td className="p-2 font-semibold text-destructive">{s.newPci ?? "—"}</td>
                        <td className="p-2">
                          {s.oldMod3} → {s.newMod3 ?? "—"}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {s.conflictsWith.join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="space-y-2">
              <h2 className="text-base font-semibold tracking-tight">
                Step 6 · Map after Mod3 clash solve
              </h2>
              <p className="text-xs text-muted-foreground">
                The same sectors re-drawn with the new PCI / Mod3 from Step 5 — {changedCount}{" "}
                sector(s) changed, {resolvedClashes.length} clash pair(s) remaining (was{" "}
                {clashes.length}).
              </p>
              <MapSearch id="resolved-map-search" onSearch={findAndFocus} />

              <div
                className="flex flex-wrap gap-3 text-sm"
                role="group"
                aria-label="After-solve summary"
              >
                <Stat label="Clash pairs left" value={resolvedClashes.length} />
                <Stat label="3-way+ groups left" value={resolvedGroups.length} />
                <Stat label="PCIs changed" value={changedCount} />
              </div>

              <div className="flex flex-wrap gap-3 text-xs">
                {[0, 1, 2].map((m) => (
                  <span
                    key={m}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1"
                  >
                    <span
                      aria-hidden="true"
                      className="h-3 w-3 rounded-sm"
                      style={{ background: MOD3_COLORS[m] }}
                    />
                    Mod3 {m}: {mod3Dist.before[m]} → <strong>{mod3Dist.after[m]}</strong>
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={resolvedClashes.length ? "destructive" : "secondary"}>
                  {resolvedClashes.length
                    ? `${resolvedClashes.length} clash pair(s) remain after auto-solve`
                    : "No clashes left"}
                </Badge>
                <Button size="sm" onClick={exportResolvedTable} disabled={!resolvedCells.length}>
                  Download full file after Mod3 solve
                </Button>
                <span className="text-xs text-muted-foreground">
                  Same template columns as your uploaded data, for all {resolvedCells.length} cells
                  in scope, with PCI values rotated only within their original site.
                </span>
              </div>

              {resolvedClashes.length > 0 && (
                <Collapsible open={reasonsOpen} onOpenChange={setReasonsOpen}>
                  <CollapsibleTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5">
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${reasonsOpen ? "rotate-180" : ""}`}
                      />
                      Why can&apos;t these {resolvedClashes.length} be auto-fixed?
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-2">
                    <div className="panel max-h-64 space-y-2 overflow-y-auto p-3 text-xs">
                      <p className="text-muted-foreground">
                        The re-plan only rotates PCI values already used on the same site — it never
                        assigns a brand-new PCI. That&apos;s what keeps it safe, but it also means
                        some clashes structurally can&apos;t be cleared:
                      </p>
                      <ul className="space-y-1.5">
                        {unresolvedReasons.map(({ clash, reason }) => (
                          <li
                            key={pairKey(clash.a.id, clash.b.id)}
                            className="cursor-pointer rounded-md border border-border/70 p-2 hover:bg-surface-2/50"
                            onClick={() => setFocusId(clash.a.id)}
                          >
                            <span className="font-medium">
                              {clash.a.cellName} ↔ {clash.b.cellName}
                            </span>
                            <span className="ml-1 text-muted-foreground">— {reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}

              <div className="panel h-[520px] overflow-hidden">
                <ClientOnly fallback={<div className="h-full w-full bg-muted" />}>
                  <Suspense fallback={<div className="h-full w-full bg-muted" />}>
                    <ClashMap
                      cells={resolvedCells}
                      clashes={resolvedClashes}
                      beamwidth={dBeamwidth}
                      sectorRadius={dSectorRadius}
                      linkMode={false}
                      selectedIds={[]}
                      onSectorClick={() => {}}
                      onDeleteLink={handleDeleteLink}
                      theme={theme}
                      mapType={mapType}
                      focusId={focusId}
                      drawShape={null}
                      selectionPath={selectionPath}
                      onSelectionDrawn={() => {}}
                      degrees={resolvedDegrees}
                      linkWidth={linkWidth}
                      glow={glow}
                      linkStyle={linkStyle}
                      linkColor={linkColor}
                      linkColors={linkColors}
                    />
                  </Suspense>
                </ClientOnly>
              </div>
            </div>
          </section>
        </div>

        <footer className="mt-10 border-t border-border bg-surface-2/40">
          <div className="mx-auto grid max-w-6xl gap-6 px-6 py-10 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <h2 className="text-sm font-semibold tracking-tight">LTE PCI Mod3 Clash Analyzer</h2>
              <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                Map LTE sectors from your site table, detect PCI and Mod3 clashes between
                neighbouring cells, and export a ready-to-implement re-plan.
              </p>
            </div>
            <nav className="space-y-2 text-xs" aria-label="Workflow">
              <h2 className="text-sm font-semibold tracking-tight">Workflow</h2>
              <ul className="space-y-1 text-muted-foreground">
                <li>1 · Import or paste your site table</li>
                <li>2 · Tune detection thresholds</li>
                <li>3 · Draw an area &amp; review clashes</li>
                <li>4 · Export the solved PCI plan</li>
              </ul>
            </nav>
            <div className="space-y-3">
              <h2 className="text-sm font-semibold tracking-tight">Connect</h2>
              <nav className="flex gap-2" aria-label="Author links">
                {[
                  {
                    href: "https://portfolio-updated-tcsz.vercel.app/",
                    label: "Portfolio",
                    Icon: Globe,
                  },
                  {
                    href: "https://github.com/MohamedAshraf366?tab=repositories",
                    label: "GitHub",
                    Icon: Github,
                  },
                  {
                    href: "https://www.linkedin.com/in/mohamed-ashraf-497a13170",
                    label: "LinkedIn",
                    Icon: Linkedin,
                  },
                ].map(({ href, label, Icon }) => (
                  <a
                    key={label}
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                    href={href}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={label}
                    title={label}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </a>
                ))}
              </nav>
            </div>
          </div>
          <div className="border-t border-border/70 px-6 py-4 text-center text-xs text-muted-foreground">
            © {new Date().getFullYear()} All rights reserved to{" "}
            <span className="font-medium text-foreground">Mohamed Ashraf</span>
          </div>
        </footer>
      </div>

      {activeTask &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="status"
            aria-live="assertive"
            aria-busy="true"
            className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
          >
            <div className="flex w-[min(94vw,30rem)] flex-col items-center gap-4 rounded-2xl border border-border bg-surface-2 px-7 py-6 text-center shadow-2xl">
              <span className="relative flex h-12 w-12 items-center justify-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-primary/25" />
                <span className="h-10 w-10 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
                {activeTask.percent !== null && (
                  <span className="absolute font-mono text-[10px] font-semibold">
                    {activeTask.percent}%
                  </span>
                )}
              </span>
              <div className="space-y-1">
                <p className="text-sm font-semibold">{activeTask.label}…</p>
                {activeTask.detail && (
                  <p className="font-mono text-[11px] text-primary">{activeTask.detail}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {activeTask.etaSeconds != null
                    ? activeTask.etaSeconds <= 0.4
                      ? "Finishing now…"
                      : `Estimated time remaining: ${formatDuration(activeTask.etaSeconds)}`
                    : "Estimating time remaining…"}
                </p>
                {activeTask.rate && (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    Current throughput: {activeTask.rate}
                  </p>
                )}
              </div>

              <div className="w-full space-y-1.5">
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{activeTask.step === "exporting" ? "Exporting" : "Processing"}</span>
                  <span className="font-mono">
                    {activeTask.percent === null ? "working…" : `${activeTask.percent}%`}
                  </span>
                </div>
                <span className="relative block h-2.5 w-full overflow-hidden rounded-full bg-border">
                  {activeTask.percent === null ? (
                    <span className="block h-full w-1/3 animate-[loading-slide_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
                  ) : (
                    <span
                      className="block h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
                      style={{ width: `${Math.max(2, activeTask.percent)}%` }}
                    />
                  )}
                </span>
              </div>

              <ol className="w-full space-y-1 text-left text-xs">
                {STEPS.map((st) => {
                  const idx = STEPS.findIndex((x) => x.key === activeTask.step);
                  const i = STEPS.findIndex((x) => x.key === st.key);
                  const state = i < idx ? "done" : i === idx ? "active" : "todo";
                  return (
                    <li
                      key={st.key}
                      className={`flex items-center gap-2 ${
                        state === "active"
                          ? "font-medium text-foreground"
                          : state === "done"
                            ? "text-success"
                            : "text-muted-foreground/60"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          state === "active"
                            ? "animate-pulse bg-primary"
                            : state === "done"
                              ? "bg-success"
                              : "bg-border"
                        }`}
                      />
                      {st.label}
                      {state === "done" ? " ✓" : ""}
                    </li>
                  );
                })}
              </ol>

              <dl className="grid w-full grid-cols-2 gap-1.5 rounded-lg border border-border/70 bg-background/60 p-2.5 text-left text-[11px]">
                {[
                  ["Load", metrics.loadMs != null ? `${Math.round(metrics.loadMs)} ms` : "—"],
                  ["Parse", metrics.parseMs != null ? `${Math.round(metrics.parseMs)} ms` : "—"],
                  [
                    "Analyze",
                    metrics.analyzeMs != null ? `${Math.round(metrics.analyzeMs)} ms` : "—",
                  ],
                  ["Rows", metrics.rows != null ? metrics.rows.toLocaleString() : "—"],
                  [
                    "Cells",
                    metrics.cellsParsed != null ? metrics.cellsParsed.toLocaleString() : "—",
                  ],
                  [
                    "Compared",
                    metrics.pairsCompared != null ? metrics.pairsCompared.toLocaleString() : "—",
                  ],
                  [
                    "Skipped pairs",
                    metrics.comparisonsAvoided != null
                      ? metrics.comparisonsAvoided.toLocaleString()
                      : "—",
                  ],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-2">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-mono font-medium">{v}</dd>
                  </div>
                ))}
              </dl>

              <Button variant="outline" size="sm" onClick={cancelTask} className="w-full">
                Cancel
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </main>
  );
}

/** Search bar shown above every map: finds a site / cell and centres the map on it. */
const MapSearch = memo(function MapSearch({
  id,
  onSearch,
}: {
  id: string;
  onSearch: (q: string) => string | null;
}) {
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const run = () => setMsg(onSearch(q));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Label htmlFor={id} className="sr-only">
        Search a site by name
      </Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              run();
            }
          }}
          placeholder="Search site / cell name…"
          className="h-8 w-56 pl-8 text-xs"
        />
      </div>
      <Button size="sm" variant="outline" onClick={run}>
        Find on map
      </Button>
      {msg && (
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {msg}
        </span>
      )}
    </div>
  );
});

const nextFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const formatDuration = (seconds: number) => {
  const rounded = Math.max(1, Math.ceil(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  return `${minutes}m ${rounded % 60}s`;
};

const STEPS: { key: string; label: string }[] = [
  { key: "loading", label: "Loading file" },
  { key: "parsing", label: "Parsing rows" },
  { key: "computing", label: "Computing clashes" },
  { key: "exporting", label: "Exporting" },
];

const Step = memo(function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="panel space-y-3 p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
          {n}
        </span>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </div>
  );
});

const Stat = memo(function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="panel min-w-28 px-4 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-xl font-semibold text-primary">{value}</div>
    </div>
  );
});

const Control = memo(function Control({
  label,
  value,
  min,
  max,
  step,
  v,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  v: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>{label}</span>
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            min={min}
            max={max}
            step={step}
            value={v}
            aria-label={label}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
            }}
            className="h-7 w-20 px-2 py-0 text-right font-mono text-xs"
          />
          <span className="w-10 font-mono text-[11px] text-muted-foreground">
            {value.replace(/^[\d.-]+\s*/, "") || ""}
          </span>
        </div>
      </div>
      <Slider min={min} max={max} step={step} value={[v]} onValueChange={([n]) => onChange(n)} />
    </div>
  );
});
