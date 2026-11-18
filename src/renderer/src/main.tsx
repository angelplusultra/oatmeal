import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './globals.css'
import { App } from './App'
import { followSystemTheme } from './lib/theme'
import { devBranch, isMac } from './lib/utils'

followSystemTheme()
document.documentElement.dataset.platform = isMac ? 'mac' : 'other'
if (devBranch !== null) document.title = 'Oatmeal (dev)'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
