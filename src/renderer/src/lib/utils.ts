import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const isMac = navigator.userAgent.includes('Macintosh')
/** Running from source: the git branch ('' when unknown). Null in installed builds. Set by WindowManager.load(). */
export const devBranch = new URLSearchParams(location.search).get('dev')
/** "Mac" or "computer", for copy like "on this Mac". */
export const machine = isMac ? 'Mac' : 'computer'
