import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  import.meta.dirname,
  ['lib/types/index.js'],
  {
    lib: {
      copy: [{
        from: 'src/styles/{brand-font.css,montserrat-*.woff2,Montserrat-OFL.txt,mashanzheng-subset.woff2,MaShanZheng-OFL.txt}',
        to: 'lib/styles',
      }],
    },
  },
)
