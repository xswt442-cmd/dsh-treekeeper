// 本仓库发布的双语文档配对，以及每对文档的比较方式。
// `dsh-plugin-docs` 读取这个文件，自己不指定任何文档；因此移动一对文档或新增
// 一对，只需要改这里。
export const pairs = [
  { name: 'README', zh: 'README.md', en: 'README.en.md' },
  { name: 'CHANGELOG', zh: 'docs/CHANGELOG.md', en: 'docs/CHANGELOG.en.md', shape: 'changelog' },
]
