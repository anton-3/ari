// The isometric look is now the main map (src/graph). This keeps
// looks.html?look=isometric working as a thin re-export.
export { default } from '../../graph/Graph'

export const meta = {
  title: 'Isometric (main map)',
  inspiration: 'Cloudcraft-style isometric AWS architecture diagrams: grey blocks with service icons on a blueprint iso grid, grid-routed cables',
}
