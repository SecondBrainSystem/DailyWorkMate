/** Self-contained GLB 2.0 avatars. Used before import and again before rendering. */
export const AVATAR_MODEL_MAX_BYTES = 15 * 1024 * 1024
const extensions = new Set(['KHR_materials_unlit', 'KHR_materials_clearcoat', 'KHR_materials_emissive_strength',
  'KHR_materials_ior', 'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_transmission',
  'KHR_materials_volume', 'KHR_texture_transform', 'KHR_mesh_quantization'])
const invalid = (detail: string): never => { throw new Error('无法加载 3D 形象 / Invalid 3D avatar: ' + detail) }
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('malformed GLB data')
  return value as Record<string, any>
}
const integer = (value: unknown, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) return invalid('invalid buffer or geometry size')
  return value as number
}
const list = (value: unknown, limit: number): any[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) return invalid('model is too complex')
  return value
}

function textureSize(image: Uint8Array, mime: string): [number, number] {
  const data = new DataView(image.buffer, image.byteOffset, image.byteLength)
  if (mime === 'image/png') {
    if (image.length < 24 || data.getUint32(0) !== 0x89504e47 || data.getUint32(4) !== 0x0d0a1a0a || data.getUint32(12) !== 0x49484452) invalid('invalid PNG texture')
    return [data.getUint32(16), data.getUint32(20)]
  }
  if (image.length < 4 || data.getUint16(0) !== 0xffd8) invalid('invalid JPEG texture')
  let offset = 2
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  while (offset < image.length) {
    if (image[offset++] !== 0xff) invalid('invalid JPEG marker')
    while (offset < image.length && image[offset] === 0xff) offset++
    const marker = image[offset++]
    if (marker === 0xd9 || marker === 0xda || offset + 2 > image.length) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const length = data.getUint16(offset)
    if (length < 2 || offset + length > image.length) invalid('truncated JPEG texture')
    if (frameMarkers.has(marker)) {
      if (length < 8) invalid('invalid JPEG dimensions')
      return [data.getUint16(offset + 5), data.getUint16(offset + 3)]
    }
    offset += length
  }
  return invalid('JPEG texture has no dimensions')
}

export function validateAvatarModel(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 28 || bytes.byteLength > AVATAR_MODEL_MAX_BYTES) invalid('请选择 15 MiB 以内的 GLB 文件 / choose a GLB file up to 15 MiB')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) invalid('expected a complete GLB 2.0 file')
  let offset = 12
  let document: Record<string, any> | undefined
  let binary: Uint8Array | undefined
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) invalid('truncated GLB chunk')
    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    if (length % 4 || offset + 8 + length > bytes.byteLength) invalid('invalid GLB chunk length')
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)
    if (offset === 12 && type === 0x4e4f534a) {
      if (length > 2 * 1024 * 1024) invalid('GLB metadata exceeds 2 MiB')
      try { document = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chunk))) }
      catch { invalid('invalid GLB JSON') }
    } else if (document && type === 0x004e4942 && !binary) binary = chunk
    else invalid('unsupported or duplicate GLB chunk')
    offset += 8 + length
  }
  const gltf = document || invalid('missing GLB metadata')
  if (record(gltf.asset).version !== '2.0') invalid('only glTF 2.0 is supported')
  const pending: Array<{ value: any; depth: number }> = [{ value: gltf, depth: 0 }]
  let visited = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++visited > 150000 || depth > 128) invalid('model metadata is too complex')
    if (typeof value === 'number' && !Number.isFinite(value)) invalid('non-finite model value')
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'extensions') for (const extension of Object.keys(record(child))) if (!extensions.has(extension)) invalid('unsupported extension: ' + extension)
        pending.push({ value: child, depth: depth + 1 })
      }
    }
  }
  for (const name of [...list(gltf.extensionsRequired, 32), ...list(gltf.extensionsUsed, 32)]) if (!extensions.has(name)) invalid('unsupported extension: ' + name)
  const buffers = list(gltf.buffers, 1)
  for (const buffer of buffers) {
    if (record(buffer).uri !== undefined) invalid('模型必须嵌入所有资源 / external resources are not supported')
    const length = integer(buffer.byteLength, 1)
    if (!binary || length > binary.byteLength || binary.byteLength - length > 3) invalid('invalid embedded buffer')
  }
  const views = list(gltf.bufferViews, 12000)
  for (const value of views) {
    const item = record(value)
    if (item.buffer !== 0 || !buffers.length || integer(item.byteOffset ?? 0) + integer(item.byteLength, 1) > buffers[0].byteLength) invalid('buffer view is out of bounds')
    if (item.byteStride !== undefined && (integer(item.byteStride, 4) > 252 || item.byteStride % 4)) invalid('invalid vertex stride')
  }
  const accessors = list(gltf.accessors, 12000)
  let elements = 0
  for (const value of accessors) {
    const item = record(value)
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 } as Record<string, number>)[item.type]
    const width = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[item.componentType]
    const count = integer(item.count, 1)
    if (!components || !width || count > 1500000 || item.sparse) invalid('unsupported or oversized geometry')
    elements += count * components
    if (elements > 16 * 1024 * 1024) invalid('model geometry exceeds the rendering budget')
    if (item.bufferView !== undefined) {
      const bufferView = views[integer(item.bufferView)] || invalid('invalid accessor buffer view')
      if (integer(item.byteOffset ?? 0) + (count - 1) * (bufferView.byteStride || components * width) + components * width > bufferView.byteLength) invalid('accessor is out of bounds')
    }
  }
  let texturePixels = 0
  for (const value of list(gltf.images, 32)) {
    const item = record(value)
    if (item.uri !== undefined || !['image/png', 'image/jpeg'].includes(item.mimeType)) invalid('textures must be embedded PNG or JPEG images')
    const imageView = views[integer(item.bufferView)] || invalid('invalid embedded image')
    if (!binary) invalid('missing texture data')
    const image = binary!.subarray(imageView.byteOffset ?? 0, (imageView.byteOffset ?? 0) + imageView.byteLength)
    const [width, height] = textureSize(image, item.mimeType)
    if (!width || !height || width > 4096 || height > 4096) invalid('textures must be at most 4096 × 4096')
    texturePixels += width * height
    if (texturePixels > 32 * 1024 * 1024) invalid('textures exceed the rendering budget')
  }
  const meshes = list(gltf.meshes, 2048)
  if (!meshes.length) invalid('model has no meshes')
  let primitives = 0
  for (const mesh of meshes) {
    const parts = list(record(mesh).primitives, 256)
    primitives += parts.length
    if (primitives > 4096 || !parts.length) invalid('model has too many draw calls')
    for (const primitive of parts) {
      const position = accessors[integer(record(primitive.attributes).POSITION)]
      if (!position || position.type !== 'VEC3') invalid('mesh is missing positions')
      if (primitive.indices !== undefined && !accessors[integer(primitive.indices)]) invalid('invalid mesh indices')
      list(primitive.targets, 64)
    }
  }
  const nodes = list(gltf.nodes, 4096)
  const parents = new Set<number>()
  let drawCalls = 0
  for (const value of nodes) {
    const node = record(value)
    if (node.mesh !== undefined) drawCalls += list(record(meshes[integer(node.mesh)]).primitives, 256).length
    if (drawCalls > 8192) invalid('too many mesh instances')
    for (const child of list(node.children, 4096)) {
      integer(child)
      if (parents.has(child)) invalid('a model node must have a single parent')
      parents.add(child)
    }
  }
  const complete = new Set<number>()
  const walk = (id: number, parents: Set<number>) => {
    if (parents.has(id) || parents.size > 128) invalid('cyclic or overly deep node graph')
    if (complete.has(id)) return
    const node = record(nodes[integer(id)])
    if (node.mesh !== undefined && !meshes[integer(node.mesh)]) invalid('invalid node mesh')
    for (const child of list(node.children, 4096)) walk(integer(child), new Set([...parents, id]))
    complete.add(id)
  }
  nodes.forEach((_node, id) => walk(id, new Set()))
  const scenes = list(gltf.scenes, 16)
  if (!scenes.length || !scenes[integer(gltf.scene ?? 0)]) invalid('model has no valid scene')
  for (const value of scenes) {
    const roots = list(record(value).nodes, 4096)
    if (new Set(roots).size !== roots.length || roots.some(id => !nodes[integer(id)] || parents.has(id))) invalid('invalid or duplicate scene roots')
  }
  list(gltf.materials, 512)
  list(gltf.animations, 128)
  list(gltf.skins, 64)
}
