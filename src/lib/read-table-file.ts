/** Reads an uploaded site table (CSV / TSV / TXT / XLSX / XLS) into delimited text. */

export type ReadOptions = {
  /** 0..100 progress while the bytes are read from disk. */
  onProgress?: (percent: number) => void;
  /** Abort the read (Cancel button). */
  signal?: AbortSignal;
};

function readWith(
  file: File,
  as: "text" | "buffer",
  { onProgress, signal }: ReadOptions,
): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const reader = new FileReader();
    const abort = () => reader.abort();
    signal?.addEventListener("abort", abort);
    reader.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    reader.onload = () => {
      signal?.removeEventListener("abort", abort);
      onProgress?.(100);
      resolve(reader.result as string | ArrayBuffer);
    };
    reader.onabort = () => {
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    reader.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`Could not read “${file.name}”. The file may be locked or corrupted.`));
    };
    if (as === "text") reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

export async function readTableFile(file: File, opts: ReadOptions = {}): Promise<string> {
  const name = file.name.toLowerCase();
  const isSheet = /\.(xlsx|xls|xlsm|ods)$/.test(name);

  if (!isSheet) {
    const text = (await readWith(file, "text", opts)) as string;
    return text.replace(/^\uFEFF/, "");
  }

  const buf = (await readWith(file, "buffer", opts)) as ArrayBuffer;
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("The workbook has no sheets.");
  // Tab separated keeps commas inside values intact for the parser.
  return XLSX.utils.sheet_to_csv(sheet, { FS: "\t" });
}

export const TABLE_ACCEPT = ".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods";
