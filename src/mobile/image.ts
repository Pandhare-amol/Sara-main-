/**
 * Client-side image preparation for camera analysis.
 *
 * Photos from a modern phone camera are 4000 px / several MB. The model does
 * not need that, the phone's uplink does not want it, and the server caps the
 * payload. Downscaling here keeps a capture around 150-350 KB.
 */

export interface PreparedImage {
  /** data URL (image/jpeg) */
  dataUrl: string;
  mimeType: "image/jpeg";
  dataBase64: string;
  width: number;
  height: number;
  bytes: number;
}

const MAX_EDGE = 1280;
const QUALITY = 0.82;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file could not be read as an image."));
    };
    image.src = url;
  });
}

/** Read a camera/gallery file and return a downscaled JPEG. */
export async function prepareImage(file: File, maxEdge = MAX_EDGE, quality = QUALITY): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file (JPEG, PNG or WebP).");
  if (file.size > 25 * 1024 * 1024) throw new Error("That image is larger than 25 MB. Take a normal photo instead.");

  const image = await loadImage(file);
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This device could not process the image. Try a different browser.");

  // White matte: transparent PNGs become black otherwise.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  const dataBase64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    dataUrl,
    mimeType: "image/jpeg",
    dataBase64,
    width,
    height,
    bytes: Math.round((dataBase64.length * 3) / 4),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
