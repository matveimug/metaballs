import { traceContours } from "$lib/metaballs/contours.js";
import { buildExportFilename } from "$lib/metaballs/utils.js";

function contoursToSvgPathMarkup(paths, sourceHeight, scaleX, scaleY, color, keepHoles) {
  const mappedPaths = paths
    .map((poly) => {
      const d = poly
        .map((pt, idx) => {
          const x = (pt.x * scaleX).toFixed(2);
          const y = ((sourceHeight - pt.y) * scaleY).toFixed(2);
          return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
        })
        .join(" ");
      return `${d} Z`;
    })
    .filter(Boolean);
  if (!mappedPaths.length) return [];
  if (keepHoles) {
    return [
      `  <path d="${mappedPaths.join(" ")}" fill="${color}" stroke="none" fill-rule="evenodd"/>`,
    ];
  }
  return mappedPaths.map((pathData) => `  <path d="${pathData}" fill="${color}" stroke="none"/>`);
}

export function exportPatternPng({
  renderer,
  render,
  layers,
  outputWidth,
  outputHeight,
  gridX,
  gridY,
}) {
  if (!renderer) return;
  const composite = document.createElement("canvas");
  composite.width = outputWidth;
  composite.height = outputHeight;
  const compositeCtx = composite.getContext("2d");
  if (!compositeCtx) return;
  for (const layer of layers) {
    render(layer.circles, layer.gridWidthUnits, layer.gridHeightUnits);
    const maskSource = renderer.domElement;
    const layerCanvas = document.createElement("canvas");
    layerCanvas.width = outputWidth;
    layerCanvas.height = outputHeight;
    const layerCtx = layerCanvas.getContext("2d");
    if (!layerCtx) continue;
    layerCtx.drawImage(maskSource, 0, 0, outputWidth, outputHeight);
    layerCtx.globalCompositeOperation = "source-in";
    layerCtx.fillStyle = layer.color;
    layerCtx.fillRect(0, 0, outputWidth, outputHeight);
    layerCtx.globalCompositeOperation = "source-over";
    compositeCtx.drawImage(layerCanvas, 0, 0);
  }
  const link = document.createElement("a");
  link.href = composite.toDataURL("image/png");
  link.download = buildExportFilename("pattern", gridX, gridY, "png");
  link.click();
}

export function exportPatternSvg({
  renderer,
  rtB,
  render,
  layers,
  internalWidth,
  internalHeight,
  outputWidth,
  outputHeight,
  preserveHoles,
  gridX,
  gridY,
}) {
  if (!renderer || !rtB) return;
  const width = internalWidth;
  const height = internalHeight;
  const scaleX = outputWidth / width;
  const scaleY = outputHeight / height;
  const pixels = new Uint8Array(width * height * 4);

  const layerPathMarkup = [];
  for (const layer of layers) {
    render(layer.circles, layer.gridWidthUnits, layer.gridHeightUnits);
    renderer.readRenderTargetPixels(rtB, 0, 0, width, height, pixels);
    const paths = traceContours(pixels, width, height, 128);
    layerPathMarkup.push(
      ...contoursToSvgPathMarkup(paths, height, scaleX, scaleY, layer.color, preserveHoles),
    );
  }

  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}">\n` +
    `  <rect width="100%" height="100%" fill="white"/>\n` +
    `${layerPathMarkup.join("\n")}\n` +
    `</svg>`;
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = buildExportFilename("pattern", gridX, gridY, "svg");
  link.click();
  URL.revokeObjectURL(link.href);
}
