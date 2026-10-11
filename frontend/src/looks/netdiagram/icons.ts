// Device symbols in the spirit of the Cisco network-topology icon set
// (isometric slabs for network appliances, towers for servers, a cylinder for
// the database, a cloud for the internet, workstations for clients).
// One geometry, two renderers: Path2D on the map canvas and <path> in the
// stencil / legend SVGs. Coordinates are centred on (0,0) in a 64×52 box.

export type Fill = 'face' | 'side' | 'paper' | 'ink' | 'none'
export interface Part {
  d: string
  fill: Fill
  stroke?: boolean // default true
}

const tower = (dx = 0): Part[] => [
  { d: `M${-12 + dx},-18 l8,-6 h20 l-8,6 Z`, fill: 'face' },
  { d: `M${8 + dx},-18 l8,-6 v40 l-8,6 Z`, fill: 'side' },
  { d: `M${-12 + dx},-18 h20 v40 h-20 Z`, fill: 'paper' },
  { d: `M${-8 + dx},-12 h12 M${-8 + dx},-8 h12 M${-8 + dx},-4 h12`, fill: 'none' },
]

const slab = (h: number): Part[] => [
  { d: `M-24,-6 L-12,-15 L26,-15 L14,-6 Z`, fill: 'face' },
  { d: `M14,-6 L26,-15 v${h} L14,${-6 + h} Z`, fill: 'side' },
  { d: `M-24,-6 h38 v${h} h-38 Z`, fill: 'paper' },
]

export const ICONS: Record<string, Part[]> = {
  internet: [
    {
      d: 'M-20,12 C-31,12 -31,-1 -21,-2 C-22,-14 -6,-17 -1,-9 C3,-19 21,-17 20,-5 C30,-5 31,12 20,12 Z',
      fill: 'face',
    },
  ],
  // traffic generator = client workstation
  traffic: [
    { d: 'M-16,-22 h30 v22 h-30 Z', fill: 'paper' },
    { d: 'M-12,-18 h22 v14 h-22 Z', fill: 'face' },
    { d: 'M-4,0 h6 l2,5 h-10 Z', fill: 'side' },
    { d: 'M-22,10 h32 l7,7 h-32 Z', fill: 'face' },
    { d: 'M-15,13.5 h28', fill: 'none' },
  ],
  // load balancer: content-switch slab with one flow fanning out to three
  lb: [
    ...slab(14),
    { d: 'M-20,1 h9 M-11,1 l9,-4 h4 M-11,1 h13 M-11,1 l9,4 h4', fill: 'none' },
    { d: 'M2,-5 l3,2 l-3,2 Z M6,-1 l3,2 l-3,2 Z M2,3 l3,2 l-3,2 Z', fill: 'ink', stroke: false },
  ],
  app: [...tower(), { d: 'M-2,14 m-1.6,0 a1.6,1.6 0 1 0 3.2,0 a1.6,1.6 0 1 0 -3.2,0', fill: 'ink', stroke: false }],
  // worker: server with a cycle mark (background job)
  worker: [
    ...tower(),
    { d: 'M-7,10 a5,5 0 1 1 3,4.6', fill: 'none' },
    { d: 'M-5.6,15.6 l2,-3.2 l1.8,3.4 Z', fill: 'ink', stroke: false },
  ],
  db: [
    { d: 'M-18,-14 v26 a18,6 0 0 0 36,0 v-26', fill: 'paper' },
    { d: 'M-18,-14 a18,6 0 1 0 36,0 a18,6 0 1 0 -36,0 Z', fill: 'face' },
    { d: 'M-18,-3 a18,6 0 0 0 36,0', fill: 'none' },
  ],
  // cache: appliance slab with a lightning bolt (content/cache engine)
  cache: [
    ...slab(14),
    { d: 'M-3,-4 l-6,6.5 h4.5 l-3,5.5 l8,-7 h-4.5 l3.5,-5 Z', fill: 'ink', stroke: false },
    { d: 'M5,-2 h5 M5,2 h5', fill: 'none' },
  ],
  // controller: operator laptop with a prompt
  controller: [
    { d: 'M-15,-20 h30 v21 h-30 Z', fill: 'paper' },
    { d: 'M-11,-16 h22 v13 h-22 Z', fill: 'face' },
    { d: 'M-7,-13 l4,3 l-4,3 M-1,-7 h6', fill: 'none' },
    { d: 'M-15,1 h30 l6,8 h-42 Z', fill: 'side' },
  ],
}

export const GENERIC: Part[] = [
  { d: 'M-18,-14 h36 v28 h-36 Z', fill: 'paper' },
  { d: 'M-12,-6 h24 M-12,0 h24 M-12,6 h24', fill: 'none' },
]

export const iconFor = (role: string): Part[] => ICONS[role] ?? GENERIC

// Drawing half-extents used for link attachment (world px).
// symbols are drawn at ICON_SCALE on the map
export const ICON_SCALE = 1.45
export const ICON_HW = 36
export const ICON_HH = 34

const pathCache = new Map<string, Path2D>()
export function path2d(d: string): Path2D {
  let p = pathCache.get(d)
  if (!p) {
    p = new Path2D(d)
    pathCache.set(d, p)
  }
  return p
}
