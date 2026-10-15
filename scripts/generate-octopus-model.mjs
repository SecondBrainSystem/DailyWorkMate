// Genuine, self-contained 3D reconstruction of the supplied pink octopus.
// Face patches follow the head surface; no reference image, billboard or remote texture is used.
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.() }).catch(error => this.onerror?.(error)) }
  readAsDataURL(blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.() }).catch(error => this.onerror?.(error)) }
}
const scene = new THREE.Scene()
const character = new THREE.Group()
character.name = 'PinkOctopus'
character.userData = { title: 'Pink AI Octopus', revision: 2, description: 'Reference-matched procedural reconstruction: broad pink head, inset dark eyes, eight individually posed curled arms and modeled peach suction cups.', generator: 'DailyWorkMate generate-octopus-model.mjs' }
scene.add(character)
const material = (color, roughness = .44, extra = {}) => new THREE.MeshPhysicalMaterial({ color, roughness, metalness: 0, clearcoat: .16, clearcoatRoughness: .38, ...extra })
const skinColor = new THREE.Color('#f875a5')
const blush = material('#ed608a', .56)
const cream = material('#fff1e9', .4)
const iris = material('#36202a', .3, { clearcoat: .24, clearcoatRoughness: .3 })
const eyePink = material('#ff8fb7', .25, { emissive: '#c0436c', emissiveIntensity: .15 })
const light = material('#fffaf4', .3, { emissive: '#fff3ef', emissiveIntensity: .25 })
const lashMat = material('#641b2c', .52, { clearcoat: 0 })
const mouthMat = material('#791324', .5, { clearcoat: .03 })
const tongueMat = material('#ff6a89', .43)
const blue = material('#62d7f1', .19, { emissive: '#33b5e0', emissiveIntensity: .24, clearcoat:.55, clearcoatRoughness:.2 })
const ringMat = material('#e38acb', .4, { clearcoat: .2 })
const sphere = new THREE.SphereGeometry(1, 36, 24)
function ellipsoid(name, parent, mat, position, scale) {
  const mesh = new THREE.Mesh(sphere, mat)
  mesh.name = name; mesh.position.set(...position); mesh.scale.set(...scale); parent.add(mesh)
  return mesh
}
const headCenter = 1.65, headWidth = 1.22, headHeight = 1.09, headDepth = .93
function cheekVolume(x, y) {
  return .07 * Math.exp(-(((Math.abs(x) - .58) / .34) ** 2 + ((y - 1.08) / .22) ** 2))
}
function faceZ(x, y) {
  return headDepth * Math.sqrt(Math.max(.005, 1 - (x / headWidth) ** 2 - ((y - headCenter) / headHeight) ** 2)) + cheekVolume(x, y)
}
// Smoothly unite the body and all eight arms. This removes visible mesh seams at the shoulders.
function buildBody(curves) {
  const resolution = 136, half = 1.96, centerY = 1.29, size2 = resolution * resolution
  const step = half * 2 / resolution, count = resolution ** 3
  const field = new Float32Array(count), armField = new Float32Array(count)
  const smoothUnion = (a, b, k) => { const h = Math.max(0, k - Math.abs(a - b)) / k; return Math.min(a, b) - h * h * k * .25 }
  for (let z = 0; z < resolution; z++) for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const px = x * step - half, py = y * step - half + centerY, pz = z * step - half
    const adjustedZ = pz - (pz > 0 ? cheekVolume(px, py) * Math.min(1, pz / .35) : 0)
    const d = Math.sqrt((px / headWidth) ** 2 + ((py - headCenter) / headHeight) ** 2 + (adjustedZ / headDepth) ** 2)
    field[x + y * resolution + z * size2] = (d - 1) * headDepth
  }
  for (const curve of curves) {
    armField.fill(Infinity)
    const segments = 100
    for (let i = 0; i < segments; i++) {
      const a = curve.getPointAt(i / segments), b = curve.getPointAt((i + 1) / segments)
      const r0 = armRadius(i / segments), r1 = armRadius((i + 1) / segments)
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, length2 = dx * dx + dy * dy + dz * dz
      const radius = Math.max(r0, r1) + .20
      const range = (v0, v1, offset) => [Math.max(0, Math.floor((Math.min(v0, v1) - radius + half - offset) / step)), Math.min(resolution - 1, Math.ceil((Math.max(v0, v1) + radius + half - offset) / step))]
      const [minX, maxX] = range(a.x, b.x, 0), [minY, maxY] = range(a.y, b.y, centerY), [minZ, maxZ] = range(a.z, b.z, 0)
      for (let z = minZ; z <= maxZ; z++) for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const px = x * step - half - a.x, py = y * step - half + centerY - a.y, pz = z * step - half - a.z
        const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / length2))
        const distance = Math.hypot(px - t * dx, py - t * dy, pz - t * dz) - (r0 + (r1 - r0) * t)
        const index = x + y * resolution + z * size2
        if (distance < armField[index]) armField[index] = distance
      }
    }
    for (let i = 0; i < count; i++) field[i] = smoothUnion(field[i], armField[i], .17)
  }
  const bodyMaterial = material('#ffffff', .36, { vertexColors: true, clearcoat: .24, clearcoatRoughness: .34 }); bodyMaterial.name = 'OctopusSkin'
  const marching = new MarchingCubes(resolution, bodyMaterial, false, false, 160000)
  for (let i = 0; i < count; i++) marching.field[i] = -field[i]
  marching.isolation = 0; marching.update()
  const vertices = marching.positionArray.slice(0, marching.count * 3), normals = marching.normalArray.slice(0, marching.count * 3), colors = new Float32Array(vertices.length), uvs = new Float32Array(vertices.length / 3 * 2)
  const flushColor = new THREE.Color('#f15c92')
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i] * half, y = vertices[i + 1] * half + centerY, z = vertices[i + 2] * half
    vertices[i] = x; vertices[i + 1] = y; vertices[i + 2] = z
    uvs[i / 3 * 2] = (Math.atan2(z, x) / (Math.PI * 2) + .5) * 2; uvs[i / 3 * 2 + 1] = y * .8
    const flush = z > .40 ? Math.exp(-(((Math.abs(x) - .67) / .25) ** 2 + ((y - 1.11) / .125) ** 2)) * .82 : 0
    const color = skinColor.clone().lerp(flushColor, flush)
    const normal = new THREE.Vector3(normals[i], normals[i + 1], normals[i + 2]).normalize()
    // A small baked occlusion term gives the arm folds depth under the viewer's soft lighting.
    let shade = 1
    for (const distance of [.07, .14, .24]) {
      const ix = Math.round((x + normal.x * distance + half) / step), iy = Math.round((y + normal.y * distance + half - centerY) / step), iz = Math.round((z + normal.z * distance + half) / step)
      if (ix >= 0 && ix < resolution && iy >= 0 && iy < resolution && iz >= 0 && iz < resolution) shade -= Math.max(0, distance - field[ix + iy * resolution + iz * size2]) * .72
    }
    color.multiplyScalar(Math.max(.64, shade))
    colors[i] = color.r; colors[i + 1] = color.g; colors[i + 2] = color.b
    normals[i] = normal.x; normals[i + 1] = normal.y; normals[i + 2] = normal.z
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3)); geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3)); geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  const welded = mergeVertices(geometry, .0001); geometry.dispose(); marching.geometry.dispose()
  const mesh = new THREE.Mesh(welded, bodyMaterial); mesh.name = 'HeadAndEightArms'; mesh.userData.tentacles = 8; return mesh
}

// An elliptical patch that follows a curved surface: the eyes are shallow lenses, not separate balls.
function patch(name, parent, mat, cx, cy, rx, ry, surface, segments = 56, rings = 20) {
  const vertices = [], indices = []
  for (let i = 0; i <= rings; i++) for (let j = 0; j <= segments; j++) {
    const angle = j / segments * Math.PI * 2, radius = i / rings
    const x = cx + Math.cos(angle) * rx * radius, y = cy + Math.sin(angle) * ry * radius
    vertices.push(x, y, surface(x, y))
    if (i < rings && j < segments) { const a = i * (segments + 1) + j, b = a + segments + 1; indices.push(a, b, b + 1, a, b + 1, a + 1) }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices); geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, mat); mesh.name = name; parent.add(mesh); return mesh
}
function shapedPatch(name, parent, mat, shape, surface) {
  const geometry = new THREE.ShapeGeometry(shape, 32), position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) position.setZ(i, surface(position.getX(i), position.getY(i)))
  geometry.computeVertexNormals(); const mesh = new THREE.Mesh(geometry, mat); mesh.name = name; parent.add(mesh); return mesh
}
function armRadius(t) { return .275 * Math.pow(1 - t, .6) + .043 }
function taperedTube(curve, segments = 84, radial = 24, radiusAt = armRadius) {
  const frames = curve.computeFrenetFrames(segments, false), vertices = [], indices = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, p = curve.getPointAt(t), radius = radiusAt(t)
    for (let j = 0; j <= radial; j++) {
      const theta = j / radial * Math.PI * 2
      const direction = frames.normals[i].clone().multiplyScalar(Math.cos(theta)).addScaledVector(frames.binormals[i], Math.sin(theta))
      const v = p.clone().addScaledVector(direction, radius); vertices.push(v.x, v.y, v.z)
      if (i < segments && j < radial) { const a = i * (radial + 1) + j, b = a + radial + 1; indices.push(a, a + 1, b, b, a + 1, b + 1) }
    }
  }
  // Both caps are inside the body or a rounded terminal; no open ends are visible on rotation.
  for (const [ring, sign, point] of [[0, -1, curve.getPointAt(0)], [segments, 1, curve.getPointAt(1)]]) {
    const index = vertices.length / 3; vertices.push(point.x, point.y, point.z)
    for (let j = 0; j < radial; j++) { const a = ring * (radial + 1) + j; indices.push(...(sign > 0 ? [a, a + 1, index] : [a + 1, a, index])) }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry
}
// Front pair, lower side pair, raised side pair, back pair. Each curl has its own silhouette.
const armShapes = [
  [[-.23, 1.03, .42], [-.28, .60, .72], [-.36, .22, 1], [-.65, .16, 1.10], [-.90, .34, 1.05], [-.87, .61, .96], [-.70, .68, .98], [-.64, .56, 1.02]],
  [[.26, 1.02, .41], [.34, .59, .75], [.47, .22, 1.04], [.81, .19, 1.06], [1.02, .37, .99], [.97, .64, .89], [.80, .71, .89], [.74, .58, .96]],
  [[-.64, .99, .14], [-.80, .63, .39], [-1.10, .30, .56], [-1.33, .28, .72], [-1.44, .46, .78], [-1.30, .62, .80], [-1.16, .53, .82]],
  [[.66, .99, .09], [.85, .60, .36], [1.11, .31, .55], [1.31, .36, .66], [1.35, .56, .67], [1.19, .70, .69], [1.09, .57, .70]],
  [[-.70, 1.04, -.25], [-.91, .69, -.20], [-1.18, .62, -.12], [-1.41, .82, -.03], [-1.44, 1.11, .03], [-1.62, 1.21, .08], [-1.70, 1.09, .16]],
  [[.68, 1.03, -.29], [.95, .71, -.22], [1.21, .68, -.10], [1.41, .86, .02], [1.40, 1.15, .09], [1.22, 1.25, .15], [1.12, 1.13, .18]],
  [[-.32, 1.05, -.42], [-.42, .55, -.73], [-.69, .26, -.98], [-.98, .36, -.95], [-1.09, .64, -.86], [-.93, .79, -.87], [-.80, .69, -.96]],
  [[.32, 1.05, -.42], [.48, .56, -.71], [.73, .30, -.98], [1.01, .42, -.96], [1.08, .68, -.80], [.95, .86, -.81], [.79, .73, -.88]],
]
const armCurves = armShapes.map(shape => new THREE.CatmullRomCurve3(shape.map(([x, y, z]) => new THREE.Vector3(x * .89, y < 1.1 ? 1.1 + (y - 1.1) * .72 : y, z * .94)), false, 'centripetal'))
const bodyMesh = buildBody(armCurves); character.add(bodyMesh); bodyMesh.updateMatrixWorld(true)
const cupRay = new THREE.Raycaster()
// A closed, concave cup with a rounded lip, rather than a torus with an empty hole.
const cupProfile = [[0,-.13],[.65,-.12],[.88,-.04],[.98,.10],[.95,.29],[.79,.43],[.64,.44],[.52,.34],[.44,.18],[.33,.08],[0,.065]]
const cupCurve = new THREE.CatmullRomCurve3(cupProfile.map(([r,z]) => new THREE.Vector3(r,z,0)), false, 'centripetal')
const suctionGeometry = new THREE.LatheGeometry(cupCurve.getPoints(48).map(v => new THREE.Vector2(Math.max(0, v.x),v.y)), 36)
suctionGeometry.rotateX(Math.PI / 2)
const cupPosition = suctionGeometry.getAttribute('position'), cupColors = []
for (let i = 0; i < cupPosition.count; i++) {
  const r = Math.hypot(cupPosition.getX(i), cupPosition.getY(i))
  const color = new THREE.Color('#e5977e').lerp(new THREE.Color('#ffcfb7'), THREE.MathUtils.smoothstep(r,.17,.62))
  cupColors.push(color.r, color.g, color.b)
}
suctionGeometry.setAttribute('color', new THREE.Float32BufferAttribute(cupColors,3))
const cupMaterial = material('#ffffff', .42, {vertexColors:true, clearcoat:.16})
const arms = []
for (const [i, shape] of armShapes.entries()) {
  const curve = armCurves[i]
  const arm = new THREE.Group(); arm.name = 'Tentacle_' + (i + 1); character.add(arm); arms.push(arm)
  for (let j = 0; j < 6; j++) {
    const t = .36 + j * .113, p = curve.getPointAt(t), direction = curve.getTangentAt(t)
    const preferred = new THREE.Vector3(i % 2 ? .22 : -.22, -.62, i < 6 ? 1 : -1)
    const outward = preferred.addScaledVector(direction, -preferred.dot(direction)).normalize()
    cupRay.set(p, outward)
    bodyMesh.material.side = THREE.DoubleSide
    const hit = cupRay.intersectObject(bodyMesh, false)[0]
    bodyMesh.material.side = THREE.FrontSide
    if (!hit) throw new Error("Suction cup cannot be placed on body: " + JSON.stringify({i,j,p:p.toArray(),outward:outward.toArray()}))
    if (hit.normal) {
      const normal = hit.normal.clone().normalize(); if (normal.dot(outward) < 0) normal.negate(); outward.copy(normal)
    }
    const center = hit.point.clone().addScaledVector(outward, .009), size = .101 * (1 - t * .20)
    const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), outward)
    const sucker = new THREE.Mesh(suctionGeometry, cupMaterial); sucker.name = `Sucker_${i + 1}_${j + 1}`; sucker.position.copy(center); sucker.quaternion.copy(orientation); sucker.scale.setScalar(size); arm.add(sucker)
  }
}
for (const side of [-1, 1]) {
  const ex = side * .47, ey = 1.36
  const eyeSurface = (x, y) => faceZ(x, y) + .007 + .058 * Math.sqrt(Math.max(0, 1 - ((x - ex) / .252) ** 2 - ((y - ey) / .292) ** 2))
  patch('EyeWhite_' + side, character, cream, ex, ey, .252, .292, eyeSurface)
  const irisMesh = patch('Iris_' + side, character, iris.clone(), ex - side * .025, ey - .008, .228, .279, (x, y) => eyeSurface(x, y) + .003)
  const irisPosition = irisMesh.geometry.getAttribute('position'), irisColors = []
  for (let i = 0; i < irisPosition.count; i++) {
    const amount = Math.max(0, Math.min(1, (ey + .12 - irisPosition.getY(i)) / .4))
    const color = new THREE.Color('#211018').lerp(new THREE.Color('#744155'), amount)
    irisColors.push(color.r, color.g, color.b)
  }
  irisMesh.material.color.set('#ffffff'); irisMesh.material.vertexColors = true; irisMesh.geometry.setAttribute('color', new THREE.Float32BufferAttribute(irisColors, 3))
  const pupilMesh = patch('Pupil_' + side, character, irisMesh.material.clone(), ex - side * .036, ey + .017, .157, .193, (x, y) => eyeSurface(x, y) + .006)
  const pupilPosition = pupilMesh.geometry.getAttribute('position'), pupilColors = []
  for (let i = 0; i < pupilPosition.count; i++) {
    const x = pupilPosition.getX(i), y = pupilPosition.getY(i), radius = Math.min(1, Math.hypot((x - ex + side * .036) / .157, (y - ey - .017) / .193))
    const irisColor = new THREE.Color('#211018').lerp(new THREE.Color('#744155'), Math.max(0, Math.min(1, (ey + .12 - y) / .4)))
    const color = irisColor.lerp(new THREE.Color('#10060d'), Math.pow(1 - radius * radius, 1.3) * .98)
    pupilColors.push(color.r, color.g, color.b)
  }
  pupilMesh.geometry.setAttribute('color', new THREE.Float32BufferAttribute(pupilColors,3))
  patch('BigSparkle_' + side, character, light, ex + .046, ey + .157, .042, .045, (x, y) => eyeSurface(x, y) + .011, 32, 8)
  patch('BlueSparkle_' + side, character, blue, ex - .062, ey + .076, .022, .025, (x, y) => eyeSurface(x, y) + .012, 24, 6)
  patch('PinkSparkle_' + side, character, eyePink, ex + .131, ey - .144, .025, .031, (x, y) => eyeSurface(x, y) + .012, 24, 6)
  // The reference's burgundy upper lid and outward lashes sit directly against the eye contour.
  const lashPoints = Array.from({ length: 15 }, (_, j) => { const a = .10 + j / 14 * (Math.PI - .20), x = ex + Math.cos(a) * .251, y = ey + Math.sin(a) * .293; return new THREE.Vector3(x, y, eyeSurface(x, y) + .008) })
  const lid = new THREE.Mesh(taperedTube(new THREE.CatmullRomCurve3(lashPoints), 38, 8, t => .003 + .012 * Math.sin(t * Math.PI)), lashMat); lid.name = 'UpperLid_' + side; character.add(lid)
  for (let j = 0; j < 2; j++) {
    const x = ex + side * (.225 - j * .034), y = ey + .09 + j * .065
    const lash = new THREE.CatmullRomCurve3([new THREE.Vector3(x, y, eyeSurface(x, y) + .01), new THREE.Vector3(x + side * .046, y + .002, faceZ(x + side * .046, y) + .018), new THREE.Vector3(x + side * .079, y + .041, faceZ(x + side * .079, y + .041) + .014)])
    const mesh = new THREE.Mesh(taperedTube(lash, 22, 8, t => .018 * (1 - t) + .001), lashMat); mesh.name = `Eyelash_${side}_${j}`; character.add(mesh)
  }
  const bx = side * .48, by = 1.85
  const eyebrow = new THREE.Shape().moveTo(bx - .115, by - .023).bezierCurveTo(bx - .047, by + .112, bx + .067, by + .115, bx + .12, by + .045).bezierCurveTo(bx + .142, by + .014, bx + .082, by + .023, bx + .055, by + .026).bezierCurveTo(bx - .01, by + .035, bx - .065, by + .015, bx - .115, by - .023)
  shapedPatch('Eyebrow_' + side, character, blush, eyebrow, (x, y) => faceZ(x, y) + .003)
  for (let j = 0; j < 3; j++) {
    const x = side * (.58 + j * .054), y = 1.072 + j * .016
    patch(`CheekDetail_${side}_${j}`, character, blush, x, y, .014, .043 - j * .002, (x, y) => faceZ(x, y) + .003, 20, 6)
  }
}
const mouth = new THREE.Group(); mouth.name = 'Mouth'; mouth.position.set(0, 1.145, faceZ(0, 1.145) + .035); mouth.rotation.x = .32; character.add(mouth)
const smile = new THREE.Shape().moveTo(-.148, .015).bezierCurveTo(-.095, -.035, .08, -.025, .144, .051).bezierCurveTo(.156, -.142, -.094, -.172, -.148, .015)
const smileMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(smile, { depth: .012, bevelEnabled: true, bevelThickness: .003, bevelSize: .003, bevelSegments: 2, steps: 1, curveSegments: 24 }), mouthMat); smileMesh.name = 'SmileInterior'; mouth.add(smileMesh)
ellipsoid('Tongue', mouth, tongueMat, [.008, -.079, .018], [.084, .045, .006])
const jewelY = 2.077, jewelZ = faceZ(0, jewelY), jewelAngle = -.35
const jewelRing = new THREE.Mesh(new THREE.TorusGeometry(.128, .019, 12, 48), ringMat); jewelRing.name = 'AILightRing'; jewelRing.position.set(0, jewelY, jewelZ + .008); jewelRing.rotation.x = jewelAngle; character.add(jewelRing)
const jewel = ellipsoid('AILight', character, blue, [0, jewelY, jewelZ + .016], [.116, .119, .044]); jewel.rotation.x = jewelAngle
ellipsoid('AILightSparkle', character, light, [.031, jewelY + .045, jewelZ + .055], [.024, .025, .005])

const tracks = [new THREE.VectorKeyframeTrack('PinkOctopus.position', [0, 2, 4, 6], [0, 0, 0, 0, .032, 0, 0, -.009, 0, 0, 0, 0])]
function addSkinTexture(source) {
  const width = 256, raw = Buffer.alloc((width * 4 + 1) * width)
  let seed = 831205
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const nx = (seed / 4294967296 - .5) * .48
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const ny = (seed / 4294967296 - .5) * .48
    raw[offset] = Math.round((nx + 1) * 127.5); raw[offset + 1] = Math.round((ny + 1) * 127.5); raw[offset + 2] = Math.round((Math.sqrt(1 - nx * nx - ny * ny) + 1) * 127.5); raw[offset + 3] = 255
  }
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) { c ^= b; for(let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0) } return (c ^ 0xffffffff) >>> 0 }
  const chunk = (name, data) => { const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type, data]))); return Buffer.concat([length, type, data, checksum]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width,0); ihdr.writeUInt32BE(width,4); ihdr[8] = 8; ihdr[9] = 6
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT',deflateSync(raw)), chunk('IEND',Buffer.alloc(0))])
  const original = Buffer.from(source), jsonLength = original.readUInt32LE(12), json = JSON.parse(original.subarray(20,20 + jsonLength).toString('utf8'))
  const binOffset = 20 + jsonLength, bin = original.subarray(binOffset + 8,binOffset + 8 + original.readUInt32LE(binOffset))
  const imageView = json.bufferViews.length; json.bufferViews.push({buffer:0,byteOffset:bin.length,byteLength:png.length})
  json.images = [{bufferView:imageView,mimeType:'image/png',name:'Procedural skin microtexture'}]; json.samplers = [{magFilter:9729,minFilter:9987,wrapS:10497,wrapT:10497}]; json.textures = [{sampler:0,source:0}]
  const skin = json.materials.find(material => material.name === 'OctopusSkin'); if (!skin) throw new Error('Missing skin material')
  skin.normalTexture = {index:0,scale:.21}; json.buffers[0].byteLength = bin.length + png.length
  const jsonBytes = Buffer.from(JSON.stringify(json)), jsonPadded = Buffer.concat([jsonBytes,Buffer.alloc((4 - jsonBytes.length % 4) % 4,32)])
  const binPadded = Buffer.concat([bin,png,Buffer.alloc((4 - png.length % 4) % 4)])
  const result = Buffer.alloc(12 + 8 + jsonPadded.length + 8 + binPadded.length); result.writeUInt32LE(0x46546c67,0); result.writeUInt32LE(2,4); result.writeUInt32LE(result.length,8)
  result.writeUInt32LE(jsonPadded.length,12); result.writeUInt32LE(0x4e4f534a,16); jsonPadded.copy(result,20)
  const next = 20 + jsonPadded.length; result.writeUInt32LE(binPadded.length,next); result.writeUInt32LE(0x004e4942,next + 4); binPadded.copy(result,next + 8)
  return result.buffer.slice(result.byteOffset,result.byteOffset + result.length)
}
const idle = new THREE.AnimationClip('GentleSwim', 6, tracks)
let bytes = await new GLTFExporter().parseAsync(scene, { binary: true, animations: [idle], trs: true, copyright: 'DailyWorkMate Pink AI Octopus' })
if (!(bytes instanceof ArrayBuffer)) throw new Error('Expected binary GLB')
bytes = addSkinTexture(bytes)
const destinations = ['src/renderer/src/assets/companion/pink-ai-octopus.glb', 'deliverables/pink-ai-octopus.glb']
for (const file of destinations) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), Buffer.from(bytes)) }
let meshes = 0; character.traverse(object => { if (object.isMesh) meshes++ })
await writeFile(path.join(root, 'deliverables/pink-ai-octopus-model.json'), JSON.stringify({ revision: 2, format: 'glTF 2.0 binary', bytes: bytes.byteLength, meshes, tentacles: 8, suctionCups: 48, animations: ['GentleSwim'], textures: 1, externalResources: 0, source: 'scripts/generate-octopus-model.mjs', reference: 'src/renderer/src/assets/companion/pink-ai-octopus.png' }, null, 2))
console.log(JSON.stringify({ bytes: bytes.byteLength, meshes, exported: destinations }))
