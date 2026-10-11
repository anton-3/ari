// Short form for chart labels: 20.877 -> "$20.9B"
export function formatShort(usdBillions: number) {
  return `$${usdBillions.toFixed(1)}B`
}

// Spelled out and rounded to one decimal, for running text: 20.877 -> "$20.9 billion"
export function formatRounded(usdBillions: number) {
  return `$${usdBillions.toFixed(1)} billion`
}

// Long form as printed in the report: 20.877 -> "$20.877 billion"
export function formatLong(usdBillions: number) {
  return `$${usdBillions} billion`
}

// Millions, as printed for the first year: 17.8 -> "$17.8 million"
export function formatMillions(usdMillions: number) {
  return `$${usdMillions} million`
}

// Change from one value to the next, as a whole percent: (16.6, 20.877) -> 26
export function changePercent(from: number, to: number) {
  return Math.round(((to - from) / from) * 100)
}

// Signed form of the same: (16.6, 20.877) -> "+26%"
export function formatChange(from: number, to: number) {
  const percent = changePercent(from, to)
  return `${percent >= 0 ? '+' : ''}${percent}%`
}
