import { Logger } from '@ones-op/node-logger'

// Method called when the team level plugin is being installed.
export async function Install() {
  Logger.info('[sinosure] Install')
}

// Method called when the team level plugin is being launched.
export async function Enable() {
  Logger.info('[sinosure] Enable')
}

// Method called when the team level plugin is being suspended.
export function Disable() {
  Logger.info('[sinosure] Disable')
}

// Method called when the team level plugin is being uninstalled.
export function UnInstall() {
  Logger.info('[sinosure] UnInstall')
}

// Method called when the team level plugin is being upgraded.
export function Upgrade(oldPluginInfo: { version?: string }) {
  Logger.info('[sinosure] Upgrade, old version:', oldPluginInfo?.version)
}
