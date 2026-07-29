/**
 * 主进程侧的构建期资源类型声明。
 *
 * `?raw` 是 Vite 的内联导入：文件内容在构建时变成 JS 字符串常量。
 * 主进程这么用是为了让 schema.sql 之类的资源随 bundle 一起进 asar，
 * 而不是运行时按路径读盘——打包后 out/main/ 只会有 index.js，
 * 任何 `readFileSync(join(__dirname, '*.sql'))` 都必然 ENOENT。
 */
declare module '*.sql?raw' {
  const content: string
  export default content
}
