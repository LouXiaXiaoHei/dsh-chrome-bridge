#!/usr/bin/env node
/**
 * 把 extension/ 打成可以直接在 chrome://extensions 里「加载已解压的扩展程序」
 * 使用的 zip，并生成 sha256 校验文件和 Release 说明。
 *
 * 用法：
 *   node scripts/pack-extension.mjs
 *   node scripts/pack-extension.mjs --version 0.2.0   # 发布前校验版本与 manifest 一致
 *
 * 产物都放在 dist/ 下，不提交到仓库。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionDir = path.join(root, 'extension')
const distDir = path.join(root, 'dist')

const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`读不了 ${path.relative(root, file)}：${error.message}`)
  }
}

const args = process.argv.slice(2)
const versionIndex = args.indexOf('--version')
const versionArg = versionIndex === -1 ? null : args[versionIndex + 1]
if (versionIndex !== -1 && !versionArg) fail('--version 后面要跟版本号')

const manifest = readJson(path.join(extensionDir, 'manifest.json'))
const pkg = readJson(path.join(root, 'package.json'))

if (manifest.manifest_version !== 3) {
  fail(`manifest_version 应为 3，实际是 ${manifest.manifest_version}`)
}
if (typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/u.test(manifest.version)) {
  fail(`extension/manifest.json 的 version 不合法：${JSON.stringify(manifest.version)}`)
}

const version = manifest.version
if (versionArg && versionArg.replace(/^v/u, '') !== version) {
  fail(`版本不一致：发布版本是 ${versionArg}，extension/manifest.json 是 ${version}`)
}
if (pkg.version !== version) {
  console.warn(`! package.json 版本是 ${pkg.version}，扩展版本是 ${version}；发布以扩展版本为准`)
}

// manifest 引用的图标都要在包里，否则 Chrome 会拒绝加载
const icons = new Set([
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
])
const required = ['manifest.json', 'background.js', 'popup.html', 'popup.js', ...icons]
for (const file of required) {
  if (!existsSync(path.join(extensionDir, file))) fail(`扩展缺文件：extension/${file}`)
}

const zipName = `dsh-chrome-tab-extension-v${version}.zip`
const zipPath = path.join(distDir, zipName)
mkdirSync(distDir, { recursive: true })
rmSync(zipPath, { force: true })
rmSync(path.join(distDir, `${zipName}.sha256`), { force: true })

// -X 去掉额外的文件属性，-x 清掉 .DS_Store；zip 内的根就是 manifest.json
const zipped = spawnSync('zip', ['-r', '-X', zipPath, '.', '-x', '*.DS_Store'], {
  cwd: extensionDir,
  encoding: 'utf8',
})
if (zipped.error) fail(`调不起 zip 命令：${zipped.error.message}`)
if (zipped.status !== 0) fail(`zip 打包失败：${zipped.stderr || zipped.stdout}`)

const bytes = readFileSync(zipPath)
const sha256 = createHash('sha256').update(bytes).digest('hex')
writeFileSync(path.join(distDir, `${zipName}.sha256`), `${sha256}  ${zipName}\n`)

const repo = process.env.GITHUB_REPOSITORY ?? 'LouXiaXiaoHei/dsh-chrome-bridge'
const notes = `## DSH Chrome Tab Bridge 扩展 v${version}

配套 DSH 插件使用的 Chrome MV3 扩展，不需要 Chrome 应用商店，下载解压即可加载。

### 安装

1. 下载附件 \`${zipName}\` 并解压。
2. 安装 Harness 插件：\`dsh plugin --profile desktop add github:${repo}\`（桌面版也可以在「设置 → 插件」里安装）。
3. 打开 \`chrome://extensions\`，右上角打开「开发者模式」，点「加载已解压的扩展程序」，选择解压出来的目录（目录里能看到 \`manifest.json\`）。
4. 保持 Chrome 打开，在对话里用 \`@\` 选择标签页。

### 更新

解压新版本覆盖原目录，然后回 \`chrome://extensions\` 点该扩展的刷新图标。

### 校验下载

\`\`\`sh
shasum -a 256 -c ${zipName}.sha256
\`\`\`

> 扩展不用填端口：每 30 秒探测 \`30795\`–\`30805\`，自动连上启动时间最新的桥接服务。
`
writeFileSync(path.join(distDir, 'RELEASE_NOTES.md'), notes)

const size = `${(bytes.length / 1024).toFixed(1)} KB`
console.log(`✓ ${zipName}（${size}）`)
console.log(`  sha256 ${sha256}`)
console.log(`  说明   dist/RELEASE_NOTES.md`)
