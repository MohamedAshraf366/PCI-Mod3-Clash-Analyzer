"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Cell, Clash } from "@/lib/mod3";
import { MOD3_COLORS, pairKey, sectorCenter, sectorPolygon } from "@/lib/mod3";

export type DrawShape = "polygon" | "rectangle" | "circle" | null;

type Props = {
  cells: Cell[];
  clashes: Clash[];
  beamwidth: number;
  sectorRadius: number;
  linkMode?: boolean;
  selectedIds?: string[];
  onSectorClick?: (cell: Cell) => void;
  onDeleteLink?: (key: string) => void;
  theme?: "light" | "dark";
  /** One of the ids in MAP_VIEWS. */
  mapType?: string;
  /** Cell id to centre the map on. */
  focusId?: string | null;
  /** Active drawing tool for the selection shape. */
  drawShape?: DrawShape;
  /** Closed selection shape as [lat, lng] pairs. */
  selectionPath?: [number, number][] | null;
  onSelectionDrawn?: (path: [number, number][] | null) => void;
  /** Relations count per cell id, used to size the glow. */
  degrees?: Record<string, number>;
  /** Stroke width in px for clash link lines. */
  linkWidth?: number;
  /** Glow intensity for clashing sectors, in percent (0 = off, 100 = default). */
  glow?: number;
  /** Stroke pattern for clash link lines. */
  linkStyle?: "solid" | "dashed" | "dotted";
  /** Colour applied to every clash link line (unless overridden per link). */
  linkColor?: string | null;
  /** Per-link colour overrides, keyed by pairKey. */
  linkColors?: Record<string, string>;
  /** Called when a single link's colour is changed from its popup. */
  onSetLinkColor?: (key: string, color: string) => void;
};

/** Bing tile quadkey for x/y/zoom. */
function quadKey(x: number, y: number, z: number) {
  let key = "";
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if (x & mask) digit += 1;
    if (y & mask) digit += 2;
    key += digit;
  }
  return key;
}

type TileDef = { url: string; attribution: string; bing?: boolean };

/** Keyless raster tile sources — no Maps JavaScript API / billing account needed. */
const TILES: Record<string, TileDef> = {
  roadmap: { url: "https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", attribution: "Google" },
  satellite: { url: "https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", attribution: "Google" },
  hybrid: { url: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", attribution: "Google" },
  terrain: { url: "https://mt{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}", attribution: "Google" },
  bing_road: { url: "r", attribution: "Microsoft Bing", bing: true },
  bing_satellite: { url: "a", attribution: "Microsoft Bing", bing: true },
  bing_hybrid: { url: "h", attribution: "Microsoft Bing", bing: true },
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
  },
};

/** Bing layer built with a quadkey URL function. */
const BingLayer = L.TileLayer.extend({
  getTileUrl(coords: any) {
    const s = (coords.x + coords.y) % 4;
    return `https://ecn.t${s}.tiles.virtualearth.net/tiles/${(this as any).options.bingLayer}${quadKey(
      coords.x,
      coords.y,
      coords.z,
    )}.jpeg?g=1`;
  },
});

function makeTileLayer(mapType: string) {
  const def = TILES[mapType] ?? TILES.roadmap;
  if (def.bing) {
    return new (BingLayer as any)("", {
      bingLayer: def.url,
      maxZoom: 19,
      attribution: def.attribution,
    }) as L.TileLayer;
  }
  return L.tileLayer(def.url, {
    subdomains: def.url.includes("mt{s}") ? ["0", "1", "2", "3"] : ["a", "b", "c"],
    maxZoom: 20,
    attribution: def.attribution,
  });
}

const esc = (v: unknown) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

export default function ClashMap({
  cells,
  clashes,
  beamwidth,
  sectorRadius,
  linkMode = false,
  selectedIds = [],
  onSectorClick,
  onDeleteLink,
  theme = "dark",
  mapType = "roadmap",
  focusId = null,
  drawShape = null,
  selectionPath = null,
  onSelectionDrawn,
  degrees = {},
  linkWidth = 4,
  glow = 100,
  linkStyle = "solid",
  linkColor = "#000000",
  linkColors = {},
  onSetLinkColor,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const selectionRef = useRef<L.Polygon | null>(null);
  const deleteRef = useRef(onDeleteLink);
  const clickRef = useRef(onSectorClick);
  const drawnRef = useRef(onSelectionDrawn);
  const colorRef = useRef(onSetLinkColor);
  const fittedRef = useRef<string>("");
  const [ready, setReady] = useState(false);
  const [viewport, setViewport] = useState(0);

  deleteRef.current = onDeleteLink;
  clickRef.current = onSectorClick;
  drawnRef.current = onSelectionDrawn;
  colorRef.current = onSetLinkColor;

  // Init once (browser only).
  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = L.map(ref.current, {
      center: [30.0444, 31.2357],
      zoom: 14,
      zoomControl: true,
      doubleClickZoom: true,
      preferCanvas: true,
    });
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    map.on("moveend", () => setViewport((v) => v + 1));
    // Keep tiles correct when the container resizes (e.g. fullscreen toggle).
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(ref.current);
    setReady(true);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Base layer.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    tileRef.current?.remove();
    tileRef.current = makeTileLayer(mapType).addTo(mapRef.current);
    tileRef.current.setZIndex(0);
  }, [ready, mapType]);

  // Pan to a cell when a table row is clicked.
  useEffect(() => {
    if (!ready || !focusId || !mapRef.current) return;
    const c = cells.find((x) => x.id === focusId);
    if (!c) return;
    mapRef.current.setView([c.lat, c.lon], Math.max(mapRef.current.getZoom(), 16));
  }, [ready, focusId, cells]);

  // Click-to-draw selection tools.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const container = map.getContainer();
    if (!drawShape) {
      container.style.cursor = "";
      return;
    }
    container.style.cursor = "crosshair";
    map.doubleClickZoom.disable();

    let preview: L.Polygon | L.Polyline | null = null;
    let pts: L.LatLng[] = [];
    let vertices: L.CircleMarker[] = [];

    const hint = L.DomUtil.create("div", "", container);
    hint.style.cssText =
      "position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:1000;" +
      "background:rgba(17,24,39,.88);color:#fff;font-size:12px;line-height:1.35;padding:6px 10px;" +
      "border-radius:8px;pointer-events:none;text-align:center;max-width:92%";
    const setHint = () => {
      if (drawShape !== "polygon") {
        hint.textContent =
          drawShape === "rectangle"
            ? "Click two opposite corners · Esc to cancel"
            : "Click the centre, then a point on the edge · Esc to cancel";
        return;
      }
      hint.innerHTML =
        pts.length < 3
          ? `Click to add points (${pts.length}) · Esc cancels`
          : `${pts.length} points · <b>click the first point</b>, double-click or press <b>Enter</b> to close · Backspace undo · Esc cancel`;
    };
    setHint();

    const clearPreview = () => {
      preview?.remove();
      preview = null;
      vertices.forEach((v) => v.remove());
      vertices = [];
    };
    const finish = (path: [number, number][]) => {
      clearPreview();
      drawnRef.current?.(path);
    };
    const style = { color: "#facc15", weight: 2, fillColor: "#facc15", fillOpacity: 0.06 };

    const circlePath = (c: L.LatLng, r: number): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        out.push([
          c.lat + (r * Math.cos(a)) / 111320,
          c.lng + (r * Math.sin(a)) / (111320 * Math.cos((c.lat * Math.PI) / 180) || 1),
        ]);
      }
      return out;
    };
    const rectPath = (a: L.LatLng, b: L.LatLng): [number, number][] => [
      [Math.max(a.lat, b.lat), Math.min(a.lng, b.lng)],
      [Math.max(a.lat, b.lat), Math.max(a.lng, b.lng)],
      [Math.min(a.lat, b.lat), Math.max(a.lng, b.lng)],
      [Math.min(a.lat, b.lat), Math.min(a.lng, b.lng)],
    ];
    const drawPreview = (path: [number, number][], closed: boolean) => {
      if (!preview || preview instanceof L.Polygon !== closed) {
        preview?.remove();
        preview = (closed ? L.polygon(path, style) : L.polyline(path, style)) as any;
        preview!.addTo(map);
      } else preview.setLatLngs(path as any);
    };
    const syncVertices = () => {
      vertices.forEach((v) => v.remove());
      vertices = pts.map((p, i) =>
        L.circleMarker(p, {
          radius: i === 0 ? 6 : 4,
          color: "#facc15",
          weight: 2,
          fillColor: i === 0 ? "#facc15" : "#111827",
          fillOpacity: 1,
          interactive: false,
        }).addTo(map),
      );
    };
    /** True when the cursor is close enough to the first vertex to close the ring. */
    const nearFirst = (latlng: L.LatLng) =>
      pts.length >= 3 &&
      map.latLngToContainerPoint(latlng).distanceTo(map.latLngToContainerPoint(pts[0])) <= 14;

    const closeRing = () => {
      if (drawShape === "polygon" && pts.length >= 3) {
        const path = pts.map((p) => [p.lat, p.lng] as [number, number]);
        pts = [];
        finish(path);
      }
    };

    const onClick = (e: L.LeafletMouseEvent) => {
      if (drawShape === "polygon" && nearFirst(e.latlng)) {
        closeRing();
        return;
      }
      pts.push(e.latlng);
      if (drawShape === "polygon") {
        drawPreview(
          pts.map((p) => [p.lat, p.lng] as [number, number]),
          pts.length >= 3,
        );
        syncVertices();
        setHint();
      } else if (pts.length === 2) {
        if (drawShape === "rectangle") finish(rectPath(pts[0], pts[1]));
        else finish(circlePath(pts[0], pts[0].distanceTo(pts[1])));
        pts = [];
      }
    };
    const onMove = (e: L.LeafletMouseEvent) => {
      if (!pts.length) return;
      if (drawShape === "polygon") {
        const snap = nearFirst(e.latlng);
        container.style.cursor = snap ? "pointer" : "crosshair";
        const tip = snap ? pts[0] : e.latlng;
        drawPreview(
          [...pts, tip].map((p) => [p.lat, p.lng] as [number, number]),
          pts.length >= 2,
        );
      } else if (drawShape === "rectangle") drawPreview(rectPath(pts[0], e.latlng), true);
      else drawPreview(circlePath(pts[0], pts[0].distanceTo(e.latlng)), true);
    };
    const onDbl = () => closeRing();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        closeRing();
      } else if (ev.key === "Escape") {
        pts = [];
        clearPreview();
        setHint();
        drawnRef.current?.(null);
      } else if (ev.key === "Backspace" && pts.length) {
        ev.preventDefault();
        pts.pop();
        if (pts.length)
          drawPreview(
            pts.map((p) => [p.lat, p.lng] as [number, number]),
            pts.length >= 3,
          );
        else clearPreview();
        syncVertices();
        setHint();
      }
    };

    map.on("click", onClick);
    map.on("mousemove", onMove);
    map.on("dblclick", onDbl);
    window.addEventListener("keydown", onKey);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      map.off("dblclick", onDbl);
      window.removeEventListener("keydown", onKey);
      hint.remove();
      clearPreview();
      container.style.cursor = "";
      map.doubleClickZoom.enable();
    };
  }, [ready, drawShape]);

  // Persisted selection shape.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    selectionRef.current?.remove();
    selectionRef.current = null;
    if (!selectionPath?.length) return;
    selectionRef.current = L.polygon(selectionPath, {
      color: "#facc15",
      weight: 2,
      fillColor: "#facc15",
      fillOpacity: 0.05,
      interactive: false,
    }).addTo(mapRef.current);
  }, [ready, selectionPath]);

  // Sectors + clash links.
  useEffect(() => {
    const map = mapRef.current;
    const group = layerRef.current;
    if (!ready || !map || !group) return;

    group.clearLayers();
    if (!cells.length) return;

    const signature = cells.map((c) => c.id).join("|");
    const shouldFit = fittedRef.current !== signature;

    const VIRTUAL_THRESHOLD = 300;
    const view = map.getBounds();
    const virtualize = !shouldFit && cells.length > VIRTUAL_THRESHOLD;
    const visible = (lat: number, lng: number) => !virtualize || view.contains(L.latLng(lat, lng));
    const drawCells = virtualize ? cells.filter((c) => visible(c.lat, c.lon)) : cells;

    const clashed = new Set<string>();
    clashes.forEach((c) => {
      clashed.add(c.a.id);
      clashed.add(c.b.id);
    });

    const bounds = L.latLngBounds([]);

    drawCells.forEach((c) => {
      const color = MOD3_COLORS[c.mod3];
      const isClash = clashed.has(c.id);
      const isSelected = selectedIds.includes(c.id);
      const scale = isClash ? 1.35 : 1;

      const g = glow / 100;
      if (isClash && g > 0) {
        L.polygon(
          sectorPolygon(
            c.lat,
            c.lon,
            c.azimuth,
            beamwidth + 12 * g,
            sectorRadius * scale * (1 + 0.18 * g),
          ),
          {
            color,
            opacity: 0.35 * g,
            weight: 10 * g,
            fillColor: color,
            fillOpacity: 0.12 * g,
            interactive: false,
          },
        ).addTo(group);
      }

      const poly = L.polygon(
        sectorPolygon(c.lat, c.lon, c.azimuth, beamwidth, sectorRadius * scale),
        {
          color: isSelected ? "#facc15" : color,
          weight: isSelected ? 4 : isClash ? 3.5 : 2.5,
          opacity: 1,
          fillColor: color,
          fillOpacity: isClash ? 0.75 : 0.5,
        },
      ).addTo(group);

      poly.on("click", (e: L.LeafletMouseEvent) => {
        if (drawShape) return;
        if (linkMode) {
          L.DomEvent.stop(e);
          clickRef.current?.(c);
          return;
        }
        L.popup()
          .setLatLng(e.latlng)
          .setContent(
            `<b>${esc(c.cellName)}</b><br/>${esc(c.site)} · ${esc(c.band)} · PCI ${esc(c.pci)} · Mod3 ${c.mod3}<br/>Az ${c.azimuth}°${
              isClash
                ? `<br/><span style="color:#dc2626">Mod3 clash · ${degrees[c.id] ?? 0} relation(s)</span>`
                : ""
            }`,
          )
          .openOn(map);
      });

      L.circle([c.lat, c.lon], {
        radius: Math.max(9, sectorRadius * 0.04),
        color: theme === "dark" ? "#f8fafc" : "#0f172a",
        weight: 2,
        fillColor: theme === "dark" ? "#0f172a" : "#f8fafc",
        fillOpacity: 1,
        interactive: false,
      }).addTo(group);

      bounds.extend([c.lat, c.lon]);
    });

    const drawClashes = virtualize
      ? clashes.filter((c) => visible(c.a.lat, c.a.lon) || visible(c.b.lat, c.b.lon))
      : clashes;

    const dashFor = (w: number) =>
      linkStyle === "solid"
        ? undefined
        : linkStyle === "dotted"
          ? `1 ${Math.max(3, w * 2.2)}`
          : `${Math.max(5, w * 3)} ${Math.max(5, w * 3)}`;

    drawClashes.forEach((c) => {
      const key = pairKey(c.a.id, c.b.id);
      const stroke = linkColors[key] ?? linkColor ?? (c.manual ? "#38bdf8" : "#ef4444");
      const pa = sectorCenter(c.a, sectorRadius);
      const pb = sectorCenter(c.b, sectorRadius);
      const line = L.polyline(
        [
          [pa.lat, pa.lng],
          [pb.lat, pb.lng],
        ],
        {
          color: stroke,
          weight: linkWidth,
          dashArray: dashFor(linkWidth),
          lineCap: linkStyle === "dotted" ? "round" : "butt",
        },
      ).addTo(group);

      const html = `<b>${esc(c.a.cellName)}</b> (${esc(c.a.site)} · PCI ${esc(c.a.pci)}, Mod3 ${c.a.mod3})<br/>
        <b>${esc(c.b.cellName)}</b> (${esc(c.b.site)} · PCI ${esc(c.b.pci)}, Mod3 ${c.b.mod3})<br/>
        ${esc(c.a.band === c.b.band ? c.a.band : `${c.a.band} / ${c.b.band}`)} · ${Math.round(c.distanceM)} m · ${
          c.type === "pci" ? "Same PCI" : "Mod3 clash"
        }<br/>
        <span style="opacity:.75">Why: ${esc(c.reason)}</span>${
          c.groupMembers && c.groupMembers.length > 2
            ? `<br/><span style="color:#d97706">Multi-sector overlap group (${c.groupMembers.length}): ${esc(c.groupMembers.join(", "))}</span>`
            : ""
        }
        <div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <label style="font-size:11px;display:flex;align-items:center;gap:4px">Line colour
            <input data-link-color type="color" value="${esc(stroke)}" style="width:26px;height:20px;padding:0;border:none;background:transparent;cursor:pointer" />
          </label>
          <button data-del-link style="font-size:11px;padding:3px 8px;border:1px solid #dc2626;color:#dc2626;border-radius:4px;background:transparent;cursor:pointer">Delete this link</button>
        </div>`;

      line.bindPopup(html);
      line.on("popupopen", (e: any) => {
        const el = e.popup.getElement();
        const btn = el?.querySelector("[data-del-link]") as HTMLButtonElement | null;
        btn?.addEventListener("click", () => {
          deleteRef.current?.(key);
          map.closePopup();
        });
        const picker = el?.querySelector("[data-link-color]") as HTMLInputElement | null;
        picker?.addEventListener("input", () => {
          line.setStyle({ color: picker.value });
        });
        picker?.addEventListener("change", () => colorRef.current?.(key, picker.value));
      });
      line.on("mouseover", () => line.openPopup());
    });

    if (shouldFit && bounds.isValid()) {
      fittedRef.current = signature;
      if (cells.length === 1) map.setView(bounds.getCenter(), 16);
      else {
        // Fit the main cluster: ignore stray rows far from the median position,
        // otherwise a single bad coordinate zooms the map out to the whole globe.
        const lats = drawCells.map((c) => c.lat).sort((a, b) => a - b);
        const lons = drawCells.map((c) => c.lon).sort((a, b) => a - b);
        const q = (arr: number[], p: number) =>
          arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
        const [latLo, latHi] = [q(lats, 0.02), q(lats, 0.98)];
        const [lonLo, lonHi] = [q(lons, 0.02), q(lons, 0.98)];
        const padLat = Math.max(0.01, (latHi - latLo) * 0.25);
        const padLon = Math.max(0.01, (lonHi - lonLo) * 0.25);
        const core = L.latLngBounds(
          [latLo - padLat, lonLo - padLon],
          [latHi + padLat, lonHi + padLon],
        );
        map.fitBounds(core.isValid() ? core : bounds, { padding: [48, 48] });
      }
    }
  }, [
    ready,
    cells,
    clashes,
    beamwidth,
    sectorRadius,
    linkMode,
    selectedIds,
    viewport,
    theme,
    degrees,
    drawShape,
    linkWidth,
    glow,
    linkStyle,
    linkColor,
    linkColors,
  ]);

  return (
    <div ref={ref} role="application" aria-label="Sector clash map" className="h-full w-full" />
  );
}
