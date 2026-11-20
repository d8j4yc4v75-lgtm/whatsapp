import { createMap, drawRoute, makeRoute } from './simulated-route.mjs'

const status = document.querySelector('#route-status')
const toggle = document.querySelector('#route-toggle')
const restart = document.querySelector('#route-restart')

try {
	const data = location.hash.slice(1)
	if (data.length > 1500 || !/^[A-Za-z0-9_-]+$/.test(data)) throw new Error()
	const { points, speed } = JSON.parse(atob(data.replaceAll('-', '+').replaceAll('_', '/')))
	const route = makeRoute(points, speed, (a, b) => L.latLng(a).distanceTo(b))
	const map = createMap(document.querySelector('#route-map'))
	map.fitBounds(points, { padding: [28, 28], maxZoom: 16 })
	drawRoute(map, points, L.layerGroup().addTo(map))
	const marker = L.circleMarker(points[0], {
		radius: 10, color: '#fff', weight: 3, fillColor: '#007aff', fillOpacity: 1
	}).addTo(map)
	let elapsed = 0
	let started = performance.now()
	let frame
	let playing = true

	function update(now) {
		const seconds = Math.min(route.duration, elapsed + (now - started) / 1000)
		marker.setLatLng(route.position(seconds))
		if (seconds >= route.duration) {
			playing = false
			elapsed = route.duration
			toggle.disabled = true
			status.textContent = 'Recorrido terminado'
			return
		}
		frame = requestAnimationFrame(update)
	}

	function play() {
		started = performance.now()
		playing = true
		toggle.disabled = false
		toggle.textContent = 'Pausar'
		status.textContent = `En movimiento · ${speed} km/h`
		frame = requestAnimationFrame(update)
	}

	toggle.onclick = () => {
		if (!playing) return play()
		cancelAnimationFrame(frame)
		elapsed += (performance.now() - started) / 1000
		playing = false
		toggle.textContent = 'Continuar'
		status.textContent = 'En pausa'
	}
	restart.onclick = () => {
		cancelAnimationFrame(frame)
		elapsed = 0
		marker.setLatLng(points[0])
		play()
	}
	restart.disabled = false
	play()
} catch {
	status.textContent = 'El enlace del recorrido no es válido.'
	document.querySelector('#route-map').hidden = true
}
