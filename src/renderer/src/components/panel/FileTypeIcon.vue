<template>
  <img :src="iconUrl" aria-hidden="true" class="block object-contain" draggable="false" />
</template>

<script setup lang="ts">
import audioIcon from 'material-icon-theme/icons/audio.svg?url'
import cIcon from 'material-icon-theme/icons/c.svg?url'
import consoleIcon from 'material-icon-theme/icons/console.svg?url'
import cppIcon from 'material-icon-theme/icons/cpp.svg?url'
import csharpIcon from 'material-icon-theme/icons/csharp.svg?url'
import cssIcon from 'material-icon-theme/icons/css.svg?url'
import databaseIcon from 'material-icon-theme/icons/database.svg?url'
import dockerIcon from 'material-icon-theme/icons/docker.svg?url'
import documentIcon from 'material-icon-theme/icons/document.svg?url'
import fileIcon from 'material-icon-theme/icons/file.svg?url'
import folderAppOpenIcon from 'material-icon-theme/icons/folder-app-open.svg?url'
import folderAppIcon from 'material-icon-theme/icons/folder-app.svg?url'
import folderComponentsOpenIcon from 'material-icon-theme/icons/folder-components-open.svg?url'
import folderComponentsIcon from 'material-icon-theme/icons/folder-components.svg?url'
import folderConfigOpenIcon from 'material-icon-theme/icons/folder-config-open.svg?url'
import folderConfigIcon from 'material-icon-theme/icons/folder-config.svg?url'
import folderDocsOpenIcon from 'material-icon-theme/icons/folder-docs-open.svg?url'
import folderDocsIcon from 'material-icon-theme/icons/folder-docs.svg?url'
import folderGitOpenIcon from 'material-icon-theme/icons/folder-git-open.svg?url'
import folderGitIcon from 'material-icon-theme/icons/folder-git.svg?url'
import folderGithubOpenIcon from 'material-icon-theme/icons/folder-github-open.svg?url'
import folderGithubIcon from 'material-icon-theme/icons/folder-github.svg?url'
import folderImagesOpenIcon from 'material-icon-theme/icons/folder-images-open.svg?url'
import folderImagesIcon from 'material-icon-theme/icons/folder-images.svg?url'
import folderNodeOpenIcon from 'material-icon-theme/icons/folder-node-open.svg?url'
import folderNodeIcon from 'material-icon-theme/icons/folder-node.svg?url'
import folderOpenIcon from 'material-icon-theme/icons/folder-open.svg?url'
import folderPublicOpenIcon from 'material-icon-theme/icons/folder-public-open.svg?url'
import folderPublicIcon from 'material-icon-theme/icons/folder-public.svg?url'
import folderResourceOpenIcon from 'material-icon-theme/icons/folder-resource-open.svg?url'
import folderResourceIcon from 'material-icon-theme/icons/folder-resource.svg?url'
import folderSrcOpenIcon from 'material-icon-theme/icons/folder-src-open.svg?url'
import folderSrcIcon from 'material-icon-theme/icons/folder-src.svg?url'
import folderTestOpenIcon from 'material-icon-theme/icons/folder-test-open.svg?url'
import folderTestIcon from 'material-icon-theme/icons/folder-test.svg?url'
import folderVscodeOpenIcon from 'material-icon-theme/icons/folder-vscode-open.svg?url'
import folderVscodeIcon from 'material-icon-theme/icons/folder-vscode.svg?url'
import folderIcon from 'material-icon-theme/icons/folder.svg?url'
import gitIcon from 'material-icon-theme/icons/git.svg?url'
import goIcon from 'material-icon-theme/icons/go.svg?url'
import htmlIcon from 'material-icon-theme/icons/html.svg?url'
import imageIcon from 'material-icon-theme/icons/image.svg?url'
import javaIcon from 'material-icon-theme/icons/java.svg?url'
import javascriptIcon from 'material-icon-theme/icons/javascript.svg?url'
import jsonIcon from 'material-icon-theme/icons/json.svg?url'
import licenseIcon from 'material-icon-theme/icons/license.svg?url'
import lockIcon from 'material-icon-theme/icons/lock.svg?url'
import logIcon from 'material-icon-theme/icons/log.svg?url'
import markdownIcon from 'material-icon-theme/icons/markdown.svg?url'
import npmIcon from 'material-icon-theme/icons/npm.svg?url'
import pdfIcon from 'material-icon-theme/icons/pdf.svg?url'
import phpIcon from 'material-icon-theme/icons/php.svg?url'
import pnpmIcon from 'material-icon-theme/icons/pnpm.svg?url'
import powerpointIcon from 'material-icon-theme/icons/powerpoint.svg?url'
import pythonIcon from 'material-icon-theme/icons/python.svg?url'
import reactIcon from 'material-icon-theme/icons/react.svg?url'
import reactTsIcon from 'material-icon-theme/icons/react_ts.svg?url'
import readmeIcon from 'material-icon-theme/icons/readme.svg?url'
import rubyIcon from 'material-icon-theme/icons/ruby.svg?url'
import rustIcon from 'material-icon-theme/icons/rust.svg?url'
import settingsIcon from 'material-icon-theme/icons/settings.svg?url'
import svgIcon from 'material-icon-theme/icons/svg.svg?url'
import tableIcon from 'material-icon-theme/icons/table.svg?url'
import typescriptIcon from 'material-icon-theme/icons/typescript.svg?url'
import videoIcon from 'material-icon-theme/icons/video.svg?url'
import viteIcon from 'material-icon-theme/icons/vite.svg?url'
import vueIcon from 'material-icon-theme/icons/vue.svg?url'
import wordIcon from 'material-icon-theme/icons/word.svg?url'
import xmlIcon from 'material-icon-theme/icons/xml.svg?url'
import yamlIcon from 'material-icon-theme/icons/yaml.svg?url'
import yarnIcon from 'material-icon-theme/icons/yarn.svg?url'
import zipIcon from 'material-icon-theme/icons/zip.svg?url'
import { computed } from 'vue'

// File Type Icons: 图标资产来自开源 material-icon-theme；此处统一处理精确文件名、
// 扩展名和语义目录映射，文件树与预览 tab 不应各自维护图标规则。
const props = withDefaults(
  defineProps<{
    name: string
    isDirectory?: boolean
    expanded?: boolean
  }>(),
  {
    isDirectory: false,
    expanded: false,
  },
)

const iconUrl = computed(() => {
  if (props.isDirectory) return folderIconFor(props.name, props.expanded)
  return fileIconFor(props.name)
})

const extensionIcons: Record<string, string> = {
  '7z': zipIcon,
  avi: videoIcon,
  bash: consoleIcon,
  bmp: imageIcon,
  c: cIcon,
  cc: cppIcon,
  cjs: javascriptIcon,
  cpp: cppIcon,
  cs: csharpIcon,
  css: cssIcon,
  csv: tableIcon,
  doc: wordIcon,
  docx: wordIcon,
  gif: imageIcon,
  go: goIcon,
  gz: zipIcon,
  h: cIcon,
  hpp: cppIcon,
  htm: htmlIcon,
  html: htmlIcon,
  ico: imageIcon,
  java: javaIcon,
  jpeg: imageIcon,
  jpg: imageIcon,
  js: javascriptIcon,
  json: jsonIcon,
  jsonc: jsonIcon,
  jsx: reactIcon,
  lock: lockIcon,
  log: logIcon,
  m4a: audioIcon,
  markdown: markdownIcon,
  md: markdownIcon,
  mdx: markdownIcon,
  mjs: javascriptIcon,
  mkv: videoIcon,
  mov: videoIcon,
  mp3: audioIcon,
  mp4: videoIcon,
  odp: powerpointIcon,
  ods: tableIcon,
  odt: wordIcon,
  pdf: pdfIcon,
  php: phpIcon,
  png: imageIcon,
  ppt: powerpointIcon,
  pptx: powerpointIcon,
  py: pythonIcon,
  rb: rubyIcon,
  rs: rustIcon,
  scss: cssIcon,
  sh: consoleIcon,
  sql: databaseIcon,
  svg: svgIcon,
  tar: zipIcon,
  toml: settingsIcon,
  ts: typescriptIcon,
  tsx: reactTsIcon,
  tsv: tableIcon,
  vue: vueIcon,
  wav: audioIcon,
  webm: videoIcon,
  webp: imageIcon,
  xls: tableIcon,
  xlsx: tableIcon,
  xml: xmlIcon,
  yaml: yamlIcon,
  yml: yamlIcon,
  zip: zipIcon,
  zsh: consoleIcon,
}

const exactFileIcons: Record<string, string> = {
  '.dockerignore': dockerIcon,
  '.gitignore': gitIcon,
  '.npmrc': npmIcon,
  '.yarnrc': yarnIcon,
  'docker-compose.yml': dockerIcon,
  'docker-compose.yaml': dockerIcon,
  dockerfile: dockerIcon,
  'package-lock.json': npmIcon,
  'package.json': npmIcon,
  'pnpm-lock.yaml': pnpmIcon,
  'pnpm-workspace.yaml': pnpmIcon,
  'vite.config.js': viteIcon,
  'vite.config.ts': viteIcon,
  'yarn.lock': yarnIcon,
}

function fileIconFor(name: string): string {
  const lower = name.toLowerCase()
  if (exactFileIcons[lower]) return exactFileIcons[lower]!
  if (/^readme(?:\.|$)/i.test(name)) return readmeIcon
  if (/^(license|licence)(?:\.|$)/i.test(name)) return licenseIcon
  const extension = lower.includes('.') ? lower.split('.').pop()! : ''
  return extensionIcons[extension] ?? documentIcon ?? fileIcon
}

function folderIconFor(name: string, expanded: boolean): string {
  const lower = name.toLowerCase()
  const pair = folderPair(lower)
  return expanded ? pair[1] : pair[0]
}

function folderPair(name: string): readonly [string, string] {
  if (['src', 'source', 'sources'].includes(name)) return [folderSrcIcon, folderSrcOpenIcon]
  if (['test', 'tests', '__tests__', 'spec', 'specs'].includes(name)) {
    return [folderTestIcon, folderTestOpenIcon]
  }
  if (['component', 'components'].includes(name)) {
    return [folderComponentsIcon, folderComponentsOpenIcon]
  }
  if (['app', 'apps'].includes(name)) return [folderAppIcon, folderAppOpenIcon]
  if (['doc', 'docs', 'documentation'].includes(name)) return [folderDocsIcon, folderDocsOpenIcon]
  if (['asset', 'assets', 'image', 'images', 'img'].includes(name)) {
    return [folderImagesIcon, folderImagesOpenIcon]
  }
  if (['public', 'static'].includes(name)) return [folderPublicIcon, folderPublicOpenIcon]
  if (['config', 'configs', '.config'].includes(name))
    return [folderConfigIcon, folderConfigOpenIcon]
  if (name === '.github') return [folderGithubIcon, folderGithubOpenIcon]
  if (name === '.vscode') return [folderVscodeIcon, folderVscodeOpenIcon]
  if (name === '.git') return [folderGitIcon, folderGitOpenIcon]
  if (name === 'node_modules') return [folderNodeIcon, folderNodeOpenIcon]
  if (['resource', 'resources'].includes(name)) {
    return [folderResourceIcon, folderResourceOpenIcon]
  }
  return [folderIcon, folderOpenIcon]
}
</script>
