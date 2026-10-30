export {}

declare global {
  interface Window {
    __ModuleLoader__?: {
      load(definition: {
        id: string
        factory: (require: (specifier: string) => unknown) => unknown
      }): void
    }
  }
}
