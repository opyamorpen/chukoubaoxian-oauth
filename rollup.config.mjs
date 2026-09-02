import replace from '@rollup/plugin-replace'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginYamlPath = join(__dirname, 'config', 'plugin.yaml')
const pluginConfig = load(readFileSync(pluginYamlPath, 'utf8'))
const version = pluginConfig?.service?.version ?? ''
const moduleAboutBlankIDArray =
  pluginConfig?.modules
    ?.filter((module) => module?.moduleType === 'about:blank')
    ?.map((module) => module?.id)
    ?.filter((id) => id != null && id !== '') ?? []

/**
 * @param {import('rollup').RollupOptions} config
 * @param {import('@ones-op/rc-cli').RollupConfigPipelineContext} context
 * @returns {import('rollup').RollupOptions}
 */
export default function defineRollupConfig(config, context) {
  // console.log('--------------------------------')
  // console.log('defineRollupConfig')
  // console.log('config', config)
  // console.log('context', context)
  // console.log('--------------------------------')
  const plugins = config.plugins || []
  config.plugins = [
    replace({
      preventAssignment: true,
      'process.env.BACKEND_CUSTOM_VALUE': JSON.stringify('backend-custom-value'),
      'process.env.VERSION': JSON.stringify(version),
      'process.env.MODULE_ABOUT_BLANK_ID_ARRAY': JSON.stringify(moduleAboutBlankIDArray),
    }),
    ...plugins,
  ]
  return config
}
