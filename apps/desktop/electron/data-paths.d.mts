export function platformDefaultHermesHome(
  home: string,
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): string

export function resolveDesktopUserData(defaultPath: string, env?: NodeJS.ProcessEnv): string

export interface HermesHomeOptions {
  home: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  directoryExists?: (directory: string) => boolean
  readWindowsHome?: () => string | null
  /** Replaces upstream's platform default (`~/.hermes`) when no explicit
   *  HERMES_HOME / HERMES_DESKTOP_USER_DATA_DIR is set. The enterprise fork
   *  passes its own home here. */
  defaultHome?: string | null
}

export function resolveDesktopHermesHome(options: HermesHomeOptions): string
