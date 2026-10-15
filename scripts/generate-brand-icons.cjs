// The SVG is the editable source; emit the application, favicon and Windows multi-size resources.
const fs = require('node:fs')
const path = require('node:path')
const { createCanvas, loadImage } = require('canvas')
const root = path.resolve(__dirname, '..')
;(async () => {
  const source = await loadImage(path.join(root, 'build/brand.svg'))
  const render = size => {
    const canvas = createCanvas(size, size)
    canvas.getContext('2d').drawImage(source, 0, 0, size, size)
    return canvas.toBuffer('image/png')
  }
  for (const name of ['build/icon.png', 'build/icons.png', 'src/renderer/src/assets/icons/icons.png']) fs.writeFileSync(path.join(root, name), render(512))
  fs.mkdirSync(path.join(root, 'src/renderer/public'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src/renderer/public/favicon.png'), render(64))
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const images = sizes.map(render)
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach((bytes, index) => {
    const entry = 6 + index * 16, size = sizes[index]
    header[entry] = header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(bytes.length, entry + 8); header.writeUInt32LE(offset, entry + 12)
    offset += bytes.length
    fs.writeFileSync(path.join(root, `build/icons/${size}x${size}.png`), bytes)
  })
  fs.writeFileSync(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...images]))
  console.log('Generated DailyWorkMate icons from build/brand.svg')
})().catch(error => { console.error(error); process.exitCode = 1 })
