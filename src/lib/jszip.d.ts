declare module "jszip" {
  export default class JSZip {
    static loadAsync(data: ArrayBuffer | Uint8Array | Blob | string): Promise<JSZip>;
    file(name: string): JSZip.JSZipObject | null;
    files: Record<string, JSZip.JSZipObject>;
  }
  namespace JSZip {
    interface JSZipObject {
      async(type: "string" | "arraybuffer" | "uint8array" | "blob" | "nodebuffer"): Promise<any>;
    }
  }
}
