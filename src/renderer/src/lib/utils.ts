import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const isMac = navigator.userAgent.includes('Macintosh')
/** "Mac" or "computer", for copy like "on this Mac". */
export const machine = isMac ? 'Mac' : 'computer'
