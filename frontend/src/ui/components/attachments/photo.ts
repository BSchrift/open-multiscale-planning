// A photo as it's kept and uploaded: a JPEG at most 2,048 pixels on its long side, about 1 MB, which also turns an
// iPhone's HEIC into something every app can show.

const LONG_SIDE = 2048;
const QUALITY = 0.85;

export async function shrinkPhoto(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The photo could not be saved'))), 'image/jpeg', QUALITY));
}

/** The SHA-256 of a file's bytes in base64, as the upload signs it. */
export async function sha256Base64(file: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  return btoa(String.fromCharCode(...digest));
}

/** A photo keeps its name, as a JPEG. One taken just now has none worth keeping. */
export function photoName(file: File): string {
  const base = file.name.replace(/\.[^.]*$/, '').trim();
  return base && !/^image$/i.test(base) ? `${base}.jpg` : 'Photo.jpg';
}
