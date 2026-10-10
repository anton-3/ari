export type AuthMode = 'sign-in' | 'sign-up'

export type AuthValues = {
  email: string
  password: string
}

export const submitAuth: (mode: AuthMode, values: AuthValues) => Promise<void> = () =>
  new Promise((resolve) => setTimeout(resolve, 600))
