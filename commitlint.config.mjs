// Conventional Commits: <type>(<scope>): <subject>
// Scopes are module or area names. Add a new scope here when a new module appears.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'api',
        'worker',
        'web',
        'shared',
        'platform',
        'jobs',
        'db',
        'infra',
        'ci',
        'docs',
        'adr',
        'deps',
        'auth',
        'catalog',
        'booking',
        'payment',
        'ticket',
        'admin',
        'notification',
        'rate-limit',
      ],
    ],
  },
};
