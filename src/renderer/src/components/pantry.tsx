/** Small pieces of the Pantry look that several screens share. */
import { CheckIcon, LockIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** A honey-tinted pill stating the privacy promise in a sentence. */
export function PrivacyNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('flex w-fit items-center gap-2 rounded-full bg-brand-soft py-1.5 pr-3 pl-2.5 text-[13px] font-medium text-brand-text', className)}>
      <LockIcon className="size-3.5 shrink-0" strokeWidth={2.2} />
      {children}
    </p>
  )
}

/** A filled honey check with a mono label: "Installed", "Allowed", "Ready". */
export function DoneMark({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-brand-text">
      <span className="flex size-4 items-center justify-center rounded-full bg-brand text-brand-foreground">
        <CheckIcon className="size-2.5" strokeWidth={3.5} />
      </span>
      {label}
    </span>
  )
}
