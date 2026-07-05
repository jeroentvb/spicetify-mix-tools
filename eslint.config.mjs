import config from '@jeroentvb/eslint-config-typescript';

// The shared config may export either a flat-config array or a single object.
const base = Array.isArray(config) ? config : [config];

export default [
   // dist = build output; src/types = vendored ambient declarations (spicetify.d.ts etc.)
   { ignores: ['dist/', 'node_modules/', 'src/types/'] },
   ...base,
   {
      languageOptions: {
         globals: { Spicetify: 'readonly' },
      },
   },
];
