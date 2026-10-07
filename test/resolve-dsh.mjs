/**
 * Dev-only ESM resolve hook：把本仓库没有本地安装的 `@deepseek-ai/*` 指到已安装
 * 的 DSH 包（锚点是 DSH profile 目录），让插件模块与测试能直接从本仓库运行。
 *
 * 运行时（在 DSH 进程内）不需要它：Loader 自己的解析会找到同样的包。
 * 约定沿用 dsh-plugin-branch 的 test/resolve-dsh.mjs。
 *
 * @module test/resolve-dsh
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** 通过已安装 DSH 包解析的裸标识符。 */
const VIA_PROFILE = [
  /^@deepseek-ai\//
]

const profileDir = process.env.DSH_PROFILE_DIR
  ?? `${process.env.DSH_HOME ?? ''}\\profiles\\desktop`

const anchor = profileDir.endsWith('package.json') ? profileDir : `${profileDir}\\package.json`
const requireFromProfile = createRequire(pathToFileURL(anchor))

/**
 * 优先用 profile 解析 `@deepseek-ai/*`，其余交给默认解析器。
 * @param specifier - 请求的标识符。
 * @param context - 解析上下文。
 * @param nextResolve - 默认解析器。
 * @returns 解析结果。
 */
export async function resolve(specifier, context, nextResolve) {
  if (VIA_PROFILE.some((pattern) => pattern.test(specifier))) {
    try {
      return { url: pathToFileURL(requireFromProfile.resolve(specifier)).href, shortCircuit: true }
    } catch {
      // 落到默认解析器，让正常报错出现。
    }
  }
  return nextResolve(specifier, context)
}
