import path from "path";

const IMAGE_MIME_TYPES = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
});

export function getSafeImageMimeType(filepath) {
  const extension = path.extname(filepath).toLowerCase().slice(1);
  return IMAGE_MIME_TYPES[extension] || null;
}

export function createArtifactUrl(kind, filepath) {
  return `/api/${kind}?filepath=${encodeURIComponent(filepath)}`;
}

export function isSafeLocalArtifactPath(filepath) {
  return (
    typeof filepath === "string" &&
    path.isAbsolute(filepath) &&
    !/^[/\\]{2}/.test(filepath)
  );
}

export function assertSafeLocalArtifactPath(filepath) {
  if (/^[/\\]{2}/.test(filepath)) {
    throw new Error(`Network artifact paths are not allowed: ${filepath}`);
  }
  if (!path.isAbsolute(filepath)) {
    throw new Error(`Artifact path must be absolute: ${filepath}`);
  }
}

export function assertRegularFile(stats, filepath) {
  if (!stats.isFile()) {
    throw new Error(`Artifact path is not a regular file: ${filepath}`);
  }
}
