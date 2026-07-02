// Renders resources/icons/icon.svg into the multi-size .ico the installer
// and window chrome use.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = path.join(root, 'resources', 'icons', 'icon.svg')
const icoPath = path.join(root, 'resources', 'icons', 'icon.ico')

if (existsSync(icoPath) && !process.argv.includes('--force')) {
  console.log('[icon] icon.ico already present')
  process.exit(0)
}

const svg = readFileSync(svgPath, 'utf8')
const pngs = []
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
  const png = resvg.render().asPng()
  pngs.push(Buffer.from(png))
  if (size === 256) {
    writeFileSync(path.join(root, 'resources', 'icons', 'icon-256.png'), Buffer.from(png))
  }
}
const ico = await pngToIco(pngs)
writeFileSync(icoPath, ico)
console.log(`[icon] wrote ${icoPath}`)
