/** 注册 dev-only 的 `@deepseek-ai/*` 解析钩子。用法：node --import ./test/register.mjs */

import { register } from 'node:module'

register('./resolve-dsh.mjs', import.meta.url)
