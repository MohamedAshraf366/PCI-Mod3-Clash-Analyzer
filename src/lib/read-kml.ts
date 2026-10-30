/**
 * Fast regex parser for large LTE KML/KMZ files.
 * Instead of DOMParser (slow for 6,000+ placemarks), scans text directly.
 * Handles HTML descriptions (<table>...<td>Serving Cell Identity:</td><td>357</td>)
 */
export type KmlParseResult = {
  cells: import("./mod3").Cell[];
  errors: string[];
  sourceName: string;
};

export async function readKmlFile(file: File): Promise<KmlParseResult> {
  const errors: string[] = [];
  const sourceName = file.name.replace(/\.kmz$/i, "").replace(/\.kml$/i, "");
  const isKmz = file.name.toLowerCase().endsWith(".kmz");

  try {
    let kmlText: string;
    if (isKmz) {
      let JSZip: any;
      try {
        JSZip = (await import("jszip")).default;
      } catch {
        throw new Error("KMZ files require jszip. Run: npm install jszip (or use .kml directly)");
      }
      const arrayBuffer = await file.arrayBuffer();
      const zipInstance = await JSZip.loadAsync(arrayBuffer);
      const kmlFileName = Object.keys(zipInstance.files).find((n) =>
        n.toLowerCase().endsWith(".kml"),
      );
      if (!kmlFileName) throw new Error("KMZ has no .kml entry: " + Object.keys(zipInstance.files).join(", "));
      const fileObj = zipInstance.file(kmlFileName);
      if (!fileObj) throw new Error("Could not open .kml from KMZ.");
      kmlText = await fileObj.async("string");
    } else {
      kmlText = await file.text();
    }

    const cells: import("./mod3").Cell[] = [];
    // Fast scan: find all Point blocks with coordinates + descriptions
    // We use a single-pass regex to extract coordinate + description pairs
    const pointRegex = /<Placemark[^>]*>[\s\S]*?<Point>[\s\S]*?<coordinates>([^<]+)<\/coordinates>[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/Placemark>/gi;

    let match: RegExpExecArray | null;
    let idx = 0;
    while ((match = pointRegex.exec(kmlText)) !== null) {
      idx++;
      const coordStr = match[1].trim();
      const descRaw = match[2];

      // Skip legend overlays (corner text)
      const descLower = descRaw.toLowerCase();
      if (descLower.includes("upper left") || descLower.includes("lower left") ||
          descLower.includes("upper right") || descLower.includes("lower right")) continue;

      // Extract first coordinate pair: lon,lat[,alt]
      const firstPair = coordStr.split(/\s+/)[0];
      const [lonStr, latStr] = firstPair.split(",");
      const lon = parseFloat(lonStr);
      const lat = parseFloat(latStr);
      if (!isFinite(lon) || !isFinite(lat)) continue;

      // Extract PCI: strip HTML tags, find number near "Serving Cell Identity"
      const descPlain = descRaw.replace(/<[^>]+>/g, " ");
      const pciMatch = descPlain.match(/Serving Cell Identity[:\-]?\s*(\d+)/i);
      const pci = pciMatch ? parseInt(pciMatch[1], 10) : null;

      // We accept points with PCI; if no PCI found but point is not a legend, still include with 0
      const site = descPlain.toLowerCase().includes("minya") ? "Minya Cluster L700" : sourceName;
      cells.push({
        id: `kml-${sourceName}-${idx}-${pci ?? 0}`,
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
    }

    if (cells.length === 0) {
      errors.push("No Serving Cell Identity points found. Make sure file is a cell identity / sector map with Point placemarks.");
    }
    return { cells, errors, sourceName };
  } catch (e: unknown) {
    errors.push(e instanceof Error ? `Failed to read KML file: ${e.message}` : "Failed to read KML file.");
    return { cells: [], errors, sourceName };
  }
}
