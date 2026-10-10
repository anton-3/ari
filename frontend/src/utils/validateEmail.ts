const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateEmail(value: string) {
  return EMAIL.test(value.trim())
}
