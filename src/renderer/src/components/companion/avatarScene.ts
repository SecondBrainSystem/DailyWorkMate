import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { validateAvatarModel } from '../../../../shared/avatarModel'
import type { AvatarState } from '@shared/companion'

export interface AvatarSceneHandle { dispose(): void; rotate(x: number, y: number): void; reset(): void; render(): void }
export interface AvatarSceneOptions {
  state?: () => AvatarState
  level?: () => number
  onError?: (message: string) => void
  animate?: boolean
}

function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>()
  root.traverse(object => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) materials.add(material)
  })
  for (const material of materials) for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
  for (const texture of textures) {
    const bitmap = texture.source?.data
    if (typeof ImageBitmap !== 'undefined' && bitmap instanceof ImageBitmap) bitmap.close()
    texture.dispose()
  }
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
}

/** Parses validated, self-contained bytes. The loader cannot contact external resources. */
export async function mountAvatarScene(host: HTMLElement, bytes: Uint8Array, options: AvatarSceneOptions = {}): Promise<AvatarSceneHandle> {
  validateAvatarModel(bytes)
  const manager = new THREE.LoadingManager()
  manager.setURLModifier(url => {
    // GLTFLoader creates these object URLs itself for embedded image bufferViews.
    if (url.startsWith('blob:')) return url
    throw new Error('3D 模型包含未允许的外部资源')
  })
  const gltf = await new GLTFLoader(manager).parseAsync(bytes.slice().buffer as ArrayBuffer, '')
  let renderer: THREE.WebGLRenderer
  try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }) }
  catch { for (const scene of gltf.scenes) disposeObject(scene); throw new Error('当前设备无法启用 WebGL，已显示 2D 形象') }
  const scene = new THREE.Scene()
  const pivot = new THREE.Group(); pivot.add(gltf.scene); scene.add(pivot)
  const box = new THREE.Box3().setFromObject(gltf.scene)
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3())
  const largest = Math.max(size.x, size.y, size.z)
  if (!Number.isFinite(largest) || largest <= 0 || !Number.isFinite(center.length())) { disposeObject(gltf.scene); renderer.dispose(); throw new Error('3D 模型没有可显示的几何形体') }
  const scale = 2.72 / largest
  gltf.scene.scale.multiplyScalar(scale); gltf.scene.position.sub(center.multiplyScalar(scale))
  const camera = new THREE.PerspectiveCamera(33, 1, .1, 30)
  camera.position.set(0, .15, 5.45); camera.lookAt(0, 0, 0)
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .98
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;outline:none'
  renderer.domElement.setAttribute('aria-hidden', 'true')
  const environmentScene = new RoomEnvironment()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const environment = pmrem.fromScene(environmentScene, .04)
  scene.environment = environment.texture
  scene.environmentIntensity = .38
  environmentScene.dispose(); pmrem.dispose()
  scene.add(new THREE.HemisphereLight(0xfff5ef, 0xdba0ad, .85))
  const key = new THREE.DirectionalLight(0xfff4ed, 1.85); key.position.set(-3, 4, 5); scene.add(key)
  const rim = new THREE.DirectionalLight(0xe8f8ff, .8); rim.position.set(3, 2, -2); scene.add(rim)
  const fill = new THREE.DirectionalLight(0xfff5f0, .65); fill.position.set(2, -.4, 4); scene.add(fill)
  const mixer = new THREE.AnimationMixer(gltf.scene)
  if (gltf.animations[0]) mixer.clipAction(gltf.animations[0]).play()
  const mouth = gltf.scene.getObjectByName('Mouth')
  const mouthScale = mouth?.scale.clone()
  const light = gltf.scene.getObjectByName('AILight') as THREE.Mesh | undefined
  const lightMaterial = light?.material instanceof THREE.MeshStandardMaterial ? light.material : undefined
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const referencePose = gltf.scene.getObjectByName('PinkOctopus')?.userData.revision === 2
  const initialYaw = referencePose ? .28 : -.16, roll = referencePose ? .11 : 0
  let disposed = false, frame = 0, previous = performance.now(), lastDraw = 0, visible = true, yaw = initialYaw, pitch = 0
  const render = () => { if (!disposed) { pivot.rotation.set(pitch, yaw, roll); renderer.render(scene, camera) } }
  const resize = () => {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight)
    renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); render()
  }
  const resizeObserver = new ResizeObserver(resize)
  const visibility = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true })
  const lost = (event: Event) => { event.preventDefault(); options.onError?.('3D 显示暂时中断，已显示 2D 形象') }
  renderer.domElement.addEventListener('webglcontextlost', lost)
  host.append(renderer.domElement); resizeObserver.observe(host); visibility.observe(host); resize()
  const loop = (time: number) => {
    if (disposed) return
    frame = requestAnimationFrame(loop)
    if (document.hidden || !visible || time - lastDraw < 33) { previous = time; return }
    const delta = Math.min(.08, Math.max(0, (time - previous) / 1000)); previous = time; lastDraw = time
    const state = options.state?.() || 'idle', level = Math.max(0, Math.min(1, options.level?.() || 0))
    if (!reduced.matches) mixer.update(delta * (state === 'working' ? 1.45 : 1))
    if (mouth && mouthScale) mouth.scale.set(mouthScale.x, mouthScale.y * (state === 'speaking' ? 1 + level * .72 + Math.sin(time / 95) * .13 : 1), mouthScale.z)
    if (lightMaterial) lightMaterial.emissiveIntensity = state === 'listening' ? 1.35 : state === 'thinking' ? .75 + Math.sin(time / 350) * .3 : .72
    render()
  }
  if (options.animate !== false) frame = requestAnimationFrame(loop)
  return {
    rotate(x, y) { yaw += x; pitch = THREE.MathUtils.clamp(pitch + y, -.55, .55); render() },
    reset() { yaw = initialYaw; pitch = 0; render() }, render,
    dispose() {
      if (disposed) return
      disposed = true; cancelAnimationFrame(frame); resizeObserver.disconnect(); visibility.disconnect()
      renderer.domElement.removeEventListener('webglcontextlost', lost)
      mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene)
      for (const assetScene of gltf.scenes) disposeObject(assetScene)
      environment.dispose(); scene.clear(); renderer.renderLists.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove()
    },
  }
}
