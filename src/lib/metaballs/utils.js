import { MAX_GRID, MAX_INTERNAL } from './constants.js';
import * as THREE from 'three';

export function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

export function sanitizeGridUnits(value, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return clamp(Math.round(n), 1, MAX_GRID);
}

export function sanitizeCellSize(value, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return clamp(Math.round(n), 10, 400);
}

export function getEffectiveRenderScale(width, height, baseScale) {
	const base = clamp(Number(baseScale) || 1, 0.5, 1.5);
	const maxScaleX = MAX_INTERNAL / Math.max(1, width);
	const maxScaleY = MAX_INTERNAL / Math.max(1, height);
	return Math.max(0.5, Math.min(base, maxScaleX, maxScaleY));
}

export function keyFromHalf(xHalf, yHalf) {
	return `${xHalf},${yHalf}`;
}

export function isValidCenterHalf(xHalf, yHalf, diameter, gridX, gridY) {
	const centerX = xHalf / 2;
	const centerY = yHalf / 2;
	const radius = diameter / 2;
	return (
		centerX - radius >= 0 &&
		centerX + radius <= gridX &&
		centerY - radius >= 0 &&
		centerY + radius <= gridY
	);
}

export function buildDiameterList(count) {
	const diameterList = [];
	if (count === 1) {
		diameterList.push(3);
	} else if (count === 2) {
		diameterList.push(3, 2);
	} else {
		diameterList.push(3, 2, 2);
		for (let i = 3; i < count; i += 1) {
			diameterList.push(1);
		}
	}
	return diameterList;
}

export function buildExportFilename(mode, gridX, gridY, extension, now = new Date()) {
	const pad2 = (value) => String(value).padStart(2, '0');
	const day = pad2(now.getDate());
	const month = pad2(now.getMonth() + 1);
	const year = pad2(now.getFullYear() % 100);
	const hours = pad2(now.getHours());
	const minutes = pad2(now.getMinutes());
	return `metaballs_${mode}_grid_${gridX}x${gridY}_at_${day}.${month}.${year}.${hours}${minutes}.${extension}`;
}

export function clampRenderScale(value) {
	return clamp(Number(value) || 1, 0.5, 1.5);
}

export function resolveGridState(gridWidthUnits, gridHeightUnits, fallbackX = 10, fallbackY = 10, fixedCellSize = 100) {
	const gridX = sanitizeGridUnits(gridWidthUnits, fallbackX);
	const gridY = sanitizeGridUnits(gridHeightUnits, fallbackY);
	const cellSize = fixedCellSize;
	return {
		cellSize,
		gridX,
		gridY,
		gridWidthUnits: gridX,
		gridHeightUnits: gridY,
		canvasWidthPx: gridX * cellSize,
		canvasHeightPx: gridY * cellSize,
	};
}

export function getCellFromPointerEvent(event, canvasEl, gridX, gridY) {
	const rect = canvasEl.getBoundingClientRect();
	const cellPxX = Math.max(1e-6, rect.width / Math.max(1, gridX));
	const cellPxY = Math.max(1e-6, rect.height / Math.max(1, gridY));
	const x = Math.floor((event.clientX - rect.left) / cellPxX);
	const y = Math.floor((event.clientY - rect.top) / cellPxY);
	return {
		x: clamp(x, 0, Math.max(0, gridX - 1)),
		y: clamp(y, 0, Math.max(0, gridY - 1)),
	};
}

export function findCircleAtPointerEvent(event, canvasEl, circles, gridX, gridY) {
	const rect = canvasEl.getBoundingClientRect();
	const px = event.clientX - rect.left;
	const py = event.clientY - rect.top;
	const cellPxX = Math.max(1e-6, rect.width / Math.max(1, gridX));
	const cellPxY = Math.max(1e-6, rect.height / Math.max(1, gridY));
	let hit = null;
	let best = Infinity;
	for (const [key, circle] of circles.entries()) {
		const cx = (circle.xHalf / 2) * cellPxX;
		const cy = (circle.yHalf / 2) * cellPxY;
		const radiusPx = (circle.diameter / 2) * Math.min(cellPxX, cellPxY);
		const dx = px - cx;
		const dy = py - cy;
		const dist = Math.hypot(dx, dy);
		if (dist <= radiusPx && dist < best) {
			best = dist;
			hit = { key, circle };
		}
	}
	return hit;
}

export function getCircleFromCellBox(startCell, currentCell) {
	const x0 = Math.min(startCell.x, currentCell.x);
	const y0 = Math.min(startCell.y, currentCell.y);
	const x1 = Math.max(startCell.x, currentCell.x) + 1;
	const y1 = Math.max(startCell.y, currentCell.y) + 1;
	const widthCells = Math.max(1, x1 - x0);
	const heightCells = Math.max(1, y1 - y0);
	const diameter = Math.max(1, Math.min(widthCells, heightCells));
	const centerX = x0 + widthCells / 2;
	const centerY = y0 + heightCells / 2;
	return {
		xHalf: Math.round(centerX * 2),
		yHalf: Math.round(centerY * 2),
		diameter,
	};
}

export function computeCanvasFit(containerEl, canvasWidthPx, canvasHeightPx, paddingPx = 20) {
	if (!containerEl) {
		return {
			canvasScale: 1,
			canvasDisplayWidthPx: canvasWidthPx,
			canvasDisplayHeightPx: canvasHeightPx,
		};
	}
	const availableWidth = Math.max(1, containerEl.clientWidth - paddingPx);
	const availableHeight = Math.max(1, containerEl.clientHeight - paddingPx);
	const scaleX = availableWidth / Math.max(1, canvasWidthPx);
	const scaleY = availableHeight / Math.max(1, canvasHeightPx);
	const nextScale = Math.min(1, scaleX, scaleY);
	const canvasScale = Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1;
	return {
		canvasScale,
		canvasDisplayWidthPx: Math.max(1, Math.round(canvasWidthPx * canvasScale)),
		canvasDisplayHeightPx: Math.max(1, Math.round(canvasHeightPx * canvasScale)),
	};
}

export function contoursToMaskDataUrl(paths, sourceWidth, sourceHeight, outputWidth, outputHeight, keepHoles) {
	const canvas = document.createElement('canvas');
	canvas.width = outputWidth;
	canvas.height = outputHeight;
	const ctx = canvas.getContext('2d');
	if (!ctx) return '';
	const scaleX = outputWidth / sourceWidth;
	const scaleY = outputHeight / sourceHeight;
	ctx.clearRect(0, 0, outputWidth, outputHeight);
	ctx.fillStyle = '#ffffff';

	if (keepHoles) {
		const path = new Path2D();
		for (const poly of paths) {
			if (!poly.length) continue;
			path.moveTo(poly[0].x * scaleX, (sourceHeight - poly[0].y) * scaleY);
			for (let i = 1; i < poly.length; i += 1) {
				path.lineTo(poly[i].x * scaleX, (sourceHeight - poly[i].y) * scaleY);
			}
			path.closePath();
		}
		ctx.fill(path, 'evenodd');
		return canvas.toDataURL('image/png');
	}

	for (const poly of paths) {
		if (!poly.length) continue;
		ctx.beginPath();
		ctx.moveTo(poly[0].x * scaleX, (sourceHeight - poly[0].y) * scaleY);
		for (let i = 1; i < poly.length; i += 1) {
			ctx.lineTo(poly[i].x * scaleX, (sourceHeight - poly[i].y) * scaleY);
		}
		ctx.closePath();
		ctx.fill();
	}
	return canvas.toDataURL('image/png');
}

export function getCanvasSizePx(canvasWidthPx, canvasHeightPx) {
	return {
		width: canvasWidthPx,
		height: canvasHeightPx,
	};
}

export function tryAddCircleAt(targetCircles, xHalf, yHalf, diameter, sourceGridX, sourceGridY) {
	if (!isValidCenterHalf(xHalf, yHalf, diameter, sourceGridX, sourceGridY)) return false;
	const key = keyFromHalf(xHalf, yHalf);
	if (targetCircles.has(key)) return false;
	targetCircles.set(key, { xHalf, yHalf, diameter });
	return true;
}

export function populateFilledCircleMap(targetCircles, diameter, gridX, gridY) {
	targetCircles.clear();
	const snapped = clamp(Math.round(diameter), 1, MAX_GRID);
	const radius = snapped / 2;
	const parity = snapped % 2;
	for (let yHalf = 0; yHalf <= gridY * 2; yHalf += 1) {
		if (yHalf % 2 !== parity) continue;
		const cy = yHalf / 2;
		if (cy < radius || cy > gridY - radius) continue;
		for (let xHalf = 0; xHalf <= gridX * 2; xHalf += 1) {
			if (xHalf % 2 !== parity) continue;
			const cx = xHalf / 2;
			if (cx < radius || cx > gridX - radius) continue;
			targetCircles.set(keyFromHalf(xHalf, yHalf), { xHalf, yHalf, diameter: snapped });
		}
	}
}

export function buildRandomCircleMap({ sourceGridX, sourceGridY, randomCount, maxRandom, marginCells = 2 }) {
	const nextCircles = new Map();
	const cellsMinX = marginCells;
	const cellsMinY = marginCells;
	const cellsMaxX = Math.max(cellsMinX, sourceGridX - 1 - marginCells);
	const cellsMaxY = Math.max(cellsMinY, sourceGridY - 1 - marginCells);
	if (cellsMaxX < cellsMinX || cellsMaxY < cellsMinY) return nextCircles;
	const count = clamp(Math.round(Number(randomCount) || 1), 1, maxRandom);
	const diameterList = buildDiameterList(count);

	for (const diameter of diameterList) {
		const isOdd = diameter % 2 === 1;
		let placed = false;
		for (let attempt = 0; attempt < 200 && !placed; attempt += 1) {
			const cellX = Math.floor(Math.random() * (cellsMaxX - cellsMinX + 1)) + cellsMinX;
			const cellY = Math.floor(Math.random() * (cellsMaxY - cellsMinY + 1)) + cellsMinY;
			const xHalf = isOdd ? cellX * 2 + 1 : cellX * 2;
			const yHalf = isOdd ? cellY * 2 + 1 : cellY * 2;
			const centerX = xHalf / 2;
			const centerY = yHalf / 2;
			const radius = diameter / 2;
			const hasMargin =
				centerX - radius >= marginCells &&
				centerY - radius >= marginCells &&
				centerX + radius <= sourceGridX - marginCells &&
				centerY + radius <= sourceGridY - marginCells;
			placed = hasMargin && tryAddCircleAt(nextCircles, xHalf, yHalf, diameter, sourceGridX, sourceGridY);
		}
	}

	return nextCircles;
}

export function handleCanvasPointerDown(event, canvasEl, getCellFromEvent, findCircleAtEvent, updateActiveCircleFromBox) {
	if (event.button !== 0) {
		return {
			handled: false,
		};
	}
	const dragStartCell = getCellFromEvent(event);
	const hit = findCircleAtEvent(event);
	const startedOnCircleKey = hit?.key || null;
	if (!startedOnCircleKey) {
		updateActiveCircleFromBox(dragStartCell, dragStartCell);
	}
	canvasEl.setPointerCapture(event.pointerId);
	return {
		handled: true,
		dragStartCell,
		isDragging: true,
		dragMoved: false,
		startedOnCircleKey,
	};
}

export function handleCanvasPointerMove(
	event,
	{ isDragging, dragStartCell, dragMoved, startedOnCircleKey, activeCircleKey },
	getCellFromEvent,
	updateActiveCircleFromBox,
) {
	if (!isDragging) return { handled: false };
	const currentCell = getCellFromEvent(event);
	let nextDragMoved = dragMoved;
	let nextActiveCircleKey = activeCircleKey;
	if (currentCell.x !== dragStartCell.x || currentCell.y !== dragStartCell.y) {
		nextDragMoved = true;
	}
	if (startedOnCircleKey) {
		if (!nextDragMoved) {
			return {
				handled: true,
				dragMoved: nextDragMoved,
				activeCircleKey: nextActiveCircleKey,
			};
		}
		if (!nextActiveCircleKey) nextActiveCircleKey = startedOnCircleKey;
	}
	updateActiveCircleFromBox(dragStartCell, currentCell);
	return {
		handled: true,
		dragMoved: nextDragMoved,
		activeCircleKey: nextActiveCircleKey,
	};
}

export function handleCanvasPointerUp(event, canvasEl, { isDragging }) {
	if (!isDragging) return { handled: false };
	canvasEl.releasePointerCapture(event.pointerId);
	return {
		handled: true,
		isDragging: false,
		activeCircleKey: null,
		startedOnCircleKey: null,
	};
}

export function scheduleDirtyRender(renderer, needsRender, renderFn) {
	if (!renderer || needsRender) return { needsRender, rafId: undefined };
	const rafId = requestAnimationFrame(() => {
		renderFn();
	});
	return {
		needsRender: true,
		rafId,
	};
}

export function setupRendererResources({
	width,
	height,
	baseRenderScale,
	blurRadius,
	vertexShader,
	blurFragment,
	finalFragment,
}) {
	const scale = getEffectiveRenderScale(width, height, baseRenderScale);
	const scaledWidth = Math.max(1, Math.floor(width * scale));
	const scaledHeight = Math.max(1, Math.floor(height * scale));

	const maskCanvas = document.createElement('canvas');
	maskCanvas.width = scaledWidth;
	maskCanvas.height = scaledHeight;
	const maskCtx = maskCanvas.getContext('2d');
	const maskTexture = new THREE.CanvasTexture(maskCanvas);
	maskTexture.minFilter = THREE.LinearFilter;
	maskTexture.magFilter = THREE.LinearFilter;
	maskTexture.wrapS = THREE.ClampToEdgeWrapping;
	maskTexture.wrapT = THREE.ClampToEdgeWrapping;

	const rtA = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		type: THREE.UnsignedByteType,
	});
	const rtB = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		type: THREE.UnsignedByteType,
	});

	const scene = new THREE.Scene();
	const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	const blurMaterial = new THREE.ShaderMaterial({
		vertexShader,
		fragmentShader: blurFragment,
		uniforms: {
			uInput: { value: maskTexture },
			uResolution: { value: new THREE.Vector2(scaledWidth, scaledHeight) },
			uDirection: { value: new THREE.Vector2(1, 0) },
			uRadius: { value: blurRadius },
		},
	});
	const finalMaterial = new THREE.ShaderMaterial({
		vertexShader,
		fragmentShader: finalFragment,
		uniforms: {
			uInput: { value: maskTexture },
			uThreshold: { value: 0.5 },
		},
	});
	const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), finalMaterial);
	scene.add(quad);

	return {
		internalWidth: scaledWidth,
		internalHeight: scaledHeight,
		maskCanvas,
		maskCtx,
		maskTexture,
		rtA,
		rtB,
		scene,
		camera,
		blurMaterial,
		finalMaterial,
		quad,
	};
}

export function rebuildRendererResources({
	width,
	height,
	baseRenderScale,
	maskTexture,
	rtA,
	rtB,
	blurMaterial,
	finalMaterial,
}) {
	const scale = getEffectiveRenderScale(width, height, baseRenderScale);
	const scaledWidth = Math.max(1, Math.floor(width * scale));
	const scaledHeight = Math.max(1, Math.floor(height * scale));

	const maskCanvas = document.createElement('canvas');
	maskCanvas.width = scaledWidth;
	maskCanvas.height = scaledHeight;
	const maskCtx = maskCanvas.getContext('2d');

	maskTexture?.dispose();
	const nextMaskTexture = new THREE.CanvasTexture(maskCanvas);
	nextMaskTexture.minFilter = THREE.LinearFilter;
	nextMaskTexture.magFilter = THREE.LinearFilter;
	nextMaskTexture.wrapS = THREE.ClampToEdgeWrapping;
	nextMaskTexture.wrapT = THREE.ClampToEdgeWrapping;

	rtA?.dispose();
	rtB?.dispose();
	const nextRtA = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		type: THREE.UnsignedByteType,
	});
	const nextRtB = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		type: THREE.UnsignedByteType,
	});

	if (blurMaterial) {
		blurMaterial.uniforms.uInput.value = nextMaskTexture;
		blurMaterial.uniforms.uResolution.value.set(scaledWidth, scaledHeight);
	}
	if (finalMaterial) {
		finalMaterial.uniforms.uInput.value = nextMaskTexture;
	}

	return {
		internalWidth: scaledWidth,
		internalHeight: scaledHeight,
		maskCanvas,
		maskCtx,
		maskTexture: nextMaskTexture,
		rtA: nextRtA,
		rtB: nextRtB,
	};
}

export function resizeRendererResources({
	renderer,
	width,
	height,
	baseRenderScale,
	maskCanvas,
	maskTexture,
	rtA,
	rtB,
	blurMaterial,
}) {
	if (!renderer) return null;
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
	const safeWidth = Math.max(1, Math.round(width));
	const safeHeight = Math.max(1, Math.round(height));
	renderer.setSize(safeWidth, safeHeight, false);
	const scale = getEffectiveRenderScale(safeWidth, safeHeight, baseRenderScale);
	const scaledWidth = Math.max(1, Math.floor(safeWidth * scale));
	const scaledHeight = Math.max(1, Math.floor(safeHeight * scale));
	maskCanvas.width = scaledWidth;
	maskCanvas.height = scaledHeight;
	maskTexture.needsUpdate = true;
	rtA.setSize(scaledWidth, scaledHeight);
	rtB.setSize(scaledWidth, scaledHeight);
	blurMaterial.uniforms.uResolution.value.set(scaledWidth, scaledHeight);
	return {
		internalWidth: scaledWidth,
		internalHeight: scaledHeight,
	};
}
