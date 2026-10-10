// Scrolls to the element with the given id without touching the URL.
// Smooth unless the user prefers reduced motion.
export function scrollToSection(id: string, block: ScrollLogicalPosition = 'start') {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  document.getElementById(id)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block })
}
