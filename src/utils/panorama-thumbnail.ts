/**
 * Generate a thumbnail data URL by cropping the front-facing region of an equirectangular
 * panorama. Independent from the live camera / preview render — the result depends only
 * on the panorama image itself, so generating a thumbnail never rotates anything.
 *
 * Equirectangular convention used here: longitude 0 (front) is at the horizontal center
 * of the image, the equator (latitude 0) is at the vertical center. The crop is a centered
 * window sized by `fovDeg` (horizontal angular width) and aspect-matched to the thumbnail.
 */
export async function panoramaToThumbnail(
  panoramaSrc: string,
  opts: { width?: number; height?: number; fovDeg?: number; quality?: number } = {},
): Promise<string> {
  const width = opts.width ?? 320;
  const height = opts.height ?? 200;
  const fovDeg = opts.fovDeg ?? 80;
  const quality = opts.quality ?? 0.85;

  const img = await loadImage(panoramaSrc);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;

  // Horizontal crop = fraction of the panorama's longitude window we want.
  const cropW = (fovDeg / 360) * W;
  // Match thumbnail aspect; clamp to image height so we never sample outside the image.
  const cropH = Math.min(H, cropW * (height / width));
  const cropX = W / 2 - cropW / 2;
  const cropY = H / 2 - cropH / 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('panoramaToThumbnail: 2D context unavailable');
  ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`panorama image load failed: ${e}`));
    img.src = src;
  });
}
