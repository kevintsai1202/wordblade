// 把 3D 測試插件連同 three.js 打包成單一 IIFE（dist/three-box.js）。
// 打包在本機完成，沙盒執行時不會從網路載入任何東西（spec §5.7）。
import { build } from 'esbuild';

await build({
  entryPoints: ['plugins/three-box.src.js'],
  outfile: 'dist/three-box.js',
  bundle: true,
  format: 'iife',
  minify: true,
  legalComments: 'none',
});
console.log('built dist/three-box.js');
