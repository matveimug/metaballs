import { traceContours } from "$lib/metaballs/contours.js";
import { buildExportFilename } from "$lib/metaballs/utils.js";

export function exportEditorPng({ renderer, render, gridX, gridY }) {
  if (!renderer) return;
  render();
  const link = document.createElement("a");
  link.href = renderer.domElement.toDataURL("image/png");
  link.download = buildExportFilename("editor", gridX, gridY, "png");
  link.click();
}

export function exportEditorSvg({
  renderer,
  rtB,
  render,
  internalWidth,
  internalHeight,
  outputWidth,
  outputHeight,
  preserveHoles,
  gridX,
  gridY,
}) {
  if (!renderer || !rtB) return;
  render();
  const width = internalWidth;
  const height = internalHeight;
  const pixels = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(rtB, 0, 0, width, height, pixels);
  const paths = traceContours(pixels, width, height, 128);
  const scaleX = outputWidth / width;
  const scaleY = outputHeight / height;
  const pathData = paths
    .map((poly) => {
      const d = poly
        .map((pt, idx) => {
          const x = (pt.x * scaleX).toFixed(2);
          const y = ((height - pt.y) * scaleY).toFixed(2);
          return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
        })
        .join(" ");
      return `${d} Z`;
    })
    .join(" ");
  const pathMarkup = preserveHoles
    ? `  <path d="${pathData}" fill="black" stroke="none" fill-rule="evenodd"/>\n`
    : paths
        .map((poly) => {
          const d = poly
            .map((pt, idx) => {
              const x = (pt.x * scaleX).toFixed(2);
              const y = ((height - pt.y) * scaleY).toFixed(2);
              return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
            })
            .join(" ");
          return `  <path d="${d} Z" fill="black" stroke="none"/>`;
        })
        .join("\n");
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${outputWidth} ${outputHeight}">\n` +
    `  <rect width="100%" height="100%" fill="white"/>\n` +
    `${pathMarkup}` +
    `</svg>`;
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = buildExportFilename("editor", gridX, gridY, "svg");
  link.click();
  URL.revokeObjectURL(link.href);
}
