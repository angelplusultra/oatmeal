const REPO = 'angelplusultra/oatmeal'
export const repoUrl = `https://github.com/${REPO}`
export const releasesUrl = `${repoUrl}/releases`

export interface Asset {
  name: string
  url: string
  /** "112 MB" */
  size: string
}

export interface Release {
  version: string
  mac?: Asset
  pacman?: Asset
  appImage?: Asset
}

interface GhRelease {
  tag_name: string
  draft: boolean
  assets: { name: string; browser_download_url: string; size: number }[]
}

let cached: Promise<Release | null> | undefined

/**
 * The newest release, pre-releases included (GitHub's /releases/latest skips those). Runs at build time only, so
 * visitors never talk to GitHub. On failure the download buttons fall back to the releases page.
 */
export function getRelease(): Promise<Release | null> {
  cached ??= load()
  return cached
}

async function load(): Promise<Release | null> {
  try {
    const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers })
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`)
    const release = ((await res.json()) as GhRelease[]).find((r) => !r.draft)
    if (!release) return null
    const find = (suffix: string): Asset | undefined => {
      const a = release.assets.find((a) => a.name.endsWith(suffix))
      return a && { name: a.name, url: a.browser_download_url, size: `${Math.round(a.size / 1e6)} MB` }
    }
    return {
      version: release.tag_name.replace(/^v/, ''),
      mac: find('-arm64.dmg'),
      pacman: find('.pacman'),
      appImage: find('.AppImage'),
    }
  } catch (err) {
    // Never deploy a download page without download links.
    if (process.env.CI) throw err
    console.warn(`[release] ${err}. Download links will point at the releases page.`)
    return null
  }
}
