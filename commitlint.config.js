export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', [
      'feat',
      'fix', 
      'docs',
      'chore',
      'refactor',
      'perf',
      'test',
    ]],
    'subject-min-length': [2, 'always', 10],
  },
};