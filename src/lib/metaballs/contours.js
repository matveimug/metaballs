export function traceContours(pixels, width, height, threshold) {
	const getValue = (x, y) => {
		const idx = (y * width + x) * 4;
		return pixels[idx] >= threshold ? 1 : 0;
	};
	const segments = [];
	for (let y = 0; y < height - 1; y += 1) {
		for (let x = 0; x < width - 1; x += 1) {
			const tl = getValue(x, y);
			const tr = getValue(x + 1, y);
			const br = getValue(x + 1, y + 1);
			const bl = getValue(x, y + 1);
			const code = tl * 8 + tr * 4 + br * 2 + bl;
			const x0 = x;
			const y0 = y;
			const x1 = x + 1;
			const y1 = y + 1;
			const xm = x + 0.5;
			const ym = y + 0.5;
			switch (code) {
				case 1:
				case 14:
					segments.push([{ x: x0, y: ym }, { x: xm, y: y1 }]);
					break;
				case 2:
				case 13:
					segments.push([{ x: xm, y: y1 }, { x: x1, y: ym }]);
					break;
				case 3:
				case 12:
					segments.push([{ x: x0, y: ym }, { x: x1, y: ym }]);
					break;
				case 4:
				case 11:
					segments.push([{ x: xm, y: y0 }, { x: x1, y: ym }]);
					break;
				case 5:
					segments.push([{ x: xm, y: y0 }, { x: x0, y: ym }]);
					segments.push([{ x: x1, y: ym }, { x: xm, y: y1 }]);
					break;
				case 6:
				case 9:
					segments.push([{ x: xm, y: y0 }, { x: xm, y: y1 }]);
					break;
				case 7:
				case 8:
					segments.push([{ x: xm, y: y0 }, { x: x0, y: ym }]);
					break;
				case 10:
					segments.push([{ x: xm, y: y0 }, { x: x1, y: ym }]);
					segments.push([{ x: x0, y: ym }, { x: xm, y: y1 }]);
					break;
				default:
					break;
			}
		}
	}
	const rawPaths = stitchSegments(segments);
	return rawPaths.map((path) => simplifyPath(path, 1)).map((path) => smoothPath(path, 2));
}

function stitchSegments(segments) {
	const pointKey = (p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
	const adjacency = new Map();
	const unused = new Set();
	segments.forEach((seg, i) => {
		const [a, b] = seg;
		const ka = pointKey(a);
		const kb = pointKey(b);
		if (!adjacency.has(ka)) adjacency.set(ka, []);
		if (!adjacency.has(kb)) adjacency.set(kb, []);
		adjacency.get(ka).push({ idx: i, to: b });
		adjacency.get(kb).push({ idx: i, to: a });
		unused.add(i);
	});

	const paths = [];
	while (unused.size > 0) {
		const [firstIdx] = unused;
		unused.delete(firstIdx);
		const [a, b] = segments[firstIdx];
		const path = [a, b];

		const extend = (atStart) => {
			let current = atStart ? path[0] : path[path.length - 1];
			let guard = 0;
			while (guard < 100000) {
				guard += 1;
				const key = pointKey(current);
				const options = adjacency.get(key) || [];
				const nextOption = options.find((opt) => unused.has(opt.idx));
				if (!nextOption) break;
				unused.delete(nextOption.idx);
				if (atStart) {
					path.unshift(nextOption.to);
					current = path[0];
				} else {
					path.push(nextOption.to);
					current = path[path.length - 1];
				}
			}
		};

		extend(false);
		extend(true);
		if (path.length > 2) paths.push(path);
	}
	return paths;
}

function simplifyPath(points, epsilon) {
	if (points.length < 3) return points;
	const keep = new Array(points.length).fill(false);
	keep[0] = true;
	keep[points.length - 1] = true;

	const distPointToSegment = (p, a, b) => {
		const vx = b.x - a.x;
		const vy = b.y - a.y;
		const wx = p.x - a.x;
		const wy = p.y - a.y;
		const c1 = vx * wx + vy * wy;
		if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
		const c2 = vx * vx + vy * vy;
		if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
		const t = c1 / c2;
		const px = a.x + t * vx;
		const py = a.y + t * vy;
		return Math.hypot(p.x - px, p.y - py);
	};

	const stack = [[0, points.length - 1]];
	while (stack.length) {
		const [start, end] = stack.pop();
		let maxDist = 0;
		let index = -1;
		for (let i = start + 1; i < end; i += 1) {
			const d = distPointToSegment(points[i], points[start], points[end]);
			if (d > maxDist) {
				maxDist = d;
				index = i;
			}
		}
		if (maxDist > epsilon && index !== -1) {
			keep[index] = true;
			stack.push([start, index], [index, end]);
		}
	}

	return points.filter((_, i) => keep[i]);
}

function smoothPath(points, iterations) {
	if (points.length < 3) return points;
	let result = points;
	for (let iter = 0; iter < iterations; iter += 1) {
		const next = [];
		for (let i = 0; i < result.length; i += 1) {
			const p0 = result[i];
			const p1 = result[(i + 1) % result.length];
			const q = { x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y };
			const r = { x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y };
			next.push(q, r);
		}
		result = next;
	}
	return result;
}
