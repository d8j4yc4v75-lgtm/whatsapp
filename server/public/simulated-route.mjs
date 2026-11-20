export function validPoint(point) {
	return Array.isArray(point) && point.length === 2 &&
		Number.isFinite(point[0]) && Math.abs(point[0]) <= 85 &&
		Number.isFinite(point[1]) && Math.abs(point[1]) <= 180
}

export function drawRoute(map, points, layers) {
	layers.clearLayers()
	if (!points.length) return
	L.polyline(points, { color: '#007a61' }).addTo(layers)
	points.forEach(point => L.circleMarker(point, {
		radius: 5, color: '#007a61', fillOpacity: 1
	}).addTo(layers))
}

export function createMap(element) {
	const map = L.map(element).setView([19.4326, -99.1332], 13)
	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
	}).addTo(map)
	return map
}

export function makeRoute(points, speed, distanceBetween) {
	if (!Array.isArray(points) || points.length < 2 || points.length > 24 ||
		!points.every(validPoint) || !Number.isFinite(speed) || speed < 1 || speed > 150) {
		throw new Error('Elige entre 2 y 24 puntos y una velocidad de 1 a 150 km/h.')
	}
	const segments = []
	let distance = 0
	for (let i = 1; i < points.length; i++) {
		const start = points[i - 1]
		const end = points[i]
		if (Math.abs(end[1] - start[1]) > 180) {
			throw new Error('Agrega puntos que no crucen el meridiano de 180°.')
		}
		const length = distanceBetween(start, end)
		if (!length) continue
		segments.push({ start, end, offset: distance, length })
		distance += length
	}
	if (!distance) throw new Error('Elige al menos dos puntos diferentes.')
	const duration = distance / (speed / 3.6)
	return {
		duration,
		position(seconds) {
			const traveled = Math.max(0, seconds) * speed / 3.6
			if (traveled >= distance) return points.at(-1)
			const { start, end, offset, length } = segments.find(segment => traveled < segment.offset + segment.length)
			const fraction = (traveled - offset) / length
			return start.map((value, i) => value + (end[i] - value) * fraction)
		}
	}
}
