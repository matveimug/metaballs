import { MAX_GRID, MAX_INTERNAL } from './constants.js';

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
