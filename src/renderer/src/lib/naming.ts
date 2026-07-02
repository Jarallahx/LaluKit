// Output path suggestions: <source dir or default export dir>/<base>.<suffix>.<ext>,
// bumping a counter when the file already exists.

function splitPath(p: string): { dir: string; base: string } {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  const name = p.slice(i + 1)
  const dot = name.lastIndexOf('.')
  return { dir: p.slice(0, i), base: dot > 0 ? name.slice(0, dot) : name }
}

export async function suggestOutput(
  inputPath: string,
  suffix: string,
  ext: string,
  exportDir: string | null
): Promise<string> {
  const { dir, base } = splitPath(inputPath)
  const target = exportDir ?? dir
  const make = (n: number): string =>
    `${target}\\${base}.${suffix}${n > 1 ? `-${n}` : ''}.${ext}`
  for (let n = 1; n < 100; n++) {
    const candidate = make(n)
    if (!(await window.lalu.system.pathExists(candidate))) return candidate
  }
  return make(Math.floor(Math.random() * 100000))
}

export function extOf(p: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(p)
  return m ? m[1].toLowerCase() : ''
}

export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return p.slice(i + 1)
}
