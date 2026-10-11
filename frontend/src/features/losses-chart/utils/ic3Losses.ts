export const IC3_SOURCE = {
  title: '2025 IC3 Annual Report',
  publisher: 'Federal Bureau of Investigation, Internet Crime Complaint Center (IC3)',
  url: 'https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf',
  pages: 'pp. 4 and 6',
} as const;

export interface YearLoss {
  year: number;
  usdBillions: number; // as printed in the report
}

export const LOSSES: readonly YearLoss[] = [
  { year: 2020, usdBillions: 4.2 },
  { year: 2021, usdBillions: 6.9 },
  { year: 2022, usdBillions: 10.3 },
  { year: 2023, usdBillions: 12.5 },
  { year: 2024, usdBillions: 16.6 },
  { year: 2025, usdBillions: 20.877 },
];

// Context for the subtitle: the first year IC3 (then IFCC) reported, from the same page 4 chart.
export const FIRST_YEAR = { year: 2001, usdMillions: 17.8 } as const;
