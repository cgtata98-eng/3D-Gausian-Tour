import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// The design system. Imported after the reset so its element-level defaults
// for form controls win, and before any screen so screens can only add layout.
import './ui/design-system.css'
import App from './App.tsx'
import { installRangeFill } from './ui/range-fill'
import { installGlassDrag } from './ui/glass-drag'

// Keeps the filled portion of every range slider in step with its value.
// Installed once, globally, because the sliders live across many screens and
// a native range gives no filled region of its own.
installRangeFill()
// Press-and-hold lifts a glass surface and lets it be carried. Global for the
// same reason: it belongs to being a surface, not to any one screen.
installGlassDrag()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
