import {build} from 'esbuild';
await Promise.all([
  build({entryPoints:['src/app.js'],bundle:true,minify:true,format:'esm',outfile:'dist/app.js',target:'es2022'}),
  build({entryPoints:['src/server/index.js'],bundle:true,minify:true,platform:'node',format:'esm',outfile:'runtime/server.mjs',target:'node22'})
]);
console.log('Built CodeStory browser app and local runtime.');
