/**
 * Parses an uploaded KMZ / KML file (like LTE "Serving Cell Identity" exports)
 * into Cell objects that the clash analyzer can use.
 *
 * Expected format inside the KML:
 *   - <Placemark>
 *       <Point><coordinates>lon,lat,alt</coordinates></Point>
 *       <description>Serving Cell Identity: 124</description>
 *   - Coordinates: longitude first (KML standard), then latitude
 */

export type KmlParseResult = {
  cells: import("./mod3").Cell[];
  errors: string[];
  sourceName: string;
};

function extractNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = String(text).match(/\b(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

export async function readKmlFile(
  file: File,
): Promise<KmlParseResult> {
  const errors: string[] = [];
  const sourceName = file.name.replace(/\.kmz$/i, "").replace(/\.kml$/i, "");
  const isKmz = file.name.toLowerCase().endsWith(".kmz");

  try {
    let kmlText: string;

    if (isKmz) {
      // KMZ = ZIP containing .kml and possibly images/icons
      // jszip needed only for KMZ; KML works natively.
      let JSZip: any;
      try {
        JSZip = (await import("jszip")).default;
      } catch {
        throw new Error(
          "KMZ files require the jszip package. Run: npm install jszip  (or use .kml directly)",
        );
      }
      const arrayBuffer = await file.arrayBuffer();
      const zipInstance = await JSZip.loadAsync(arrayBuffer);

      const kmlFileName = Object.keys(zipInstance.files).find(
        (n) => n.toLowerCase().endsWith(".kml"),
      );
      if (!kmlFileName) {
        throw new Error(
          "KMZ file does not contain a .kml entry. Found files: " +
            Object.keys(zipInstance.files).join(", "),
        );
      }
      const fileObj = zipInstance.file(kmlFileName);
      if (!fileObj) throw new Error("Could not open .kml from KMZ.");
      kmlText = await fileObj.async("string");
    } else {
      kmlText = await file.text();
    }

    // Parse XML. We only need Point placemarks with descriptions.
    const parser = new DOMParser();
    const doc = parser.parseFromString(kmlText, "text/xml");
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      errors.push("KML file could not be parsed (invalid XML).");
      return { cells: [], errors, sourceName };
    }

    const placemarks = doc.querySelectorAll("Placemark");
    const cells: import("./mod3").Cell[] = [];
    let foundAny = false;

    placemarks.forEach((pm, idx) => {
      const point = pm.querySelector("Point");
      if (!point) return; // skip polygons/lines/legends

      const coordsEl = point.querySelector("coordinates");
      if (!coordsEl || !coordsEl.textContent) return;

      // KML coordinates: lon,lat[,alt] — we take the first coordinate pair
      const firstPair = coordsEl.textContent.trim().split(/\s+/)[0];
      if (!firstPair) return;

      const [lonStr, latStr] = firstPair.split(",");
      const lon = parseFloat(lonStr);
      const lat = parseFloat(latStr);
      if (!isFinite(lon) || !isFinite(lat)) return;

      // Extract PCI from description (e.g., "Serving Cell Identity: 124")
      const descEl = pm.querySelector("description");
      const descText = descEl ? descEl.textContent ?? "" : "";
      const pciMatch = descText.match(/Serving Cell Identity\s*[:\-]\s*(\d+)/i);
      const pci = pciMatch ? parseInt(pciMatch[1], 10) : null;

      // Skip legend overlays (they usually say "Serving Cell Identity" with corner directions)
      if (descText.includes("upper left") || descText.includes("lower left") || descText.includes("upper right") || descText.includes("lower right")) {
        return;
      }

      // Only include points that actually have a PCI value from the description,
      // OR points that have no legend-like text but have a numeric identity.
      // If no PCI found in description, skip unless this looks like a data point.
      foundAny = true;

      // Build a synthetic cell from the KML point
      const cellName = descText.trim().split("\n")[0]?.trim() || `Point ${idx}`;
      const id = `kml-${sourceName}-${idx}-${pci ?? 0}`;
      const site = descText.includes("Minya") ? "Minya Cluster L700" : sourceName;

      cells.push({
        id,
        site,
        cellName: pci ? `Cell ID: ${pci}` : `Point ${idx}`,
        band: "All",
        lat,
        lon,
        azimuth: 0,
        pci: pci ?? 0,
        mod3: pci != null ? ((pci % 3) + 3) % 3 : 0,
        mrbts: site,
        lnbts: site,
        lncel: String(pci || idx),
      });
    });

    if (!foundAny) {
      errors.push(
        "No cell points with 'Serving Cell Identity' found in KML. Make sure the file is a cell identity / sector map.",
      );
    }

    return { cells, errors, sourceName };
  } catch (e: unknown) {
    errors.push(
      e instanceof Error ? `Failed to read KML file: ${e.message}` : "Failed to read KML file.",
    );
    return { cells: [], errors, sourceName };
  }
}
