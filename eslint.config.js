const globals = require('globals');

const commonRules = {
  'constructor-super': 'error',
  'for-direction': 'error',
  'getter-return': 'error',
  'no-class-assign': 'error',
  'no-constant-binary-expression': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-else-if': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-obj-calls': 'error',
  'no-async-promise-executor': 'error',
  'no-self-assign': 'error',
  'no-setter-return': 'error',
  'no-unreachable': 'error',
  'no-unreachable-loop': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-undef': 'error',
  'valid-typeof': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }]
};

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/data/**',
      '.claude/**',
      '.codex/**',
      '**/NapCat.Shell (2)/**',
      '**/*.chunk.js'
    ]
  },
  {
    files: ['index.js', '{api,config,core,scripts,src,utils,web}/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node
    },
    rules: {
      ...commonRules,
      'no-unused-vars': 'off'
    }
  },
  {
    files: [
      'eslint.config.js',
      'web/auth.js',
      'web/securityHeaders.js',
      'web/sessionManager.js',
      'utils/networkSafety.js',
      'utils/requestTrace.js',
      'utils/securityDiagnostics.js',
      'utils/toolPolicy/skillArgs.js',
      'api/runtimeV2/contracts.js',
      'api/runtimeV2/state.js',
      'api/runtimeV2/host/routePredicates.js'
    ],
    rules: {
      'no-unused-vars': ['error', {
        args: 'after-used',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_'
      }]
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node
    },
    rules: {
      ...commonRules,
      'no-unused-vars': 'off'
    }
  }
];
